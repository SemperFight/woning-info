// ── Map setup ──────────────────────────────────────────────────────────────
const ZWOLLE = [52.5159, 6.0836];

const map = L.map('map', { zoomControl: true }).setView(ZWOLLE, 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 20,
}).addTo(map);

const kkLayer = L.tileLayer.wms(
  'https://service.pdok.nl/kadaster/kadastralekaart/wms/v5_0',
  {
    layers:      'Perceel,OpenbareRuimteLabel',
    format:      'image/png',
    transparent: true,
    opacity:     0.65,
    attribution: '© <a href="https://www.kadaster.nl">Kadaster</a>',
  }
).addTo(map);

// Toggle kadastrale kaart overlay
document.getElementById('kk-toggle').addEventListener('change', (e) => {
  if (e.target.checked) map.addLayer(kkLayer);
  else map.removeLayer(kkLayer);
});

let markerLayer         = null;
let parcelLayer         = null;
let laadpaalLayer       = null;
let kadastraleGrenzenLayer = null;
let grenzenEnabled      = false;

// ── Kadastrale grenzen (WFS vectorlaag) ─────────────────────────────────────
const PDOK_KK_WFS_URL = 'https://service.pdok.nl/kadaster/kadastralekaart/wfs/v5_0';
const GRENZEN_MIN_ZOOM = 15;

document.getElementById('grenzen-toggle').addEventListener('change', (e) => {
  grenzenEnabled = e.target.checked;
  if (grenzenEnabled) {
    updateKadastraleGrenzen();
  } else {
    if (kadastraleGrenzenLayer) { map.removeLayer(kadastraleGrenzenLayer); kadastraleGrenzenLayer = null; }
    document.getElementById('grenzen-zoom-hint').classList.add('hidden');
  }
});

map.on('moveend', () => {
  if (grenzenEnabled) updateKadastraleGrenzen();
});

async function updateKadastraleGrenzen() {
  const hint = document.getElementById('grenzen-zoom-hint');
  if (map.getZoom() < GRENZEN_MIN_ZOOM) {
    if (kadastraleGrenzenLayer) { map.removeLayer(kadastraleGrenzenLayer); kadastraleGrenzenLayer = null; }
    hint.classList.remove('hidden');
    return;
  }
  hint.classList.add('hidden');

  const b = map.getBounds();
  // WFS 2.0 + EPSG:4326 verwacht bbox in lat/lon volgorde (south,west,north,east)
  const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()},EPSG:4326`;

  const params = new URLSearchParams({
    service:      'WFS',
    version:      '2.0.0',
    request:      'GetFeature',
    typeNames:    'kadastralekaart:Perceel',
    outputFormat: 'application/json',
    srsName:      'EPSG:4326',
    bbox,
    count:        '500',
  });

  try {
    const r = await fetch(`${PDOK_KK_WFS_URL}?${params}`);
    if (!r.ok) return;
    const geojson = await r.json();

    if (kadastraleGrenzenLayer) map.removeLayer(kadastraleGrenzenLayer);
    kadastraleGrenzenLayer = L.geoJSON(geojson, {
      style: {
        color:       '#c0392b',
        weight:      1.5,
        opacity:     0.9,
        fill:        false,
      },
    }).addTo(map);
  } catch {
    // Stil falen
  }
}

const laadpaalIcon = L.divIcon({
  className: '',
  html: '<div class="lp-icon">⚡</div>',
  iconSize:   [28, 28],
  iconAnchor: [14, 14],
  popupAnchor:[0, -16],
});

// ── Search / autocomplete ───────────────────────────────────────────────────
const searchInput   = document.getElementById('search-input');
const suggestionsEl = document.getElementById('suggestions');
let debounceTimer   = null;

searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { hideSuggestions(); return; }
  debounceTimer = setTimeout(() => fetchSuggestions(q), 280);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideSuggestions();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-container')) hideSuggestions();
});

async function fetchSuggestions(q) {
  try {
    const r    = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`);
    const data = await r.json();
    renderSuggestions(data);
  } catch {
    hideSuggestions();
  }
}

function renderSuggestions(items) {
  suggestionsEl.innerHTML = '';
  if (!items.length) { hideSuggestions(); return; }
  items.forEach((item) => {
    const div      = document.createElement('div');
    div.className  = 'suggestion-item';
    div.textContent = item.label;
    div.addEventListener('click', () => selectAddress(item));
    suggestionsEl.appendChild(div);
  });
  suggestionsEl.classList.remove('hidden');
}

function hideSuggestions() {
  suggestionsEl.classList.add('hidden');
  suggestionsEl.innerHTML = '';
}

// ── Recent addresses ────────────────────────────────────────────────────────
const RECENT_KEY = 'woning_recent';

function saveRecent(item) {
  const list = getRecent().filter((r) => r.id !== item.id);
  list.unshift({ id: item.id, label: item.label });
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 3)));
  renderRecent();
}

function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}

function renderRecent() {
  const list = getRecent();
  const container = document.getElementById('recent-list');
  if (!container) return;
  container.innerHTML = '';
  if (!list.length) return;
  document.getElementById('recent-header').classList.remove('hidden');
  list.forEach((item) => {
    const btn = document.createElement('button');
    btn.className = 'recent-item';
    btn.textContent = item.label;
    btn.addEventListener('click', () => selectAddress(item));
    container.appendChild(btn);
  });
}

// ── Address selection ────────────────────────────────────────────────────────
async function selectAddress(item) {
  searchInput.value = item.label;
  hideSuggestions();
  showState('loading');

  try {
    const addr = await fetch(`/api/lookup?id=${encodeURIComponent(item.id)}`).then((r) => r.json());

    if (!addr.lat || !addr.lng) {
      showError('Geen coördinaten gevonden voor dit adres.');
      return;
    }

    saveRecent(item);

    // Map: marker
    if (markerLayer) map.removeLayer(markerLayer);
    markerLayer = L.marker([addr.lat, addr.lng])
      .addTo(map)
      .bindPopup(`<strong>${addr.weergavenaam}</strong>`)
      .openPopup();
    map.setView([addr.lat, addr.lng], 18);

    // Fetch parcel + WOZ + Huispedia in parallel
    const hpParams = addr.straat && addr.huisnummer && addr.woonplaats && addr.postcode
      ? `straat=${encodeURIComponent(addr.straat)}&huisnummer=${encodeURIComponent(addr.huisnummer)}&woonplaats=${encodeURIComponent(addr.woonplaats)}&postcode=${encodeURIComponent(addr.postcode)}`
      : null;

    const gpRaw = addr.gekoppeld_perceel;
    const gpValue = Array.isArray(gpRaw) ? gpRaw[0] : gpRaw;
    const percelParams = new URLSearchParams({ rd_x: addr.rd_x, rd_y: addr.rd_y });
    if (gpValue) percelParams.set('gekoppeld_perceel', gpValue);

    const [percelData, wozData, hpData, monData, internetData, laadpalenData, energielabelData] = await Promise.all([
      fetch(`/api/perceel?${percelParams}`).then((r) => r.json()).catch(() => ({ perceel: null })),
      fetch(`/api/woz?${new URLSearchParams({
          ...(addr.nummeraanduiding_id && { nummeraanduiding_id: addr.nummeraanduiding_id }),
          ...(addr.postcode            && { postcode:            addr.postcode }),
          ...(addr.huisnummer          && { huisnummer:          addr.huisnummer }),
        })}`)
        .then((r) => r.json())
        .catch(() => ({ woz: null })),
      hpParams
        ? fetch(`/api/huispedia?${hpParams}`)
            .then((r) => r.json())
            .catch(() => ({ data: null, url: null, fout: 'netwerkfout' }))
        : Promise.resolve({ data: null, url: null, fout: null }),
      addr.rd_x && addr.rd_y
        ? fetch(`/api/monument?rd_x=${addr.rd_x}&rd_y=${addr.rd_y}`)
            .then((r) => r.json())
            .catch(() => ({ monumenten: [] }))
        : Promise.resolve({ monumenten: [] }),
      addr.postcode && addr.huisnummer
        ? fetch(`/api/internet?${new URLSearchParams({ postcode: addr.postcode, huisnummer: addr.huisnummer })}`)
            .then((r) => r.json())
            .catch(() => ({ data: null, url: null, fout: 'netwerkfout' }))
        : Promise.resolve({ data: null, url: null, fout: null }),
      addr.lat && addr.lng
        ? fetch(`/api/laadpalen?lat=${addr.lat}&lng=${addr.lng}`)
            .then((r) => r.json())
            .catch(() => ({ laadpalen: [], dichtsbijzijnde_m: null }))
        : Promise.resolve({ laadpalen: [], dichtsbijzijnde_m: null }),
      addr.verblijfsobject_id
        ? fetch(`/api/energielabel?verblijfsobject_id=${encodeURIComponent(addr.verblijfsobject_id)}`)
            .then((r) => r.json())
            .catch(() => ({ label: null, fout: 'netwerkfout' }))
        : Promise.resolve({ label: null, fout: null }),
    ]);

    // Map: laadpaal markers (drie dichtstbijzijnde)
    if (laadpaalLayer) { map.removeLayer(laadpaalLayer); laadpaalLayer = null; }
    const topDrie = (laadpalenData?.laadpalen ?? []).slice(0, 3).filter((lp) => lp.lat && lp.lng);
    if (topDrie.length) {
      laadpaalLayer = L.layerGroup();
      topDrie.forEach((lp) => {
        const popupLines = (lp.connectoren || [])
          .map((c) => `${c.type}${c.vermogen_kw ? ` ${c.vermogen_kw} kW` : ''} — ${c.beschikbaar}/${c.totaal} vrij`)
          .join('<br>');
        L.marker([lp.lat, lp.lng], { icon: laadpaalIcon })
          .bindPopup(`<strong>${lp.straat ?? 'Laadpaal'}</strong><br>${lp.eigenaar ?? ''}<br>${popupLines}`)
          .addTo(laadpaalLayer);
      });
      laadpaalLayer.addTo(map);
    }

    // Map: parcel polygon
    if (parcelLayer) map.removeLayer(parcelLayer);
    if (percelData.perceel?.geometry) {
      parcelLayer = L.geoJSON(percelData.perceel.geometry, {
        style: {
          color:       '#e63946',
          weight:      2.5,
          fillColor:   '#e63946',
          fillOpacity: 0.18,
        },
      }).addTo(map);
    }

    renderInfoPanel(addr, percelData.perceel, wozData.woz, hpData, monData.monumenten ?? [], internetData, laadpalenData, energielabelData);
  } catch (err) {
    showError('Er is een fout opgetreden. Probeer het opnieuw.');
    console.error(err);
  }
}

// ── State helpers ───────────────────────────────────────────────────────────
function showState(state) {
  ['placeholder', 'loading', 'error'].forEach((s) =>
    document.getElementById(`state-${s}`).classList.add('hidden')
  );
  document.getElementById('info-content').classList.add('hidden');
  document.getElementById(`state-${state}`).classList.remove('hidden');
}

function showError(msg) {
  const el   = document.getElementById('state-error');
  el.textContent = msg;
  showState('error');
}

// ── Info panel renderer ─────────────────────────────────────────────────────
function renderInfoPanel(addr, perceel, woz, hp, monumenten, internet, laadpalen, energielabel) {
  const content = document.getElementById('info-content');
  content.innerHTML = '';

  // Adreskaart
  content.appendChild(
    card('📍 Adres', [
      ['Adres',      addr.weergavenaam],
      ['Postcode',   addr.postcode],
      ['Woonplaats', addr.woonplaats],
    ], true)
  );

  // BAG gebouwgegevens
  const gebruiksdoel = Array.isArray(addr.gebruiksdoel)
    ? addr.gebruiksdoel.join(', ')
    : addr.gebruiksdoel;

  content.appendChild(
    card('🏗️ Gebouwgegevens (BAG)', [
      ['Bouwjaar',         addr.bouwjaar],
      ['Woonoppervlakte',  addr.oppervlakte ? `${addr.oppervlakte} m²` : null],
      ['Gebruiksdoel',     gebruiksdoel],
      ['BAG object-ID',    addr.verblijfsobject_id],
    ])
  );

  // Energielabel
  content.appendChild(energielabelCard(energielabel));

  // Kadastraal perceel
  if (perceel) {
    const aanduiding =
      perceel.kadastralegemeente && perceel.sectie && perceel.perceelnummer
        ? `${perceel.kadastralegemeente} ${perceel.sectie} ${perceel.perceelnummer}`
        : null;

    content.appendChild(
      card('🗺️ Kadastrale gegevens', [
        ['Kadastrale gemeente', perceel.kadastralegemeente],
        ['Sectie',              perceel.sectie],
        ['Perceelnummer',       perceel.perceelnummer],
        ['Kadastrale grootte',  perceel.oppervlakte_m2 ? `${perceel.oppervlakte_m2} m²` : null],
        ['Aanduiding',          aanduiding],
      ])
    );
  } else {
    content.appendChild(
      card('🗺️ Kadastrale gegevens', [['Status', 'Geen perceel gevonden op dit punt']])
    );
  }

  // WOZ waarden
  content.appendChild(wozCard(woz));

  // Monumentale status
  content.appendChild(monumentCard(monumenten));

  // Internetbeschikbaarheid
  content.appendChild(internetCard(internet));

  // Laadpalen
  content.appendChild(laadpalenCard(laadpalen));

  // Huispedia
  content.appendChild(huispediaCard(hp));

  // Externe links
  content.appendChild(linksCard(addr, hp));

  showState('placeholder');                   // verbergt de states
  document.getElementById('state-placeholder').classList.add('hidden');
  content.classList.remove('hidden');
}

// ── Card builder ────────────────────────────────────────────────────────────
function makeCardShell(title, open = false) {
  const el = document.createElement('div');
  el.className = 'info-card';
  if (!open) el.classList.add('collapsed');

  const h2 = document.createElement('h2');
  const toggle = document.createElement('span');
  toggle.className = 'card-toggle';
  toggle.textContent = '▾';
  h2.appendChild(toggle);
  h2.appendChild(document.createTextNode(' ' + title));
  h2.addEventListener('click', () => el.classList.toggle('collapsed'));
  el.appendChild(h2);

  const body = document.createElement('div');
  body.className = 'card-body';
  el.appendChild(body);

  return { el, body };
}

function card(title, rows, open = false) {
  const { el, body } = makeCardShell(title, open);

  const table = document.createElement('table');
  table.className = 'data-table';

  rows.forEach(([label, value]) => {
    if (value === null || value === undefined || value === '') return;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="lbl">${label}</td><td class="val">${value}</td>`;
    table.appendChild(tr);
  });

  body.appendChild(table);
  return el;
}

// ── WOZ card ────────────────────────────────────────────────────────────────
function wozCard(woz) {
  const { el, body } = makeCardShell('💰 WOZ-waarden');

  if (!woz) {
    const p = document.createElement('p');
    p.className   = 'no-data';
    p.textContent = 'WOZ-waarden niet beschikbaar via open data.';
    body.appendChild(p);
    return el;
  }

  // Normaliseer verschillende responsformaten
  let waarden = [];
  if (Array.isArray(woz))         waarden = woz;
  else if (woz.wozWaarden)        waarden = woz.wozWaarden;
  else if (Array.isArray(woz.waarden)) waarden = woz.waarden;

  if (!waarden.length) {
    const p = document.createElement('p');
    p.className   = 'no-data';
    p.textContent = 'Geen WOZ-waarden in de databron gevonden.';
    body.appendChild(p);
    return el;
  }

  const sorted = [...waarden].sort((a, b) => {
    const da = a.peildatum || a.vastgesteldePeildatum || '';
    const db = b.peildatum || b.vastgesteldePeildatum || '';
    return db.localeCompare(da);
  });

  const makeRow = (w) => {
    const peildatum = w.peildatum || w.vastgesteldePeildatum || '?';
    const waarde    = w.vastgesteldeWaarde ?? w.waarde ?? w.wozWaarde;
    const tr        = document.createElement('tr');
    tr.innerHTML    = `
      <td>${formatDate(peildatum)}</td>
      <td class="woz-val">${waarde != null ? formatEuro(waarde) : '?'}</td>
    `;
    return tr;
  };

  // Meest recente waarde altijd zichtbaar
  const latest = sorted[0];
  const rest   = sorted.slice(1);

  const table = document.createElement('table');
  table.className = 'woz-table';
  const tbody = document.createElement('tbody');
  tbody.appendChild(makeRow(latest));
  table.appendChild(tbody);
  body.appendChild(table);

  // Oudere waarden in uitklapbaar blok
  if (rest.length) {
    const details = document.createElement('details');
    details.className = 'woz-details';

    const summary = document.createElement('summary');
    summary.textContent = `Eerdere waarden (${rest.length})`;
    details.appendChild(summary);

    const oldTable = document.createElement('table');
    oldTable.className = 'woz-table woz-table--old';
    const oldTbody = document.createElement('tbody');
    rest.forEach((w) => oldTbody.appendChild(makeRow(w)));
    oldTable.appendChild(oldTbody);
    details.appendChild(oldTable);
    body.appendChild(details);
  }

  return el;
}

// ── Links card ───────────────────────────────────────────────────────────────
// ── Monument card ────────────────────────────────────────────────────────────
function monumentCard(monumenten) {
  const { el, body } = makeCardShell('🏛️ Monumentale status');

  if (!monumenten.length) {
    const row = document.createElement('div');
    row.className = 'monument-none';
    row.innerHTML = '<span class="badge badge--none">Geen monument</span> Geen monumentale status gevonden.';
    body.appendChild(row);
    return el;
  }

  monumenten.forEach((m) => {
    const block = document.createElement('div');
    block.className = 'monument-item';

    const badgeClass = m.soort === 'Rijksmonument' ? 'badge--rijk' : 'badge--gemeente';
    block.innerHTML = `<span class="badge ${badgeClass}">${m.soort}</span>`;

    const table = document.createElement('table');
    table.className = 'data-table';
    [
      ['Code',          m.code],
      ['Omschrijving',  m.omschrijving],
      ['Bouwjaar',      m.bouwjaar],
      ['Bouwstijl',     m.bouwstijl],
      ['Datum besluit', m.datum_besluit],
    ].forEach(([label, value]) => {
      if (!value) return;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="lbl">${label}</td><td class="val">${value}</td>`;
      table.appendChild(tr);
    });
    block.appendChild(table);
    body.appendChild(block);
  });

  return el;
}

// ── Energielabel card ────────────────────────────────────────────────────────
const LABEL_KLEUR = {
  'A++++': '#1a7f37', 'A+++': '#1a7f37', 'A++': '#1a7f37', 'A+': '#2ea44f',
  A: '#3fb950', B: '#7ec867', C: '#d4a017', D: '#e3b341',
  E: '#e06c00', F: '#d04a02', G: '#b22222',
};

function energielabelCard(data) {
  const { el, body } = makeCardShell('🏷️ Energielabel');

  if (data?.fout) {
    const p = document.createElement('p');
    p.className = 'no-data';
    p.textContent = `Energielabel niet opgehaald (${data.fout}).`;
    body.appendChild(p);
    return el;
  }

  if (!data.label) {
    const p = document.createElement('p');
    p.className = 'no-data';
    p.textContent = 'Geen geregistreerd energielabel gevonden.';
    body.appendChild(p);
    return el;
  }

  const { energieklasse, energieindex, registratiedatum, geldig_tot, labeltype } = data.label;

  if (energieklasse) {
    const badge = document.createElement('span');
    badge.className = 'energielabel-badge';
    badge.textContent = energieklasse;
    badge.style.backgroundColor = LABEL_KLEUR[energieklasse] ?? '#555';
    body.appendChild(badge);
  }

  const table = document.createElement('table');
  table.className = 'data-table';
  [
    ['Energieklasse',    energieklasse],
    ['Energieindex',     energieindex],
    ['Type label',       labeltype],
    ['Registratiedatum', registratiedatum ? formatDate(registratiedatum) : null],
    ['Geldig tot',       geldig_tot       ? formatDate(geldig_tot)       : null],
  ].forEach(([label, value]) => {
    if (!value) return;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="lbl">${label}</td><td class="val">${value}</td>`;
    table.appendChild(tr);
  });
  body.appendChild(table);

  return el;
}

// ── Huispedia card ───────────────────────────────────────────────────────────
function huispediaCard(hp) {
  const { el, body } = makeCardShell('🏡 Huispedia');

  if (!hp || (!hp.data && !hp.url)) {
    const p = document.createElement('p');
    p.className = 'no-data';
    p.textContent = 'Geen Huispedia-gegevens beschikbaar.';
    body.appendChild(p);
    return el;
  }

  const d = hp.data || {};

  // Gestructureerde JSON-LD data (meest betrouwbaar)
  const ld = d.json_ld || {};

  // Next.js page data — zoek diep naar waarden
  const nd = d.next_data ? extractNextData(d.next_data) : {};

  const rows = [
    ['Geschatte waarde',  nd.geschatteWaarde  || ld.price || d.geschatte_waarde_tekst  ? formatHpValue(nd.geschatteWaarde || ld.price || d.geschatte_waarde_tekst) : null],
    ['Laatste verkoop',   nd.laasteVerkoop    || d.laatste_verkoop_tekst ? formatHpValue(nd.laasteVerkoop || d.laatste_verkoop_tekst) : null],
    ['Energielabel',      nd.energielabel     || ld.energyEfficiencyScaleMin || d.energielabel],
    ['Bouwjaar (HP)',     nd.bouwjaar         || d.bouwjaar_hp],
  ].filter(([, v]) => v);

  if (rows.length) {
    const table = document.createElement('table');
    table.className = 'data-table';
    rows.forEach(([label, value]) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="lbl">${label}</td><td class="val">${value}</td>`;
      table.appendChild(tr);
    });
    body.appendChild(table);
  } else if (hp.fout) {
    const p = document.createElement('p');
    p.className = 'no-data';
    p.textContent = `Niet beschikbaar (${hp.fout}).`;
    body.appendChild(p);
  }

  if (hp.url) {
    const a = document.createElement('a');
    a.href = hp.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'hp-link';
    a.textContent = '↗ Bekijk op Huispedia';
    body.appendChild(a);
  }

  return el;
}

function extractNextData(nd) {
  // Zoek recursief naar bekende velden in Next.js __NEXT_DATA__
  const result = {};
  const str = JSON.stringify(nd);

  const match = (key, regex) => {
    const m = str.match(regex);
    if (m) result[key] = m[1];
  };

  match('geschatteWaarde', /"(?:estimatedValue|geschatteWaarde|woningwaarde)":\s*"?(\d[\d.,]*)"/);
  match('laasteVerkoop',   /"(?:lastSalePrice|laasteVerkoop|verkoopprijs)":\s*"?(\d[\d.,]*)"/);
  match('energielabel',    /"(?:energyLabel|energielabel)":\s*"([A-G][+]{0,3})"/i);
  match('bouwjaar',        /"(?:buildYear|bouwjaar)":\s*"?(\d{4})"/);

  return result;
}

function formatHpValue(val) {
  if (!val) return null;
  const num = parseFloat(String(val).replace(/[^\d]/g, ''));
  if (!isNaN(num) && num > 10000) return formatEuro(num);
  return String(val);
}

// ── Internet card ─────────────────────────────────────────────────────────────
function internetCard(internet) {
  const { el, body } = makeCardShell('🌐 Internetbeschikbaarheid');

  const d = internet?.data;

  if (!d) {
    if (internet?.url) {
      const a = document.createElement('a');
      a.href = internet.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'hp-link';
      a.textContent = '↗ Bekijk op Providers.nl';
      body.appendChild(a);
    }
    return el;
  }

  const types = [
    { key: 'glasvezel', label: 'Glasvezel', speedKey: 'glasvezel_mbps' },
    { key: 'kabel',     label: 'Kabel',     speedKey: 'kabel_mbps'     },
    { key: 'adsl',      label: 'ADSL/VDSL', speedKey: 'adsl_mbps'      },
  ];

  const rows = document.createElement('div');
  rows.className = 'internet-rows';

  types.forEach(({ key, label, speedKey }) => {
    if (d[key] === undefined) return;
    const row = document.createElement('div');
    row.className = 'internet-row';

    const icon = d[key] ? '✓' : '✗';
    const iconClass = d[key] ? 'inet-yes' : 'inet-no';
    const speed = d[speedKey] ? ` <span class="inet-speed">${d[speedKey]} Mb/s</span>` : '';

    row.innerHTML = `<span class="${iconClass}">${icon}</span> <span class="inet-label">${label}</span>${speed}`;
    rows.appendChild(row);
  });

  body.appendChild(rows);

  if (internet?.url) {
    const a = document.createElement('a');
    a.href = internet.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'hp-link';
    a.textContent = '↗ Bekijk op Providers.nl';
    body.appendChild(a);
  }

  return el;
}

// ── Laadpaaloperator tarieven (indicatief, pay-per-charge zonder laadpas) ────
const OPERATOR_TARIEVEN = [
  { match: 'allego',         label: 'Allego',            ac: 0.47, dc: 0.69, url: 'https://allego.eu/nl-nl/particulier/laadtarieven/' },
  { match: 'vattenfall',     label: 'Vattenfall InCharge',ac: 0.49, dc: null, url: 'https://www.vattenfall.nl/energie-producten/elektrisch-rijden/laden/' },
  { match: 'incharge',       label: 'Vattenfall InCharge',ac: 0.49, dc: null, url: 'https://www.vattenfall.nl/energie-producten/elektrisch-rijden/laden/' },
  { match: 'shell',          label: 'Shell Recharge',    ac: 0.47, dc: 0.76, url: 'https://shellrecharge.com/nl-nl/solutions/drivers/tarieven' },
  { match: 'fastned',        label: 'Fastned',           ac: null, dc: 0.89, url: 'https://fastned.nl/nl/laden/tarief' },
  { match: 'ionity',         label: 'IONITY',            ac: null, dc: 0.79, url: 'https://ionity.eu/nl/charge/pricing' },
  { match: 'eneco',          label: 'Eneco',             ac: 0.44, dc: null, url: 'https://www.eneco.nl/elektrisch-rijden/laadpaal/' },
  { match: 'essent',         label: 'Essent',            ac: 0.45, dc: null, url: 'https://www.essent.nl/content/particulier/elektrisch-rijden' },
  { match: 'tesla',          label: 'Tesla Supercharger', ac: null, dc: 0.44, url: 'https://www.tesla.com/nl_NL/support/supercharging' },
  { match: 'evbox',          label: 'EVBox',             ac: null, dc: null, url: 'https://evbox.com/nl-nl/tarieven' },
  { match: 'chargepoint',    label: 'ChargePoint',       ac: null, dc: null, url: 'https://www.chargepoint.com/nl-nl' },
  { match: 'blue corner',    label: 'Blue Corner',       ac: 0.45, dc: null, url: 'https://www.bluecorner.nl/nl/tarieven' },
  { match: 'nuon',           label: 'Vattenfall InCharge',ac: 0.49, dc: null, url: 'https://www.vattenfall.nl/energie-producten/elektrisch-rijden/laden/' },
  { match: 'greenstadion',   label: 'Greenstadion',      ac: 0.40, dc: null, url: 'https://www.greenstadion.nl' },
  { match: 'last mile',      label: 'Last Mile Solutions',ac: 0.45, dc: null, url: 'https://www.lastmilesolutions.com' },
];

function operatorTarief(naam) {
  if (!naam) return null;
  const lower = naam.toLowerCase();
  return OPERATOR_TARIEVEN.find((o) => lower.includes(o.match)) ?? null;
}

// ── Laadpalen card ───────────────────────────────────────────────────────────
function laadpalenCard(data) {
  const { el, body } = makeCardShell('⚡ Laadpalen in de buurt (500 m)');

  if (!data || !data.laadpalen) {
    const p = document.createElement('p');
    p.className = 'no-data';
    p.textContent = 'Geen laadpalendata beschikbaar.';
    body.appendChild(p);
    return el;
  }

  const { laadpalen } = data;

  if (!laadpalen.length) {
    const p = document.createElement('p');
    p.className = 'no-data';
    p.textContent = 'Geen laadpalen gevonden binnen 500 m.';
    body.appendChild(p);
    return el;
  }

  const makeStation = (lp) => {
    const div = document.createElement('div');
    div.className = 'laadpaal-item';

    const header = document.createElement('div');
    header.className = 'laadpaal-header';
    header.innerHTML = `
      <span class="laadpaal-afstand">${lp.afstand_m} m</span>
      <span class="laadpaal-adres">${lp.straat ?? '—'}</span>
      <span class="laadpaal-eigenaar">${lp.eigenaar ?? ''}</span>
    `;
    div.appendChild(header);

    if (lp.connectoren && lp.connectoren.length) {
      const ul = document.createElement('ul');
      ul.className = 'laadpaal-conn-list';
      lp.connectoren.forEach((c) => {
        const li = document.createElement('li');
        const kw = c.vermogen_kw ? ` — ${c.vermogen_kw} kW` : '';
        const vrijClass = c.beschikbaar > 0 ? 'conn-vrij' : 'conn-bezet';
        li.innerHTML = `<span class="conn-type">${c.type}</span>${kw} <span class="${vrijClass}">${c.beschikbaar}/${c.totaal} vrij</span>`;
        ul.appendChild(li);
      });
      div.appendChild(ul);
    }

    // Tariefinformatie
    const tarief = operatorTarief(lp.eigenaar);
    if (tarief) {
      const tarifDiv = document.createElement('div');
      tarifDiv.className = 'laadpaal-tarief';

      const prijsDelen = [];
      if (tarief.ac != null) prijsDelen.push(`AC €${tarief.ac.toFixed(2)}/kWh`);
      if (tarief.dc != null) prijsDelen.push(`DC €${tarief.dc.toFixed(2)}/kWh`);

      const prijsTekst = prijsDelen.length
        ? `<span class="tarief-prijs">${prijsDelen.join(' · ')}</span>`
        : '<span class="tarief-onbekend">Prijs onbekend</span>';

      tarifDiv.innerHTML = `${prijsTekst} <span class="tarief-hint">(indicatief, pay-per-charge)</span>`;

      const link = document.createElement('a');
      link.href = tarief.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'tarief-link';
      link.textContent = '↗ Actuele tarieven';
      tarifDiv.appendChild(link);

      div.appendChild(tarifDiv);
    }

    return div;
  };

  // Dichtstbijzijnde altijd zichtbaar
  body.appendChild(makeStation(laadpalen[0]));

  // Overige ingeklapt
  const rest = laadpalen.slice(1);
  if (rest.length) {
    const details = document.createElement('details');
    details.className = 'woz-details';
    const summary = document.createElement('summary');
    summary.textContent = `Overige laadpalen (${rest.length})`;
    details.appendChild(summary);
    rest.forEach((lp) => details.appendChild(makeStation(lp)));
    body.appendChild(details);
  }

  return el;
}

function linksCard(addr, hp) {
  const { el, body } = makeCardShell('🔗 Externe bronnen');

  const links = [
    { label: 'WOZ Waardeloket',        url: 'https://www.woz-waardeloket.nl/' },
    { label: 'Kadaster kadastrale kaart', url: 'https://www.kadaster.nl/zakelijk/producten/eigendom/kadastrale-kaart' },
    { label: 'Monumentenregister',     url: 'https://monumentenregister.cultureelerfgoed.nl/' },
    { label: 'Gemeentelijke monumenten Zwolle', url: 'https://zwolle.maps.arcgis.com/apps/instant/sidebar/index.html?appid=7526b0fc2cc740ad956230b55f7865c7&webmap=859c786479f24fc38d44699a7ab7409e' },
    { label: 'PDOK Viewer',            url: 'https://app.pdok.nl/viewer/' },
  ];

  if (hp?.url) {
    links.unshift({ label: 'Huispedia (woningpagina)', url: hp.url });
  }

  if (addr.verblijfsobject_id) {
    links.unshift({
      label: 'BAG Viewer (object)',
      url:   `https://bagviewer.kadaster.nl/lvbag/bag-viewer/index.html#?searchQuery=${addr.verblijfsobject_id}`,
    });
  }

  const ul = document.createElement('ul');
  ul.className = 'links-list';
  links.forEach(({ label, url }) => {
    const li = document.createElement('li');
    li.innerHTML = `<a href="${url}" target="_blank" rel="noopener noreferrer">↗ ${label}</a>`;
    ul.appendChild(li);
  });
  body.appendChild(ul);
  return el;
}

// ── Home ─────────────────────────────────────────────────────────────────────
function goHome() {
  searchInput.value = '';
  hideSuggestions();
  if (markerLayer)            { map.removeLayer(markerLayer);            markerLayer            = null; }
  if (parcelLayer)            { map.removeLayer(parcelLayer);            parcelLayer            = null; }
  if (laadpaalLayer)          { map.removeLayer(laadpaalLayer);          laadpaalLayer          = null; }
  if (kadastraleGrenzenLayer) { map.removeLayer(kadastraleGrenzenLayer); kadastraleGrenzenLayer = null; }
  map.setView(ZWOLLE, 13);
  renderRecent();
  showState('placeholder');
}

document.querySelector('.logo').addEventListener('click', goHome);

// Laad recente adressen bij opstarten
renderRecent();

// ── Formatters ───────────────────────────────────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr || dateStr === '?') return dateStr;
  try {
    return new Date(dateStr).toLocaleDateString('nl-NL', {
      year: 'numeric', month: 'long', day: 'numeric',
    });
  } catch { return dateStr; }
}

function formatEuro(val) {
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
  }).format(val);
}
