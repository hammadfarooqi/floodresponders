# data/: sponsor data pipeline (branch hammad_1 only, not main)

This folder turns the CoStar, Vexcel and Matterport data into one record per building, and draws a coverage map.

## Setup (each person, once)

1. Copy `.env.example` (repo root) to `.env` and fill in the sponsor keys from the hackathon portal.
2. Download the CoStar hackathon kit zip from the portal, unzip it with the password, and put the folder at
   `data/costar-kit/`. Do not commit it: it is too big for GitHub and holds sponsor data.
3. Python 3.9 or newer. The scripts use only the standard library.

`data/costar-kit/`, `data/cache/` and `data/processed/` are in `.gitignore`. Never commit them.

## Run

```
python3 data/pipeline/costar_extract.py                 # CoStar -> data/processed/costar_{la,houston}.json
python3 data/pipeline/enrich.py matterport la           # stairs, windows, doors per scan (cached)
python3 data/pipeline/enrich.py vexcel la               # ground elevation, roof, parcel (cached)
python3 data/pipeline/enrich.py footprints la           # building outlines (cached)
python3 data/pipeline/build_map.py                      # merge -> buildings_{city}.json + coverage_map.html
```

Hollywood detail (every Vexcel building, not only CoStar, plus the Sunset Fire evacuation areas):

```
python3.12 data/pipeline/evac_zones.py                  # trace LAFD evacuation areas along OSM roads (needs modern SSL)
python3 data/pipeline/area_fetch.py hollywood           # every Vexcel parcel in the area, ~15 min, cached per tile
python3 data/pipeline/build_hollywood_map.py            # -> buildings_hollywood.json + hollywood_map.html
data/pipeline/watch_hollywood.sh                        # optional: rebuild the map every minute during a fetch
```

Vexcel area queries return each parcel once per image collection (each year flown), even with `latest=true`.
`area_fetch.py` keeps only the newest collection per tile.

Use `houston` in place of `la` for Houston. API responses are cached in `data/cache/`, so a re-run only calls the API
for new ids. A full run for one city takes about 15 minutes.

**Live map (preferred):** `cd explore && npm install && npm run dev`, then http://localhost:3001. It shows every layer in
`data/processed/layers/manifest.json` and reloads a layer by itself when its file changes. `build_map.py` and
`build_hollywood_map.py` call `export_layers.py` at the end, so the open page updates after each pipeline run.
To add a layer, add an entry in `export_layers.py` and run it.

Static HTML maps (older): `cd data/processed && python3 -m http.server 8765`, then /coverage_map.html or /hollywood_map.html

## Generate the plan v2 demo files (data/demo/, gitignored)

Needs: root `.env` with the sponsor keys, the CoStar kit at `data/costar-kit/`, Python 3.9+ (and python3.12 for the
two scripts that call OpenStreetMap, because of SSL). About 30-40 minutes the first time; API responses are cached.

```
python3 data/pipeline/costar_extract.py                  # CoStar -> processed/costar_{la,houston}.json
python3 data/pipeline/enrich.py vexcel la                # Vexcel point lookups for CoStar buildings
python3 data/pipeline/enrich.py matterport la            # Matterport stairs/windows
python3 data/pipeline/enrich.py footprints la
python3 data/pipeline/build_map.py                       # -> processed/buildings_la.json
python3.12 data/pipeline/evac_zones.py                   # real Sunset Fire evacuation areas (OSM)
python3 data/pipeline/area_fetch.py hollywood            # every Vexcel building in Hollywood (~15 min)
python3 data/pipeline/assessor_join.py hollywood         # LA County Assessor per building (~5 min)
python3 data/pipeline/build_hollywood_map.py             # -> processed/buildings_hollywood.json
python3 data/pipeline/demo_buildings.py                  # -> demo/buildings.json (DemoBuilding + inputs)
python3 data/pipeline/fire_timeline.py                   # -> demo/fire_timeline.json, fire_arrival_min, what-if evac areas
python3.12 data/pipeline/roads_stations.py               # -> demo/roads.json, demo/stations.json
python3 data/pipeline/interior_layouts.py                # -> demo/interiors_index.json, demo/interiors.json (about 2 min)
```

`interior_layouts.py` is independent of the other steps. It reads the scan ids from Supabase (`costar_properties`,
needs `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `.env`) and the rooms, walls, doors and walking positions of each scan
from the Matterport API. A scan is kept when it has a room labelled "Bedroom" that can be walked to: 350 of 1,058
scans, on 166 of 294 properties (2026-11-14).

`buildings.json` fields beyond CONTRACTS.md DemoBuilding: `inputs` = the raw value from every source (Vexcel type,
roof, vegetation; Assessor use, units, bedrooms, floor area, year built; story estimate and its source), so a scorer
can switch sources on and off and fall back. Assessor values are per parcel and only on the parcel's main structure
(`assessor_owner`).

## Files

| Path | What it is |
|---|---|
| `probe/matterport.py`, `probe/vexcel.py` | Small API clients, also usable from the command line |
| `probe/costar_coverage.py` | How often each field is filled in the CoStar kit |
| `pipeline/` | The pipeline above, and the map template |
| `boundaries/` | Public LA boundaries: city limit, 35 Community Plan Areas, 348 county statistical areas, fire perimeters |
| `boundaries/sunset_fire_2025_evacuation.geojson` | Sunset Fire (8 Jan 2025) LAFD mandatory order and warning areas, traced on OpenStreetMap roads (ODbL). Warning east/north edges assumed |

## What each source gives (tested 2026-11-14)

| Need | Source and field | Coverage |
|---|---|---|
| Location | CoStar `primaryAddress.latitude/longitude` | 100% |
| Stories | CoStar `numStoriesAboveGrade` | ~100% |
| Construction material | CoStar `buildingConstructionMaterial` | LA 65%, Houston 82% |
| Units, vacancy | CoStar `propertyApartment.totalNumUnits`, `vacancyPercent` | 91%, 61% of apartments |
| Senior housing | CoStar `apartmentLifestyleType == 2` | LA 10, Houston 35 communities |
| Walk-up, elevators | CoStar `propertyApartment.isWalkup`, `elevators` | partial |
| Manager contact | CoStar contacts (PropertyManager) and `sitePhoneNumber` | phones are fake 555 numbers |
| Ground elevation, roof, footprint | Vexcel `/property/extract` | ~99% |
| Stairs, windows, doors | Matterport GraphQL rooms and openings | ~35% of buildings |
| Tenant age | none | not available; the manager call must ask |

Vexcel `include=calculated` roof height is wrong for large buildings. Use CoStar stories instead.

## Completeness tiers (map colors)

| Tier | Color | Meaning |
|---|---|---|
| 4 | green | CoStar core (stories, material, units) + Vexcel elevation + Matterport stairs or windows |
| 3 | blue | CoStar core + Vexcel, no stairs or windows in scans |
| 2 | yellow | Vexcel + partial CoStar (material or units missing) |
| 1 | pink | CoStar only |

## Decision: LA focus area (2026-11-14, Hammad)

For LA we use **Core + Westlake**: the Community Plan Areas Wilshire, Hollywood, Downtown and Westlake. It is one
connected block with 893 buildings (180 complete, tier 4), about 64,900 apartment units and 3 senior communities.

- East (Silver Lake–Echo Park, Northeast LA): not now.
- Westside (West LA, Westwood, Palms, Brentwood–Pacific Palisades): maybe later.
- Houston is fully processed too (1,758 buildings). Which city the demo uses is still open.

## Decision: LA scenario = Hollywood Hills, Sunset Fire 2025 (2026-11-14, Hammad)

Replay the Sunset Fire (Runyon Canyon, 8 Jan 2025) and a larger "what if" version pushed south by wind. Ground
truth is LAFD's evacuation areas, not structure damage. Every building in the area comes from Vexcel (42,557 in
Hollywood + evacuation areas); CoStar adds detail for 275 of them (49 inside the mandatory order area).
