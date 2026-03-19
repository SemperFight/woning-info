# Woning Info Zwolle

Lokale webapplicatie die eigendoms- en kadastrale informatie ophaalt voor adressen in Zwolle.

## Wat doet de app?

- Zoeken op adres in Zwolle (autocomplete)
- Kadastraal perceel op de kaart tonen
- BAG gebouwgegevens (bouwjaar, oppervlakte, gebruiksdoel)
- Kadastrale gegevens (sectie, perceelnummer, grootte)
- WOZ-waarden (meest recente zichtbaar, oudere waarden uitklapbaar)
- Monumentale status (Rijks- en gemeentelijke monumenten)
- Link naar Huispedia woningpagina
- Externe links naar relevante bronnen

---

## Installatie (eenmalig)

### 1. Python installeren
Zorg dat Python 3.10 of hoger is geïnstalleerd. Controleer via:
```bash
python --version
```

### 2. Navigeer naar de projectmap
```bash
cd "pad/naar/woning-info"
```

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

## Gebruikte databronnen

| Bron | Wat |
|------|-----|
| [PDOK Locatieserver](https://api.pdok.nl) | Adres autocomplete en BAG gegevens |
| [PDOK Kadastrale Kaart WFS](https://service.pdok.nl) | Perceelgegevens en geometrie |
| [Kadaster WOZ Waardeloket](https://www.woz-waardeloket.nl) | WOZ-waarden |
| [Zwolle ArcGIS Erfgoed](https://gisservices.zwolle.nl) | Monumentale status |
| [Huispedia](https://www.huispedia.nl) | Woningpagina link |
