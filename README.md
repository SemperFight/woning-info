# Woning Info Zwolle

Lokale webapplicatie die eigendoms- en kadastrale informatie ophaalt voor adressen in Zwolle.

## Wat doet de app?

- Zoeken op adres in Zwolle (autocomplete)
- Kadastraal perceel op de kaart tonen
- BAG gebouwgegevens (bouwjaar, oppervlakte, gebruiksdoel)
- Kadastrale gegevens (sectie, perceelnummer, grootte)
- WOZ-waarden (meest recente zichtbaar, oudere waarden uitklapbaar)
- Monumentale status (Rijks- en gemeentelijke monumenten)
- Internetbeschikbaarheid (glasvezel, kabel, ADSL/VDSL) met maximale downloadsnelheid
- Openbare laadpalen binnen 500 m (connector type, vermogen, beschikbaarheid) met kaartmarker
- Link naar Huispedia woningpagina
- Externe links naar relevante bronnen

Alle informatiekaarten zijn **inklapbaar** via de titel. Het logo linksboven werkt als **home-knop** en brengt je terug naar het startscherm.

---

## Installatie (eenmalig)

### 1. Python installeren
Zorg dat Python 3.10 of hoger is geïnstalleerd. Controleer via:
```bash
python --version
```

### 2. Kloon of download de repository
```bash
git clone https://github.com/JOUWGEBRUIKERSNAAM/woning-info.git
cd woning-info
```

Of download de ZIP via GitHub en pak deze uit.

### 3. Maak een virtuele omgeving aan
```bash
python -m venv venv
```

### 4. Activeer de virtuele omgeving

**Windows:**
```bash
venv\Scripts\activate
```

**Mac/Linux:**
```bash
source venv/bin/activate
```

### 5. Installeer de vereiste packages
```bash
pip install -r requirements.txt
```

---

## De app starten

### 1. Navigeer naar de projectmap
```bash
cd "pad/naar/woning-info"
```

### 2. Activeer de virtuele omgeving

**Windows:**
```bash
venv\Scripts\activate
```

**Mac/Linux:**
```bash
source venv/bin/activate
```

### 3. Start de server
```bash
uvicorn main:app --reload
```

### 4. Open de browser
Ga naar: [http://localhost:8000](http://localhost:8000)

---

## De app stoppen

Druk in de terminal op **Ctrl+C**. Je kunt daarna de terminal gewoon sluiten.

---

## Caching

De applicatie slaat de resultaten van de **drie meest recente zoekopdrachten** op in het geheugen. Als hetzelfde adres opnieuw wordt opgezocht, worden de gegevens direct teruggegeven zonder nieuwe netwerkverzoeken. De cache wordt geleegd bij het herstarten van de server.

Gecached worden: adresgegevens (lookup), perceelgegevens, WOZ-waarden, monumentale status, Huispedia-gegevens, internetbeschikbaarheid en laadpalen. Adres-autocomplete (suggest) wordt bewust niet gecached.

---

## Laadpalen (NDW open data)

Bij het opstarten downloadt de server automatisch alle openbare laadpalen in Nederland van het [Nationaal Dataportaal Wegverkeer (NDW)](https://opendata.ndw.nu/charging_point_locations.geojson.gz). Dit bestand (~3,3 MB gecomprimeerd) wordt elke **12 uur** stil op de achtergrond ververst.

- Geen registratie of API-key nodig
- Volledige landelijke dekking
- Gegevens per laadpaal: adres, operator, connector type (Type 2, CCS, CHAdeMO…), vermogen (kW) en beschikbaarheid
- De dichtstbijzijnde laadpaal binnen 500 m wordt als ⚡-marker op de kaart getoond

Bij de eerste opstart kan het enkele seconden duren voordat de laadpalendata beschikbaar is.

---

## Gebruikte databronnen

| Bron | Wat |
|------|-----|
| [PDOK Locatieserver](https://api.pdok.nl) | Adres autocomplete en BAG gegevens |
| [PDOK Kadastrale Kaart WFS](https://service.pdok.nl) | Perceelgegevens en geometrie |
| [Kadaster WOZ Waardeloket](https://www.woz-waardeloket.nl) | WOZ-waarden |
| [Zwolle ArcGIS Erfgoed](https://gisservices.zwolle.nl) | Monumentale status |
| [Independer / Mobiel.nl GraphQL](https://graph.mobiel.nl) | Internetbeschikbaarheid per adres |
| [NDW Open Data](https://opendata.ndw.nu) | Openbare laadpalen (heel Nederland) |
| [Huispedia](https://www.huispedia.nl) | Woningpagina link |
