from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from typing import Optional
from collections import OrderedDict
from contextlib import asynccontextmanager
import asyncio
import gzip
import math
import httpx
import re
import json
import unicodedata
from bs4 import BeautifulSoup


class _LRU:
    """Eenvoudige in-memory LRU-cache."""
    def __init__(self, maxsize: int = 3):
        self._cache: OrderedDict = OrderedDict()
        self._maxsize = maxsize

    def get(self, key):
        if key not in self._cache:
            return None
        self._cache.move_to_end(key)
        return self._cache[key]

    def set(self, key, value):
        if key in self._cache:
            self._cache.move_to_end(key)
        else:
            if len(self._cache) >= self._maxsize:
                self._cache.popitem(last=False)
        self._cache[key] = value


_cache_lookup       = _LRU()
_cache_perceel      = _LRU()
_cache_woz          = _LRU()
_cache_monument     = _LRU()
_cache_huispedia    = _LRU()
_cache_internet     = _LRU()
_cache_laadpalen    = _LRU()
_cache_energielabel = _LRU()

EP_ONLINE_SEARCH = "https://ep-online.nl/Energylabel/Search"
_EP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    "Accept":     "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "nl-NL,nl;q=0.9",
}

# ── NDW laadpalen (bulk download, heel Nederland) ────────────────────────────
NDW_GEOJSON_URL = "https://opendata.ndw.nu/charging_point_locations.geojson.gz"
_ndw_features: list = []

_CONNECTOR_LABEL: dict = {
    "IEC_62196_T2":       "Type 2",
    "IEC_62196_T2_COMBO": "CCS",
    "CHADEMO":            "CHAdeMO",
    "TESLA_S":            "Tesla",
    "IEC_62196_T1":       "Type 1",
    "IEC_62196_T1_COMBO": "CCS (Type 1)",
    "DOMESTIC_F":         "Schuko",
}


def _haversine(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Rechte-lijnafstand in meters (WGS84)."""
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


async def _ndw_load() -> None:
    global _ndw_features
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.get(NDW_GEOJSON_URL)
        r.raise_for_status()
    _ndw_features = json.loads(gzip.decompress(r.content)).get("features", [])


async def _ndw_refresh_loop() -> None:
    while True:
        try:
            await _ndw_load()
        except Exception:
            pass  # Bestaande data behouden bij mislukte refresh
        await asyncio.sleep(12 * 3600)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_ndw_refresh_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="Woning Info Zwolle", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")

PDOK_SUGGEST = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/suggest"
PDOK_LOOKUP  = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/lookup"
PDOK_KK_WFS  = "https://service.pdok.nl/kadaster/kadastralekaart/wfs/v5_0"
PDOK_WOZ_WFS = "https://service.pdok.nl/lv/woz/wfs/v2_0"
WOZ_API      = "https://api.kadaster.nl/lvwoz/wozwaardeloket-api/v1/wozwaarde/nummeraanduiding"
WOZ_HEADERS  = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    "Referer":    "https://www.woz-waardeloket.nl/",
    "Origin":     "https://www.woz-waardeloket.nl",
    "Accept":     "application/json, text/plain, */*",
}


@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.get("/favicon.ico")
async def favicon():
    return Response(status_code=204)


@app.get("/api/suggest")
async def suggest(q: str = Query(..., min_length=2)):
    params = [
        ("q", q),
        ("fq", "gemeentenaam:Zwolle"),
        ("fq", "type:adres"),
        ("rows", "8"),
        ("fl", "id,weergavenaam"),
    ]
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(PDOK_SUGGEST, params=params)
        r.raise_for_status()
    docs = r.json().get("response", {}).get("docs", [])
    return [{"id": d["id"], "label": d["weergavenaam"]} for d in docs]


@app.get("/api/lookup")
async def lookup(adres_id: str = Query(..., alias="id")):
    cached = _cache_lookup.get(adres_id)
    if cached is not None:
        return cached

    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(PDOK_LOOKUP, params={"id": adres_id, "fl": "*"})
        r.raise_for_status()
    docs = r.json().get("response", {}).get("docs", [])
    if not docs:
        raise HTTPException(404, "Adres niet gevonden")
    doc = docs[0]

    lat, lng = None, None
    centroide = doc.get("centroide_ll", "")
    if centroide.startswith("POINT("):
        parts = centroide[6:-1].split()
        lng, lat = float(parts[0]), float(parts[1])

    rd_x, rd_y = None, None
    centroide_rd = doc.get("centroide_rd", "")
    if centroide_rd.startswith("POINT("):
        parts = centroide_rd[6:-1].split()
        rd_x, rd_y = float(parts[0]), float(parts[1])

    result = {
        "nummeraanduiding_id": doc.get("nummeraanduiding_id"),
        "verblijfsobject_id":  doc.get("adresseerbaarobject_id"),
        "weergavenaam":        doc.get("weergavenaam"),
        "straat":              doc.get("straatnaam"),
        "huisnummer":          doc.get("huis_nlt"),
        "postcode":            doc.get("postcode"),
        "woonplaats":          doc.get("woonplaatsnaam"),
        "bouwjaar":            doc.get("bouwjaar"),
        "rd_x": rd_x,
        "rd_y": rd_y,
        "gekoppeld_perceel":   doc.get("gekoppeld_perceel"),
        "oppervlakte":         doc.get("oppervlakte"),
        "gebruiksdoel":        doc.get("gebruiksdoel"),
        "lat": lat,
        "lng": lng,
    }
    _cache_lookup.set(adres_id, result)
    return result


@app.get("/api/perceel")
async def get_perceel(gekoppeld_perceel: Optional[str] = Query(None), rd_x: Optional[float] = Query(None), rd_y: Optional[float] = Query(None)):
    if not rd_x or not rd_y:
        return {"perceel": None}

    cache_key = (gekoppeld_perceel, rd_x, rd_y)
    cached = _cache_perceel.get(cache_key)
    if cached is not None:
        return cached

    # Haal percelen op via bbox (CQL attribuutfilter wordt niet ondersteund door deze WFS)
    d = 30
    params = {
        "service":      "WFS",
        "version":      "2.0.0",
        "request":      "GetFeature",
        "typeNames":    "kadastralekaart:Perceel",
        "outputFormat": "application/json",
        "bbox":         f"{rd_x-d},{rd_y-d},{rd_x+d},{rd_y+d},EPSG:28992",
        "count":        "20",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            r = await client.get(PDOK_KK_WFS, params=params)
            r.raise_for_status()
            features = r.json().get("features", [])
        except Exception:
            return {"perceel": None}

    if not features:
        return {"perceel": None}

    # Kies het juiste perceel op basis van gekoppeld_perceel (bijv. 'ZLE00-B-5538')
    target_sectie = None
    target_nummer = None
    if gekoppeld_perceel:
        parts = gekoppeld_perceel.split("-")
        if len(parts) >= 3:
            target_sectie = parts[-2]
            try:
                target_nummer = int(parts[-1])
            except ValueError:
                pass

    best = None
    if target_sectie and target_nummer:
        for f in features:
            p = f.get("properties", {})
            if p.get("sectie") == target_sectie and p.get("perceelnummer") == target_nummer:
                best = f
                break

    # Fallback: neem het kleinste perceel (meest kans op het juiste woonperceel)
    if not best:
        best = min(features, key=lambda f: f.get("properties", {}).get("kadastraleGrootteWaarde") or 9999999)

    p = best.get("properties", {})
    result = {
        "perceel": {
            "kadastralegemeente": p.get("kadastraleGemeenteWaarde"),
            "sectie":             p.get("sectie"),
            "perceelnummer":      p.get("perceelnummer"),
            "oppervlakte_m2":     p.get("kadastraleGrootteWaarde"),
            "geometry":           best.get("geometry"),
        }
    }
    _cache_perceel.set(cache_key, result)
    return result


@app.get("/api/woz")
async def get_woz(nummeraanduiding_id: Optional[str] = Query(None)):
    if not nummeraanduiding_id:
        return {"woz": None, "bron": None}

    cached = _cache_woz.get(nummeraanduiding_id)
    if cached is not None:
        return cached

    # ID altijd zero-padden naar 16 cijfers (zoals de WOZ Waardeloket app dat doet)
    nid = nummeraanduiding_id.zfill(16)

    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        try:
            r = await client.get(f"{WOZ_API}/{nid}", headers=WOZ_HEADERS)
            if r.status_code == 200:
                result = {"woz": r.json(), "bron": "kadaster-wozwaardeloket", "fout": None}
                _cache_woz.set(nummeraanduiding_id, result)
                return result
            return {"woz": None, "bron": None, "fout": f"HTTP {r.status_code}"}
        except Exception as e:
            return {"woz": None, "bron": None, "fout": str(e)}

    return {"woz": None, "bron": None, "fout": None}


ERFGOED_URL = "https://gisservices.zwolle.nl/arcgis/rest/services/Erfgoed/MapServer"

@app.get("/api/monument")
async def get_monument(rd_x: float, rd_y: float):
    cache_key = (rd_x, rd_y)
    cached = _cache_monument.get(cache_key)
    if cached is not None:
        return cached

    query_params = {
        "f":            "json",
        "geometry":     f"{rd_x},{rd_y}",
        "geometryType": "esriGeometryPoint",
        "inSR":         "28992",
        "spatialRel":   "esriSpatialRelIntersects",
        "outFields":    "MONUMENTCODE,KORTE_OMSCHRIJVING,BOUWJAAR,BOUWSTIJL,DATUM_BESLUIT",
        "returnGeometry": "false",
    }
    monumenten = []
    async with httpx.AsyncClient(timeout=20.0) as client:
        for layer_id, soort in [(4, "Rijksmonument"), (5, "Gemeentelijk monument")]:
            try:
                r = await client.get(f"{ERFGOED_URL}/{layer_id}/query", params=query_params)
                r.raise_for_status()
                for feat in r.json().get("features", []):
                    a = feat.get("attributes", {})
                    omschrijving = a.get("KORTE_OMSCHRIJVING")
                    if omschrijving in (None, "<Null>", ""):
                        omschrijving = None
                    monumenten.append({
                        "soort":         soort,
                        "code":          a.get("MONUMENTCODE"),
                        "omschrijving":  omschrijving,
                        "bouwjaar":      a.get("BOUWJAAR"),
                        "bouwstijl":     a.get("BOUWSTIJL"),
                        "datum_besluit": a.get("DATUM_BESLUIT"),
                    })
            except Exception:
                pass
    result = {"monumenten": monumenten}
    _cache_monument.set(cache_key, result)
    return result


@app.get("/api/energielabel")
async def get_energielabel(verblijfsobject_id: str = Query(...)):
    """Haal energielabel op via ep-online.nl (scraping, geen API-sleutel nodig)."""
    cached = _cache_energielabel.get(verblijfsobject_id)
    if cached is not None:
        return cached

    bag_id = verblijfsobject_id.zfill(16)

    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
        # Stap 1: GET voor CSRF-token en sessiecookie
        try:
            r_get = await client.get(EP_ONLINE_SEARCH, headers=_EP_HEADERS)
            r_get.raise_for_status()
        except Exception as e:
            return {"label": None, "fout": str(e)}

        soup_get = BeautifulSoup(r_get.text, "html.parser")
        token_input = soup_get.find("input", {"name": "__RequestVerificationToken"})
        if not token_input:
            return {"label": None, "fout": "geen CSRF-token"}
        token = token_input["value"]

        # Stap 2: POST met BAG verblijfsobject-ID als zoekopdracht
        post_headers = {
            **_EP_HEADERS,
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer":      EP_ONLINE_SEARCH,
        }
        try:
            r_post = await client.post(
                EP_ONLINE_SEARCH,
                data={"SearchValue": bag_id, "__RequestVerificationToken": token},
                headers=post_headers,
            )
            r_post.raise_for_status()
        except Exception as e:
            return {"label": None, "fout": str(e)}

    soup = BeautifulSoup(r_post.text, "html.parser")

    # Meest recente resultaat: hoogste sort-value-registrationdate
    items = soup.select(".pagination-item")
    if not items:
        result = {"label": None, "fout": None}
        _cache_energielabel.set(verblijfsobject_id, result)
        return result

    def _reg_date(item):
        span = item.select_one(".sort-value-registrationdate")
        return span.get_text(strip=True) if span else ""

    best = max(items, key=_reg_date)

    # Labelklasse: tekst in de div met bg-label-class-X
    label_div = best.find(class_=re.compile(r"bg-label-class-"))
    energieklasse = None
    if label_div:
        span = label_div.find("span")
        energieklasse = span.get_text(strip=True) if span else None

    # Registratiedatum: YYYYMMDD → YYYY-MM-DD
    reg_raw = _reg_date(best)
    registratiedatum = (
        f"{reg_raw[:4]}-{reg_raw[4:6]}-{reg_raw[6:]}" if len(reg_raw) == 8 else None
    )

    result = {
        "label": {
            "energieklasse":    energieklasse,
            "registratiedatum": registratiedatum,
        } if energieklasse else None,
        "fout": None,
    }
    _cache_energielabel.set(verblijfsobject_id, result)
    return result


@app.get("/api/laadpalen")
async def get_laadpalen(lat: float, lng: float, straal: int = 500):
    """Geef openbare laadpalen binnen straal (meters) op basis van NDW open data."""
    cache_key = (round(lat, 5), round(lng, 5), straal)
    cached = _cache_laadpalen.get(cache_key)
    if cached is not None:
        return cached

    stations = []
    for feat in _ndw_features:
        coords = (feat.get("geometry") or {}).get("coordinates")
        if not coords:
            continue
        f_lng, f_lat = coords[0], coords[1]
        afstand = round(_haversine(lat, lng, f_lat, f_lng))
        if afstand > straal:
            continue

        props = feat.get("properties", {})
        connectoren = []
        for av in props.get("availabilities", []):
            ct = av.get("connector_type", "")
            power_w = av.get("power_max") or 0
            kw = round(power_w / 1000, 1) if power_w else None
            connectoren.append({
                "type":        _CONNECTOR_LABEL.get(ct, ct),
                "vermogen_kw": kw,
                "totaal":      av.get("total", 1),
                "beschikbaar": av.get("available", 0),
            })

        stations.append({
            "straat":      props.get("address"),
            "eigenaar":    props.get("operator_name"),
            "open":        props.get("open"),
            "afstand_m":   afstand,
            "lat":         f_lat,
            "lng":         f_lng,
            "connectoren": connectoren,
        })

    stations.sort(key=lambda s: s["afstand_m"])
    dichtsbijzijnde = stations[0]["afstand_m"] if stations else None

    result = {"laadpalen": stations, "dichtsbijzijnde_m": dichtsbijzijnde}
    _cache_laadpalen.set(cache_key, result)
    return result


def _slug(text: str) -> str:
    """Zet een straatnaam om naar een URL-slug (Huispedia formaat)."""
    text = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode("ascii")
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    text = re.sub(r"\s+", "-", text.strip())
    return text


@app.get("/api/huispedia")
async def get_huispedia(straat: str, huisnummer: str, woonplaats: str, postcode: str):
    """Scrape Huispedia voor schatting, laatste verkoop en energielabel."""
    cache_key = (straat, huisnummer, woonplaats, postcode)
    cached = _cache_huispedia.get(cache_key)
    if cached is not None:
        return cached

    huisnr_clean = re.sub(r"\s+", "-", str(huisnummer).strip().lower())
    postcode_slug = postcode.replace(" ", "").lower()
    url = f"https://www.huispedia.nl/{_slug(woonplaats)}/{postcode_slug}/{_slug(straat)}/{huisnr_clean}"

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
    }

    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        try:
            r = await client.get(url, headers=headers)
        except Exception as e:
            return {"data": None, "url": url, "fout": str(e)}

    # 403 = Huispedia blokkeert scraping; URL is wel geldig, toon alleen de link
    if r.status_code == 403:
        return {"data": None, "url": url, "fout": None}

    if r.status_code != 200:
        return {"data": None, "url": url, "fout": f"HTTP {r.status_code}"}

    soup = BeautifulSoup(r.text, "html.parser")
    result: dict = {}

    # 1. Probeer JSON-LD (schema.org structured data)
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            ld = json.loads(tag.string or "")
            if isinstance(ld, dict) and ld.get("@type") in ("House", "Residence", "SingleFamilyResidence", "Apartment"):
                result["json_ld"] = ld
        except Exception:
            pass

    # 2. Zoek __NEXT_DATA__ of window.__STATE__ (Next.js / React)
    for tag in soup.find_all("script", id="__NEXT_DATA__"):
        try:
            nd = json.loads(tag.string or "")
            result["next_data"] = nd
        except Exception:
            pass

    # 3. Heuristisch: zoek geldbedragen en labels in de pagina
    tekst = soup.get_text(" ", strip=True)

    # Geschatte waarde
    schatting_match = re.search(
        r"(?:geschatte?\s*(?:waarde|verkoopprijs|woningwaarde)[:\s€]*)([\d.,]+)",
        tekst, re.IGNORECASE
    )
    if schatting_match:
        result["geschatte_waarde_tekst"] = schatting_match.group(1)

    # Laatste verkoop
    verkoop_match = re.search(
        r"(?:laatste\s*(?:verkoop|transactie|verkoopprijs)[:\s€]*)([\d.,]+)",
        tekst, re.IGNORECASE
    )
    if verkoop_match:
        result["laatste_verkoop_tekst"] = verkoop_match.group(1)

    # Energielabel
    label_match = re.search(r"[Ee]nergie(?:label|klasse)[:\s]*([A-G][+]{0,3})", tekst)
    if label_match:
        result["energielabel"] = label_match.group(1).upper()

    # Bouwjaar (backup)
    jaar_match = re.search(r"[Bb]ouwjaar[:\s]*(1[5-9]\d{2}|20[0-2]\d)", tekst)
    if jaar_match:
        result["bouwjaar_hp"] = jaar_match.group(1)

    response = {"data": result if result else None, "url": url, "fout": None}
    _cache_huispedia.set(cache_key, response)
    return response


MOBIEL_GQL = "https://graph.mobiel.nl/api"
MOBIEL_GQL_HEADERS = {
    "Content-Type": "application/json",
    "Accept":       "application/json",
    "Origin":       "https://www.independer.nl",
    "Referer":      "https://www.independer.nl/",
    "User-Agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
}
INTERNET_QUERY = """
query($postcode: String!, $number: Int!) {
  postcode(postcode: $postcode, number: $number, numberAddon: "") {
    fixedAvailability {
      done
      offers { providerSlug state speeds { down up } rawResponse }
    }
  }
}
"""

def _ziggo_max_speed(tcp_lines: list) -> Optional[int]:
    service_types = []
    for tcp in tcp_lines:
        for svc in tcp.get("TcpServiceLines", []):
            if svc.get("FunctionalOrderingPossible"):
                service_types.append(svc.get("TcpPossibleServiceType", ""))
    for svc in service_types:
        if "2GIGA" in svc:
            return 2000
    for svc in service_types:
        if "GIGA" in svc:
            return 1000
    return None


@app.get("/api/internet")
async def get_internet(postcode: str, huisnummer: str):
    """Haal internetbeschikbaarheid op via de Independer/Mobiel.nl GraphQL API."""
    cache_key = (postcode, huisnummer)
    cached = _cache_internet.get(cache_key)
    if cached is not None:
        return cached

    zip_clean = postcode.replace(" ", "").upper()
    nr_str    = re.sub(r"[^\d]", "", str(huisnummer))
    if not nr_str:
        return {"data": None, "fout": "Ongeldig huisnummer"}
    nr = int(nr_str)

    # Link naar providers.nl met adres ingevuld
    url = (f"https://www.providers.nl/internet/vergelijken"
           f"?zip={postcode.replace(' ', '').lower()}&nr={nr}&scroll=true&product_type=ipt")

    variables = {"postcode": zip_clean, "number": nr}
    offers = []

    async with httpx.AsyncClient(timeout=20.0) as client:
        # Poll totdat alle offers klaar zijn (max 10 pogingen, 1s tussenpoos)
        for _ in range(10):
            try:
                r = await client.post(
                    MOBIEL_GQL,
                    json={"query": INTERNET_QUERY, "variables": variables},
                    headers=MOBIEL_GQL_HEADERS,
                )
                r.raise_for_status()
            except Exception as e:
                return {"data": None, "url": url, "fout": str(e)}

            gql = r.json()
            if "errors" in gql:
                return {"data": None, "url": url, "fout": "GraphQL fout"}

            offers = (gql.get("data") or {}).get("postcode", {}).get("fixedAvailability", {}).get("offers", [])

            if not any(o.get("state") == "performing" for o in offers):
                break  # Alle offers zijn klaar

            await asyncio.sleep(1.0)

    nets: dict[str, dict] = {
        "glasvezel": {"available": False, "maxDown": None},
        "kabel":     {"available": False, "maxDown": None},
        "adsl":      {"available": False, "maxDown": None},
    }

    def _update(net: str, speed):
        nets[net]["available"] = True
        if speed and (nets[net]["maxDown"] is None or speed > nets[net]["maxDown"]):
            nets[net]["maxDown"] = speed

    for offer in offers:
        if offer.get("state") != "succeeded":
            continue
        raw    = offer.get("rawResponse")
        speeds = offer.get("speeds") or {}
        down   = speeds.get("down")

        if not isinstance(raw, (dict, list)):
            continue

        # Budget-internet / resellers: ConnectionCharacteristics
        if isinstance(raw, dict) and "ConnectionCharacteristics" in raw:
            for char in raw.get("ConnectionCharacteristics") or []:
                lt  = (char.get("LineType") or "").lower()
                spd = char.get("MaxDownSpeed") or down
                if "fiber" in lt or "glas" in lt:
                    _update("glasvezel", down or spd)
                elif "coax" in lt or "cable" in lt:
                    _update("kabel", down or spd)
                elif "copper" in lt or "vdsl" in lt or "adsl" in lt:
                    _update("adsl", down or spd)

        # Ziggo: TcpLines (null = niet beschikbaar)
        elif isinstance(raw, dict) and "TcpLines" in raw:
            tcp_lines = raw.get("TcpLines")
            if tcp_lines:  # null of lege lijst = geen kabel
                spd = _ziggo_max_speed(tcp_lines)
                _update("kabel", spd or down)

        # KPN direct: available_on_address.technologies
        elif isinstance(raw, dict) and "available_on_address" in raw:
            techs = (raw.get("available_on_address") or {}).get("technologies") or []
            for tech in techs:
                name  = (tech.get("name") or "").upper()
                spd   = tech.get("download") or 0
                if spd <= 0:
                    continue
                if "FIBER" in name or "GLASVEZEL" in name:
                    _update("glasvezel", down or spd)
                elif "COAX" in name or "HFC" in name:
                    _update("kabel", down or spd)
                elif "COPPER" in name or "DSL" in name or "VDSL" in name or "ADSL" in name:
                    _update("adsl", down or spd)

        # Odido: fiber_offer / dsl_offer
        elif isinstance(raw, dict) and ("fiber_offer" in raw or "dsl_offer" in raw):
            if raw.get("fiber_offer"):
                # Gebruik fiber_offer CoverageInfo als autoritatieve bron
                fiber_info = (((raw.get("fiber_offer") or {})
                               .get("Envelope", {})
                               .get("Body", {})
                               .get("CheckFiberCoverageResponse", {})
                               .get("CheckFiberCoverageResult", {})
                               .get("CoverageInfo", {})))
                raw_bw = fiber_info.get("ExpectedMaximumAvailableBandwidth")
                if raw_bw is not None:
                    # Veld aanwezig: 0 = niet beschikbaar, >0 = wel beschikbaar
                    try:
                        bw = int(raw_bw or 0)
                        if bw > 0:
                            _update("glasvezel", round(bw / 1000))  # kbps → Mbps
                    except (ValueError, TypeError):
                        pass
                else:
                    # Veld afwezig: gebruik offer-snelheid als hint
                    if down:
                        _update("glasvezel", down)

        # Youfone: PostcodeCheckCoverageResult
        elif isinstance(raw, dict) and "PostcodeCheckCoverageResult" in raw:
            for prod in (raw["PostcodeCheckCoverageResult"].get("DeliverableProducts") or []):
                status   = (prod.get("AvailabilityStatus") or "").lower()
                dsl_type = (prod.get("DslProductTypeName") or "").upper()
                spd_kbps = prod.get("ExpectedDownKbps") or 0
                spd_mbps = round(spd_kbps / 1000) if spd_kbps > 0 else None
                if "orderable" not in status and "available" not in status:
                    continue
                if "FIBER" in dsl_type or "GLASVEZEL" in dsl_type:
                    _update("glasvezel", down or spd_mbps)
                elif dsl_type and dsl_type not in ("", "NOACCESS"):
                    _update("adsl", down or spd_mbps)

        # Delta/Caiway: lijst van brand-objecten met connections
        elif isinstance(raw, list):
            for brand in raw:
                if not isinstance(brand, dict):
                    continue
                for conn in brand.get("connections") or []:
                    ct     = (conn.get("connectionType") or "").lower()
                    status = (conn.get("connectionStatus") or "").lower()
                    if "niet beschikbaar" in status or status.strip() in ("", "niet"):
                        continue
                    if "glasvezel" in ct or "fiber" in ct:
                        _update("glasvezel", down)
                    elif "coax" in ct:
                        _update("kabel", down)

    result = {}
    for net, info in nets.items():
        result[net] = info["available"]
        if info["maxDown"] is not None:
            result[f"{net}_mbps"] = info["maxDown"]

    response = {"data": result, "url": url, "fout": None}
    _cache_internet.set(cache_key, response)
    return response
