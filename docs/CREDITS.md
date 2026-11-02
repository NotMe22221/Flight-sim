# Data and reference credits

The simulator's own code is MIT licensed (see `LICENSE`). It streams or embeds the following
third-party data, whose licenses require attribution. The in-app "Data credits" dialog shows
this list.

## Terrain elevation — Mapzen / Tilezen Terrain Tiles on AWS Open Data

Tiles: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`.
Per-source attribution required by the [Joerd attribution page](https://github.com/tilezen/joerd/blob/master/docs/attribution.md):

- ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under
  National Science Foundation awards 1043681, 1559691, and 1542736
- Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017
- Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich
- Canada terrain data contains information licensed under the Open Government Licence – Canada
- Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers
- Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration
- Mexico terrain data source: INEGI, Continental relief, 2016
- New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the
  New Zealand Government (All rights reserved)
- Norway terrain data © Kartverket
- United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved
- United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey

## Satellite imagery

- Sentinel-2 cloudless — https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus
  Sentinel data 2016 & 2017), CC BY 4.0 (2016 mosaic). Later mosaics are CC BY-NC-SA 4.0 and are
  opt-in only.
- NASA Global Imagery Browse Services (GIBS), EOSDIS — Blue Marble / shaded relief, public domain.

## Airports, runways, navaids, frequencies

- [OurAirports](https://ourairports.com/data/) — released into the public domain.
  Baked by `scripts/build-airports.mjs`. ILS data is **synthesized** (OurAirports has none); it is
  labelled as such in the UI.

## Magnetic variation

- World Magnetic Model 2025 — NOAA National Centers for Environmental Information and the British
  Geological Survey. U.S. Government work, public domain.

## Flight-model reference data

Aerodynamic coefficients were compiled and re-tuned from published engineering sources: JSBSim
`c172p`/`c172x` (LGPL-2.1, used as reference numbers only — no code or data files are shipped),
the FlightGear c172p project (GPL-2.0, reference only), NACA Report 640 propeller data (public
domain), MIL-F-8785C (public domain), and Cessna 172S POH performance figures used as facts.

## Libraries

- [Three.js](https://threejs.org) — MIT
- Vite, Vitest, TypeScript — MIT / Apache-2.0
