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

## Column reference

"Filled" is the number of rows where the column is not null, counted on 2026-11-14. Null always means
"not known". It never means "no" or zero.

### `buildings` (40,246 rows)

**Identity and location**

| Column | Type | Meaning | Filled |
|---|---|---|---|
| `id` | uuid | Our id for the row. Made from the parcel and the footprint, so it stays the same when the import runs again. For a CoStar-only row it is made from the CoStar id | 40,246 |
| `parcel_key` | text | Short code for the Vexcel parcel (land lot) the structure stands on. Structures on one lot share it. 26,851 lots here. Null for CoStar-only rows | 40,221 |
| `costar_id` | text | Link to `costar_properties`. Null means we have Vexcel data only | 362 |
| `lat`, `lng` | number | Center of the roof (Vexcel), in degrees, WGS84. For a CoStar-only row: the CoStar address point | 40,246 |
| `location` | geography point | The same point for PostGIS distance queries. Comes back as hex text over REST: use `lat` and `lng` | 40,246 |

**Measured by Vexcel** (from aerial photos; all null on the 25 CoStar-only rows)

| Column | Type | Meaning | Filled |
|---|---|---|---|
| `footprint` | geography multipolygon | Outline of the roof seen from above. Read it as GeoJSON from `buildings_geojson.footprint_geojson` | 40,221 |
| `footprint_area_m2` | number | Area of the outline in square meters. Range 5 to 29,862, median 169 | 40,221 |
| `ground_elevation_m` | number | Height of the ground at the structure, meters above sea level. Range 57 to 515 (the hills) | 40,221 |
| `vexcel_height_m` | number | Roof height above the ground in meters, computed by Vexcel. Noisy: range -4.9 to 85.2, and 383 values are below zero. Keep it as a cross-check and use `height_m` | 40,221 |
| `vexcel_building_type` | text | Vexcel's guess from the photo: `single_family`, `multiple_family`, `condo_apartment`, `mobile_home`, `institutional_buildings`, `commercial`, `industrial_buildings`, `shed`, `garages_carports`. "Institutional" is often wrong (problem 8) | 40,099 |
| `is_primary_on_parcel` | true/false | True for the structure Vexcel marks as the main one on its lot. One per lot | 40,221 |
| `roof_condition` | 1 to 5 | Vexcel's roof condition grade. Vexcel's tutorial does not say which end is good. In the 3 buildings we looked at by hand, the roofs with defects had lower grades, so higher is probably better (problem 27). Counts: 1: 459, 2: 2,921, 3: 14,684, 4: 19,863, 5: 2,294 | 40,221 |
| `roof_material` | text | `membrane`, `shingle`, `tile`, `metal`, `gravel` | 40,210 |
| `roof_shape` | text | `flat`, `hip`, `gable` | 40,221 |
| `tree_density_zone1` to `zone4` | number | Tree cover in four rings around the structure, zone 1 nearest. Vexcel calls these "defensible space" and uses them for wildfire risk. Hammad's notes give zone 1 as 0 to 1.5 m and zone 2 as 1.5 to 9 m; we did not check this. The unit looks like percent, but 712 zone 1 values are above 100 (problem 28) | 40,221 |
| `building_density_zone1` to `zone4` | number | Share of each ring covered by other buildings. Close neighbors help fire spread. Highest value seen: 71 | 40,221 |
| `parcel_tree_cover_pct` | 0 to 100 | Percent of the lot under tree cover | 40,221 |
| `parcel_hardscape_pct` | 0 to 100 | Percent of the lot that is paved (driveways, patios, parking) | 40,221 |
| `vexcel_survey` | text | Name of the aerial survey the values come from. 39,974 rows: `us-ca-losangeles_rf07-2026` | 40,221 |
| `vexcel_survey_date` | date | Day the photos were taken. 2025-11-29 to 2026-07-03 | 40,221 |

**Resolved values** (use these in the app; the rules are in the next section)

| Column | Type | Meaning | Filled |
|---|---|---|---|
| `building_type` | text | Our one vocabulary: `single_family`, `multi_family`, `office`, `retail`, `hotel`, `commercial`, `industrial`, `institutional`, `accessory` (shed, garage), `land` | 40,124 |
| `building_type_source` | text | Where `building_type` came from. `vexcel` 39,762, `costar` 362 | 40,124 |
| `height_m` | number | Best height in meters | 36,890 |
| `height_source` | text | `costar` (measured, 8 rows), `estimated` (CoStar floors x 3.3 m, 342), `vexcel` (36,540) | 36,890 |
| `floors` | whole number | Floors above ground. Highest: 26 | 34,640 |
| `floors_source` | text | `costar` (350) or `estimated` (Vexcel height / 3.3 m, 34,290) | 34,640 |
| `units` | whole number | Homes or apartments in this structure | 31,780 |
| `units_source` | text | `costar` (307, the structure's share of the property total) or `estimated` (31,473) | 31,780 |
| `est_occupants` | whole number | People who live here: `units` x 2.4. The sum over all rows is 243,203 | 31,774 |
| `occupants_source` | text | Always `estimated` when filled | 31,774 |
| `confidence` | 0 to 1 | How much of the row comes from good sources. 0.45 is a normal Vexcel-only home (29,097 rows). 0.65 or more means CoStar data | 40,246 |

**Copied from CoStar** (null on every Vexcel-only row)

| Column | Type | Meaning | Filled |
|---|---|---|---|
| `construction_material` | text | What the structure is built of: `masonry`, `wood_frame`, `reinforced_concrete`, `steel`, `metal` | 186 |
| `year_built` | whole number | Year construction finished. 1913 to 2026 | 360 |
| `is_walkup` | true/false | True: stairs only, no elevator | 207 |
| `passenger_elevators` | whole number | Count of passenger elevators. 0 means CoStar says there are none | 87 |
| `has_sprinklers` | true/false | Fire sprinkler system | 41 |

**Quality flags** (never null)

| Column | Meaning | True on |
|---|---|---|
| `is_accessory` | Shed, garage or carport. No people. Skip it in a ranking | 2,256 |
| `height_suspect` | Vexcel height is under 3 m and the structure is not accessory. We did not use that height | 3,390 |
| `shares_costar_property` | The CoStar values of one property were given to 2 or more structures on a lot (problem 12) | rows of 37 properties |

**Risk score** (rules and weights: "How the risk score is computed")

| Column | Type | Meaning | Filled |
|---|---|---|---|
| `risk_score` | number | `people_at_risk` x `structure_factor`. Higher = send help first, when a fire threatens the building. Building data only: no fire position and no distance. 0 for sheds and garages. Null when the people inside are not known (commercial, office, retail, industrial). Highest: 186.9 | 38,841 |
| `people_at_risk` | number | Estimated people who cannot leave without help. A one-unit home is 0.228. The sum over all rows is about 34,300 | 38,841 |
| `structure_factor` | 0.5 to 2.0 | How likely the structure is to burn, on a relative scale. 1.0 is a structure with no trees near it, no close neighbors and no known protection. Values here run from 0.70 to 1.81, median 1.37 | 40,246 |

### `costar_properties` (300 rows)

CoStar's own values for a whole property, before we split anything across structures.

| Column | Type | Meaning | Filled |
|---|---|---|---|
| `costar_id` | text | CoStar PropertyId for commercial records. For a home: `res-` plus CoStar's address id, because one home can have several listings | 300 |
| `kind` | text | `commercial` (275, from the commercial property file; most are apartment communities) or `residential` (25, homes from the listings file) | 300 |
| `name` | text | Building or community name. Homes have none | 211 |
| `address` | text | Street address | 300 |
| `postcode` | text | 5-digit ZIP | 300 |
| `lat`, `lng`, `location` | number, geography | CoStar's address point | 300 |
| `property_type` | text | Same vocabulary as `buildings.building_type`. 272 `multi_family`, 14 `single_family`, 11 `office`, 2 `retail`, 1 `industrial` | 300 |
| `is_senior_housing` | true/false | Apartment community for seniors. False for all 261 apartment properties here | 261 |
| `is_student_housing` | true/false | Apartment community for students. Also false for all here | 261 |
| `floors` | whole number | Floors above ground. Highest: 23 | 294 |
| `height_m` | number | Measured height, converted from feet. Rare | 7 |
| `year_built` | whole number | Year construction finished | 298 |
| `construction_material` | text | See `buildings.construction_material`. Null when CoStar says "unknown" | 160 |
| `total_units` | whole number | Apartments in the whole property (hotel rooms for a hotel, 1 for a single home). Highest: 597. Sum: 12,405 | 258 |
| `floor_area_sqft` | number | Total floor area of the building in square feet (homes: living area) | 299 |
| `is_walkup` | true/false | 23 true, 142 false | 165 |
| `passenger_elevators` | whole number | Highest: 6 | 81 |
| `has_sprinklers` | true/false | 29 true | 36 |
| `has_basement` | true/false | Homes only | 25 |
| `has_accessibility_features` | true/false | Homes only: the listing mentions features such as ramps or wide doors | 25 |
| `matterport_model_ids` | list of text | Ids of the Matterport 3D scans of this property. Empty list when there is none. 294 properties have at least one | 300 |

### `contacts` (436 rows)

| Column | Type | Meaning | Filled |
|---|---|---|---|
| `id` | uuid | Our id, stable between imports | 436 |
| `costar_id` | text | The property this contact belongs to | 436 |
| `role` | text | `site_office` (229: the on-site leasing office or hotel desk) or `property_manager` (207: the management company) | 436 |
| `company_name` | text | For `site_office`: the building name. For `property_manager`: the company | 414 |
| `phone` | text | 10 digits. **Fake**: every CoStar phone is a 555 number (problem 13). 192 site offices and 4 managers have one | 196 |
| `is_test_number` | true/false | True only for rows we add by hand with our own phones. The import never sets it and never changes those rows | 436 |

### `buildings_geojson` and `buildings_near`

- `buildings_geojson` has every `buildings` column plus `footprint_geojson`: the outline as a GeoJSON MultiPolygon,
  coordinates in `[lng, lat]` order.
- `buildings_near(p_lat, p_lng, radius_m)` returns full `buildings` rows within `radius_m` meters of the point,
  measured to `location`, nearest first.

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

## How the risk score is computed

Code: `data/db/risk_score.py`. The import runs it on every row after the resolved values are filled.

```
risk_score       = people_at_risk x structure_factor
people_at_risk   = units x 2.4 people x (1 - vacancy) x need rate
structure_factor = 1 + the sum of the adjustments below, kept between 0.5 and 2.0
```

**The score uses building data only.** It has no fire position, no fire arrival time and no distance to a
responder. It does not say which buildings a fire threatens (problem 29).

People:

| Rule | Value |
|---|---|
| Vacancy | 5% of units are empty |
| Need rate: share of residents who cannot leave without help | 0.10 |
| Need rate in senior housing | 0.5 (no row here is senior housing) |
| 3 or more floors, more than 1 unit, and `is_walkup` is true or `passenger_elevators` is 0 | need rate x 1.5 |
| 3 or 4 floors, more than 1 unit, and neither column is known | need rate x 1.07 |
| `units` is `estimated` | at most 200 units are counted (problem 26) |
| `units` is null, type `multi_family` | outline x floors / 85 m2, at least 2 units; 2 floors when `floors` is null |
| `units` is null, type `institutional` or null | one home when outline x floors is 400 m2 or less; else as `multi_family` |
| `units` is null, type `commercial`, `office`, `retail`, `industrial`, `hotel`, `land` | people not known: `people_at_risk` and `risk_score` are null |
| `is_accessory` | 0 |

The 1.07 comes from the CoStar rows: 12 of the 86 apartment properties here with 3 or 4 floors and a known answer
have no elevator (14%), so 1 + 0.14 x 0.5. CoStar lists mostly large properties, so the true share for other
buildings is probably higher.

Structure (a missing value adds 0):

| Column | Adjustment |
|---|---|
| `tree_density_zone1` | 0 to +0.30, by rank |
| `tree_density_zone2` | 0 to +0.20, by rank |
| Mean of `tree_density_zone3` and `zone4` | 0 to +0.20, by rank |
| Mean of `building_density_zone1` and `zone2` | 0 to +0.10, by rank |
| `parcel_hardscape_pct` | 0 to -0.10, by rank |
| `roof_material` | `shingle` +0.05; `tile` or `metal` -0.05 |
| `construction_material` | `wood_frame` +0.10; `reinforced_concrete` or `steel` -0.15 |
| `has_sprinklers` is true | -0.10 |
| `year_built` is 2008 or later | -0.05 |

"By rank" means: the adjustment times the share of structures (sheds and garages left out) that have a lower
value. The lowest value adds 0 and the highest adds the full adjustment. Rank is used because the unit of the tree
columns is not clear (problem 28). `roof_condition` is not used (problem 27).

**Every number in this section is a first guess, not a measurement.** They are in `WEIGHTS` at the top of
`data/db/risk_score.py`. If you change one, change these tables and run the import again. Nobody has checked the
score against a real fire yet.

## Known problems

The numbers are fixed ids, so other files can point to them. New entries get the next free number, in the
section where they fit. That is why the numbers are not in order.

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

25. **383 Vexcel heights are below zero** (lowest -4.9 m). Each one is `height_suspect` or accessory, so it is never used as `height_m`
    for a home.
26. **Some estimated unit counts are far too high.** 34 rows have an estimated `units` above 200, and the highest is
    3,271. The rule (footprint x floors / 85 m2) breaks on very large structures that Vexcel types as
    multi-family (probably large non-residential buildings; we did not check them by eye). CoStar's largest real property here has 597 units. Cap or check
    estimated values above about 200 before you use them in a ranking.
27. **The direction of `roof_condition` is not documented** in the Vexcel tutorial. In the 3 buildings we looked at by hand, the
    roofs with defects had lower grades, so higher is probably better. That is a guess from a small sample. Confirm with the Vexcel mentors before you build on it.
28. **`tree_density_zone1` goes above 100** on 712 rows (highest 262). So it is not a plain percent, and we do not
    know the unit. Zones 2 to 4 stay under 100. Compare rows with each other, and do not read it as a share.

### The risk score

29. **`risk_score` does not know where the fire is.** A large apartment block far from any fire scores above a
    small house next to the fire. Before you send a unit, keep only the buildings that the fire threatens (for
    example by `fire_arrival_min`), then use `risk_score` to order them.
30. **`risk_score` is null for 1,405 rows** (commercial, office, retail, industrial, and 3 CoStar rows with no
    unit count and no outline). Null means "people not known", not "safe". Postgres puts nulls first in a descending sort: use
    `order=risk_score.desc.nullslast`.
31. **Most of the top of the ranking rests on estimated unit counts.** Of the 50 highest scores, 12 use a CoStar
    unit count, 22 use an estimated count (20 of them sit at the 200-unit cap), and 16 are "institutional"
    structures whose units we filled in from the outline. The institutional rows hold about a third of all
    `people_at_risk`. Some of them are probably not housing (problem 8). County Assessor data would fix most of
    this (problem 17).
32. **The order at the top depends on the 200-unit cap.** With a cap of 100, only 17 of the top 50 stay in the top
    50. The tree, roof and construction weights change 0 to 3 of the top 50 when moved by 50%, because
    `people_at_risk` runs from 0.2 to 136 and `structure_factor` only from 0.70 to 1.81.
33. **`structure_factor` is a relative scale with a median of 1.37, not 1.** Compare rows with each other. Do not
    read it as a chance of burning.
34. **One-unit homes all have `people_at_risk` = 0.228.** Among them only `structure_factor` changes the score
    (0.20 to 0.41).
35. **18 structures that are not sheds or garages score 0.** They stand on a lot with a CoStar property and got 0
    of its units in the split (problem 12). The other structures on the lot hold the people.

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
20. **`fire_arrival_min` and call data are not stored.** They depend on the scenario and belong to the API. The
    stored `risk_score` uses building data only (problem 29).

### Vexcel API

21. **Do not send the `layer` parameter with `latest=true`.** With `layer`, Vexcel returns each parcel once per
    survey year (5 to 8 copies), and older surveys often have a height near zero. Without it, you get the newest
    survey only.
22. **The `Total-Pages` header comes on page 1 only.** Page until a page has fewer rows than `page-size`.
23. **No rate limit was reached** at 500 parcels per call, one call at a time (129 calls). Parallel calls are
    untested.
24. **Vexcel gives no address and no parcel number.** A Vexcel-only building has a location and an outline, and
    no name.
