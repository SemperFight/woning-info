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
- Openbare laadpalen binnen 500 m (connector type, vermogen, beschikbaarheid) met kaartmarker en indicatieve kWh-tarieven per operator
- Kadastrale perceelgrenzen als vectorlaag (via PDOK WFS, instelbaar via toggle)
- **Energielabel** (klasse A t/m G, registratiedatum) via ep-online.nl — geen API-sleutel nodig
- Link naar Huispedia woningpagina
- Externe links naar relevante bronnen

Alle informatiekaarten zijn **inklapbaar** via de titel en starten **dichtgeklapt** bij het laden van een adres (alleen de Adreskaart blijft open). Het logo linksboven werkt als **home-knop** en brengt je terug naar het startscherm.

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
- De drie dichtstbijzijnde laadpalen binnen 500 m worden als ⚡-markers op de kaart getoond
- Per laadpaal worden **indicatieve kWh-tarieven** getoond (pay-per-charge, zonder laadpas) voor bekende operators zoals Allego, Shell Recharge, Fastned, Vattenfall InCharge, IONITY, Eneco en meer
- Een directe link naar de tariefpagina van de operator biedt altijd toegang tot de actuele prijzen

> **Let op:** de getoonde tarieven zijn indicatief en gebaseerd op openbaar gepubliceerde pay-per-charge prijzen. Werkelijke kosten kunnen afwijken afhankelijk van laadpas of abonnement.

Bij de eerste opstart kan het enkele seconden duren voordat de laadpalendata beschikbaar is.

---

## Kadastrale grenzen

Via de toggle **"Kadastrale grenzen"** op de kaart kunnen alle perceelgrenzen als vectorlaag worden ingeladen, rechtstreeks uit de PDOK Kadastrale Kaart WFS. De grenzen worden automatisch vernieuwd bij het bewegen of inzoomen van de kaart.

- Beschikbaar vanaf **zoomniveau 15** (straat-/pandniveau)
- Weergegeven als rode lijnen, onafhankelijk van de kadastrale WMS-overlay
- Geen extra installatie of API-key nodig

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
