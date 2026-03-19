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

let markerLayer  = null;
let parcelLayer  = null;

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

// ── Address selection ───────────────────────────────────────────────────────
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

    const [percelData, wozData, hpData, monData] = await Promise.all([
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
    ]);

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

    renderInfoPanel(addr, percelData.perceel, wozData.woz, hpData, monData.monumenten ?? []);
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
function renderInfoPanel(addr, perceel, woz, hp, monumenten) {
  const content = document.getElementById('info-content');
  content.innerHTML = '';

  // Adreskaart
  content.appendChild(
    card('📍 Adres', [
      ['Adres',      addr.weergavenaam],
      ['Postcode',   addr.postcode],
      ['Woonplaats', addr.woonplaats],
    ])
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

  // Huispedia
  content.appendChild(huispediaCard(hp));

  // Externe links
  content.appendChild(linksCard(addr, hp));

  showState('placeholder');                   // verbergt de states
  document.getElementById('state-placeholder').classList.add('hidden');
  content.classList.remove('hidden');
}

// ── Card builder ────────────────────────────────────────────────────────────
function card(title, rows) {
  const el  = document.createElement('div');
  el.className = 'info-card';

  const h2  = document.createElement('h2');
  h2.textContent = title;
  el.appendChild(h2);

  const table = document.createElement('table');
  table.className = 'data-table';

  rows.forEach(([label, value]) => {
    if (value === null || value === undefined || value === '') return;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="lbl">${label}</td><td class="val">${value}</td>`;
    table.appendChild(tr);
  });

  el.appendChild(table);
  return el;
}

// ── WOZ card ────────────────────────────────────────────────────────────────
function wozCard(woz) {
  const el = document.createElement('div');
  el.className = 'info-card';

  const h2 = document.createElement('h2');
  h2.textContent = '💰 WOZ-waarden';
  el.appendChild(h2);

  if (!woz) {
    const p = document.createElement('p');
    p.className   = 'no-data';
    p.textContent = 'WOZ-waarden niet beschikbaar via open data.';
    el.appendChild(p);
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
    el.appendChild(p);
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
  el.appendChild(table);

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
    el.appendChild(details);
  }

  return el;
}

// ── Links card ───────────────────────────────────────────────────────────────
// ── Monument card ────────────────────────────────────────────────────────────
function monumentCard(monumenten) {
  const el = document.createElement('div');
  el.className = 'info-card';

  const h2 = document.createElement('h2');
  h2.textContent = '🏛️ Monumentale status';
  el.appendChild(h2);

  if (!monumenten.length) {
    const row = document.createElement('div');
    row.className = 'monument-none';
    row.innerHTML = '<span class="badge badge--none">Geen monument</span> Geen monumentale status gevonden.';
    el.appendChild(row);
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
    el.appendChild(block);
  });

  return el;
}

// ── Huispedia card ───────────────────────────────────────────────────────────
function huispediaCard(hp) {
  const el = document.createElement('div');
  el.className = 'info-card';

  const h2 = document.createElement('h2');
  h2.textContent = '🏡 Huispedia';
  el.appendChild(h2);

  if (!hp || (!hp.data && !hp.url)) {
    const p = document.createElement('p');
    p.className = 'no-data';
    p.textContent = 'Geen Huispedia-gegevens beschikbaar.';
    el.appendChild(p);
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
    el.appendChild(table);
  } else if (hp.fout) {
    const p = document.createElement('p');
    p.className = 'no-data';
    p.textContent = `Niet beschikbaar (${hp.fout}).`;
    el.appendChild(p);
  }

  if (hp.url) {
    const a = document.createElement('a');
    a.href = hp.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'hp-link';
    a.textContent = '↗ Bekijk op Huispedia';
    el.appendChild(a);
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

function linksCard(addr, hp) {
  const el = document.createElement('div');
  el.className = 'info-card';

  const h2 = document.createElement('h2');
  h2.textContent = '🔗 Externe bronnen';
  el.appendChild(h2);

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
  el.appendChild(ul);
  return el;
}

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
