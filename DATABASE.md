# DATABASE.md: the Supabase building data, and its known problems

Read this file before you read from or write to Supabase.

**Rule (also in AGENTS.md):** when you find a problem, a surprise or a limit in the database or in the data inside
it, add it to this file in the same PR as your work. Put it under "Known problems". One short entry each: what
you saw, how to see it again, and what to do about it. Never put sponsor data (CoStar, Vexcel, Matterport values,
building names, addresses, phone numbers) in this file. The repo is public. Counts and percentages are fine.

Owner of the database: Rasul. Schema: `data/db/schema.sql`. Import: `data/db/load_supabase.py`.

## What is in the database (loaded 2026-11-14)

Project `Responder0`, Postgres 17 with PostGIS. Area: the City of Los Angeles "Hollywood" Community Plan Area
(`data/db/hollywood_boundary.geojson`, public city data).

| Table | Rows | One row is |
|---|---|---|
| `buildings` | 40,246 | One Vexcel structure, or one CoStar property that has no Vexcel structure (25 rows) |
| `costar_properties` | 300 | One CoStar property (275 commercial, 25 homes), with CoStar's own values |
| `contacts` | 436 | A site office or property manager of a CoStar property |

Also: view `buildings_geojson` (all `buildings` columns plus `footprint_geojson`), and function
`buildings_near(p_lat, p_lng, radius_m)`.

362 `buildings` rows have CoStar data (`costar_id` is not null). The other 39,884 are Vexcel-only.

## How to read it

Use `SUPABASE_URL` and `SUPABASE_SECRET_KEY` from the root `.env`. Server code only: never in `web/`.

```
# 5 buildings with CoStar data, footprint as GeoJSON
curl "$SUPABASE_URL/rest/v1/buildings_geojson?select=id,lat,lng,height_m,units,footprint_geojson&costar_id=not.is.null&limit=5" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY"

# buildings within 500 m of a point, nearest first
curl -X POST "$SUPABASE_URL/rest/v1/rpc/buildings_near" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  -H "Content-Type: application/json" -d '{"p_lat": 34.1016, "p_lng": -118.3267, "radius_m": 500}'
```

These are plain HTTPS calls, so any language works. The `supabase-py` client should work with the same URL and
key; nobody has tested it here yet.

## How to load it again

```
python3 data/db/load_supabase.py --dry-run          # build rows, print counts, send nothing
python3 data/db/load_supabase.py                    # upload (about 2 minutes)
python3 data/db/load_supabase.py --apply-schema     # run schema.sql first, then upload
```

- Needs the CoStar kit at `data/costar-kit/` (or `--costar-kit <path>`) and the root `.env`.
- The first run calls Vexcel (129 calls, about 4 minutes) and caches the answers in `data/cache/vexcel_hollywood/`.
  Later runs do not call Vexcel. Delete that folder to fetch again.
- The upload is an upsert. Row ids are made from the parcel and footprint, so a second run updates the same rows.
- `--apply-schema` also needs `SUPABASE_PROJECT_REF` and `SUPABASE_ACCESS_TOKEN`. Or paste `schema.sql` into the
  Supabase SQL editor.
- Another area: `--boundary <file.geojson> --cache <new folder>`. Rows from the old area stay in the tables.
- Checks: `ruff check data/db && pytest data/db`. CI does not run these (it only covers `api/` and `agent/`).

## How each resolved value is chosen

`buildings` keeps the measured Vexcel values (`vexcel_height_m`, `vexcel_building_type`, ...) and a second set of
"resolved" columns that the app should use. Each resolved column has a `*_source` column:
`costar`, `vexcel`, `estimated`, `assessor` (not used yet) or null.

| Column | Rule, first match wins |
|---|---|
| `height_m` | CoStar measured height; else CoStar floors x 3.3 m (`estimated`); else Vexcel height if not suspect; else null |
| `floors` | CoStar floors; else Vexcel height / 3.3, rounded, at least 1 (`estimated`); else null |
| `building_type` | CoStar property type; else Vexcel's type |
| `units` | CoStar units, split across the parcel's structures; else 1 for `single_family`; else footprint x floors / 85 m2 for `multi_family`; else null |
| `est_occupants` | `units` x 2.4, always `estimated`; null when `units` is null |
| `confidence` | Mean weight of the sources of `building_type`, `height_m`, `floors`, `units` |

Confidence weights: `costar` 1.0, `assessor` 0.8, `vexcel` 0.6, `estimated` 0.3, null 0.

**These numbers are assumptions, not measurements:** 3.3 m per floor, 85 m2 of floor area per unit, 2.4 people
per unit, the 3 m "suspect" limit, and the confidence weights. They are constants at the top of
`data/db/build_rows.py`. If you change one, change this table and run the import again.

**CoStar matching:** a CoStar property goes to the Vexcel parcel that contains its point. Its values go to every
structure on that parcel that is not a shed or garage. Its units are split by footprint area x height, and the
parts add up to the CoStar total. `shares_costar_property` is true when 2 or more structures got the values.

## Known problems

### Reading the data

1. **The REST API returns at most 1,000 rows per request.** A plain `GET /rest/v1/buildings` gives 1,000 of
   40,246 rows and no error. Page with the `Range` header or `limit` and `offset`, or filter first
   (`buildings_near`, `costar_id=not.is.null`).
2. **Geography columns come back as hex text** (`location`, `footprint`). Use `lat` and `lng`, and read the outline
   from `buildings_geojson.footprint_geojson`.
3. **The publishable key reads nothing.** Row security is on and no table has a rule. A request with that key
   returns `[]`, not an error. This is on purpose while the web app reads through the API. To let the browser read
   a table, add a `select` rule for it in `schema.sql`.
4. **`SUPABASE_SECRET_KEY` and `SUPABASE_ACCESS_TOKEN` have full access.** Keep them in `.env` only.
5. **Each agent folder needs its own `.env`.** The file is not shared between `floodresponders-<name>` folders.

### Values to distrust

6. **Vexcel height is noisy.** Against CoStar floors x 3.3 m, in a first test on 161 buildings, 58 were within
   10% and 106 within 25%. Tall buildings often read low. Use `height_m`, and treat `vexcel_height_m` as a
   cross-check.
7. **3,390 structures are `height_suspect`** (Vexcel height under 3 m, not a shed or garage). Their `height_m` and
   `floors` are null unless CoStar has the building.
8. **Vexcel's building type is wrong for many "institutional" structures** (4,417 here). Hammad's check against
   the county Assessor found most of them are homes or apartments (`data/BUILDING_MODEL.md`, branch `hammad_1`).
   These rows have `building_type = 'institutional'` and null `units`, so they have no people.
9. **`units` is null for 8,466 rows:** sheds and garages (2,256), institutional, commercial and industrial
   structures, and structures with a suspect height. The risk score must handle null, not treat it as zero.
10. **`est_occupants` covers homes only.** Offices, shops and hotels have no occupant estimate (day and night
    counts differ, and we did not load tenant data).
11. **Most values are estimates.** `units_source` is `estimated` for 31,473 rows and `costar` for 307. Average
    `confidence` is 0.41.
12. **Shared parcels (37 CoStar properties):** every non-accessory structure on the parcel gets the CoStar floors
    and height. A tower next to a low building on one parcel both get the tower's floors. Check
    `shares_costar_property`.
13. **Contact phone numbers are fake.** CoStar replaced every phone in the kit with a 555 number. For a real call
    in the demo, add a `contacts` row with our own phone and `is_test_number = true`.
14. **2 footprints are not valid polygons** (`st_isvalid` is false). They store and draw, and some PostGIS
    functions can fail on them. Wrap with `st_makevalid` if you need area or intersection.
15. **No senior housing in this area.** `is_senior_housing` is false for every apartment property here.

### Differences from other parts of the project

16. **The area is smaller than the demo area.** The demo pipeline on branch `hammad_1` uses the Hollywood plan
    area plus the Sunset Fire evacuation areas (42,557 buildings). This database holds the plan area only
    (40,246). To match, run the import with that boundary (see "How to load it again").
17. **County Assessor data is not loaded.** `CONTRACTS.md` names the Assessor as the main source for units, use and
    year built. The `assessor` source label and its weight exist, and no row uses them yet. Loading it would
    replace most `estimated` units.
18. **Floor height differs:** `DemoBuilding.height_m` in `CONTRACTS.md` uses stories x 3.2 m. This database uses
    3.3 m. The difference is 3%.
19. **Row ids are not the pipeline's ids.** `buildings.id` is a UUID made by the import. Join to pipeline output by
    location or by `costar_id`, not by id.
20. **`fire_arrival_min`, risk scores and call data are not stored.** They depend on the scenario and belong to
    the API.

### Vexcel API

21. **Do not send the `layer` parameter with `latest=true`.** With `layer`, Vexcel returns each parcel once per
    survey year (5 to 8 copies), and older surveys often have a height near zero. Without it, you get the newest
    survey only.
22. **The `Total-Pages` header comes on page 1 only.** Page until a page has fewer rows than `page-size`.
23. **No rate limit was reached** at 500 parcels per call, one call at a time (129 calls). Parallel calls are
    untested.
24. **Vexcel gives no address and no parcel number.** A Vexcel-only building has a location and an outline, and
    no name.
