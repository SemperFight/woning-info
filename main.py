from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import httpx
import re
import json
import unicodedata
from bs4 import BeautifulSoup

app = FastAPI(title="Woning Info Zwolle")
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
async def lookup(id: str = Query(...)):
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(PDOK_LOOKUP, params={"id": id, "fl": "*"})
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

    return {
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
        "oppervlakte":         doc.get("oppervlakte"),
        "gebruiksdoel":        doc.get("gebruiksdoel"),
        "lat": lat,
        "lng": lng,
    }


@app.get("/api/perceel")
async def get_perceel(rd_x: float, rd_y: float):
    d = 15  # meter in RD New
    params = {
        "service":      "WFS",
        "version":      "2.0.0",
        "request":      "GetFeature",
        "typeNames":    "kadastralekaart:Perceel",
        "outputFormat": "application/json",
        "bbox":         f"{rd_x-d},{rd_y-d},{rd_x+d},{rd_y+d},EPSG:28992",
        "count":        "1",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            r = await client.get(PDOK_KK_WFS, params=params)
            r.raise_for_status()
            data = r.json()
        except Exception:
            return {"perceel": None}

    features = data.get("features", [])
    if not features:
        return {"perceel": None}

    f = features[0]
    p = f.get("properties", {})
    return {
        "perceel": {
            "kadastralegemeente": p.get("kadastraleGemeenteWaarde"),
            "sectie":             p.get("sectie"),
            "perceelnummer":      p.get("perceelnummer"),
            "oppervlakte_m2":     p.get("kadastraleGrootteWaarde"),
            "geometry":           f.get("geometry"),
        }
    }


@app.get("/api/woz")
async def get_woz(nummeraanduiding_id: str = Query(None)):
    if not nummeraanduiding_id:
        return {"woz": None, "bron": None}

    # ID altijd zero-padden naar 16 cijfers (zoals de WOZ Waardeloket app dat doet)
    nid = nummeraanduiding_id.zfill(16)

    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        try:
            r = await client.get(f"{WOZ_API}/{nid}", headers=WOZ_HEADERS)
            if r.status_code == 200:
                return {"woz": r.json(), "bron": "kadaster-wozwaardeloket"}
        except Exception:
            pass

    return {"woz": None, "bron": None}


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
    huisnr_clean = re.sub(r"\s+", "-", str(huisnummer).strip().lower())
    postcode_slug = postcode.replace(" ", "").lower()
    url = f"https://www.huispedia.nl/{_slug(woonplaats)}/{postcode_slug}/{_slug(straat)}/{huisnr_clean}"

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "nl-NL,nl;q=0.9",
        "Accept": "text/html,application/xhtml+xml",
    }

    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        try:
            r = await client.get(url, headers=headers)
        except Exception as e:
            return {"data": None, "url": url, "fout": str(e)}

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

    return {"data": result if result else None, "url": url, "fout": None}
