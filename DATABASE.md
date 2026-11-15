# DATABASE.md: the Supabase building data, and its known problems

Read this file before you read from or write to Supabase.

**Rule (also in AGENTS.md):** when you find a problem, a surprise or a limit in the database or in the data inside
it, add it to this file in the same PR as your work. Put it under "Known problems". One short entry each: what
you saw, how to see it again, and what to do about it. Never put sponsor data (CoStar, Vexcel, Matterport values,
building names, addresses, phone numbers) in this file. The repo is public. Counts and percentages are fine.

Owner of the database: Rasul. Schema: `data/db/schema.sql`. Import: `data/db/load_supabase.py`, then
`data/db/load_facilities.py`.

## What is in the database (loaded 2026-11-14)

Project `Responder0`, Postgres 17 with PostGIS. Area: the City of Los Angeles "Hollywood" Community Plan Area
(`data/db/hollywood_boundary.geojson`, public city data).

| Table | Rows | One row is |
|---|---|---|
| `buildings` | 40,246 | One Vexcel structure, or one CoStar property that has no Vexcel structure (25 rows) |
| `costar_properties` | 300 | One CoStar property (275 commercial, 25 homes), with CoStar's own values |
| `contacts` | 436 | A site office or property manager of a CoStar property |
| `facilities` | 212 | A care home, nursing home, hospital, housing project or school from a public list, linked to its building |

Also: view `buildings_geojson` (all `buildings` columns plus `footprint_geojson`), and function
`buildings_near(p_lat, p_lng, radius_m)`.

362 `buildings` rows have CoStar data (`costar_id` is not null). 40,209 rows stand on a County Assessor lot
(`assessor_ain` is not null): the Assessor is the public tax record of Los Angeles County, one record for each lot.

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
| `roof_condition` | 1 to 5 | Vexcel's roof condition grade. 5 is best ("looks new"), 1 is worst (problem 27). Counts: 1: 459, 2: 2,921, 3: 14,684, 4: 19,863, 5: 2,294 | 40,221 |
| `roof_material` | text | `membrane`, `shingle`, `tile`, `metal`, `gravel` | 40,210 |
| `roof_shape` | text | `flat`, `hip`, `gable` | 40,221 |
| `roof_tree_cover_pct` | 0 to 100 | Percent of the roof under tree branches. 0 on 12,474 rows, above 10 on 5,093 | 40,221 |
| `roof_structural_damage` | true/false | Vexcel sees structural damage on the roof. True on 8,045 | 40,221 |
| `roof_missing_material` | true/false | Vexcel sees roof material missing. True on 19,576, so it is a weak sign (problem 50) | 40,221 |
| `roof_tarp` | true/false | A tarp is on the roof. True on 1,119 | 40,221 |
| `roof_debris` | true/false | Debris is on the roof. True on 2,507 | 40,221 |
| `has_solar_panels` | true/false | Solar panels are on the roof. True on 3,184 | 40,221 |
| `vexcel_type_confidence` | 0 to 1 | How sure Vexcel is of `vexcel_building_type`. Median 0.58; under 0.5 on 15,978 rows (problem 49) | 40,099 |
| `roof_material_confidence` | 0 to 1 | How sure Vexcel is of `roof_material`. Median 0.58 | 31,092 |
| `roof_shape_confidence` | 0 to 1 | How sure Vexcel is of `roof_shape`. Median 1.0 | 39,974 |
| `tree_density_zone1` to `zone4` | number | Tree cover around the structure, zone 1 nearest. Vexcel calls these "defensible space" and uses them for wildfire risk. The zones reach 5, 30, 100 and 200 feet from the wall (1.5, 9, 30 and 61 m). Each zone includes the zones inside it: they are not separate rings. The value is a percent, and it can go above 100 (problem 28) | 40,221 |
| `building_density_zone1` to `zone4` | number | Share of each ring covered by other buildings. Close neighbors help fire spread. Highest value seen: 71 | 40,221 |
| `parcel_tree_cover_pct` | 0 to 100 | Percent of the lot under tree cover | 40,221 |
| `parcel_hardscape_pct` | 0 to 100 | Percent of the lot that is paved (driveways, patios, parking) | 40,221 |
| `vexcel_survey` | text | Name of the aerial survey the values come from. 39,974 rows: `us-ca-losangeles_rf07-2026` | 40,221 |
| `vexcel_survey_date` | date | Day the photos were taken. 2025-11-29 to 2026-07-03 | 40,221 |

**Resolved values** (use these in the app; the rules are in the next section)

| Column | Type | Meaning | Filled |
|---|---|---|---|
| `building_type` | text | Our one vocabulary: `single_family`, `multi_family`, `office`, `retail`, `hotel`, `commercial`, `industrial`, `institutional`, `accessory` (shed, garage), `land` | 40,223 |
| `building_type_source` | text | Where `building_type` came from. `assessor` 37,465, `vexcel` 2,396, `costar` 362 | 40,223 |
| `height_m` | number | Best height in meters | 36,890 |
| `height_source` | text | `costar` (measured, 8 rows), `estimated` (CoStar floors x 3.3 m, 342), `vexcel` (36,540) | 36,890 |
| `floors` | whole number | Floors above ground. Highest: 26 | 34,640 |
| `floors_source` | text | `costar` (350) or `estimated` (Vexcel height / 3.3 m, 34,290) | 34,640 |
| `units` | whole number | Homes or apartments in this structure. 0 means the lot has fewer homes than structures and this one got none (problem 38) | 34,400 |
| `units_source` | text | `assessor` (33,524) or `costar` (329): the structure's share of the lot or property total. `estimated` (547) | 34,400 |
| `est_occupants` | whole number | People who live here: `units` x 2.4. The sum over all rows is 270,220 | 34,394 |
| `occupants_source` | text | Always `estimated` when filled | 34,394 |
| `year_built` | whole number | Year construction finished. CoStar, else the Assessor (the oldest building on the lot). 2008 or later on 1,575 rows. The lowest value is 1822, which is probably an error on the tax roll | 38,529 |
| `year_built_source` | text | `assessor` (38,169) or `costar` (360) | 38,529 |
| `confidence` | 0 to 1 | How much of the row comes from good sources. 0.62 is a normal structure with Assessor data (31,167 rows). 0.65 or more means CoStar data | 40,246 |

**County Assessor** (the lot, or lots, under the center of the structure; all null on the 37 rows with no lot)

These are values of the whole lot. Every structure on the lot carries the same values, so do not add them up
across structures (problem 38).

| Column | Type | Meaning | Filled |
|---|---|---|---|
| `assessor_ain` | text | Lot number, 10 digits (the "AIN" or "APN" of other county data). When the structure is on stacked condominium lots: the one with the most homes | 40,209 |
| `assessor_use_type` | text | `Residential` (36,114), `Commercial`, `Government`, `Institutional`, `Industrial`, `Recreational`, `Miscellaneous` | 40,041 |
| `assessor_use_description` | text | The finer use, for example `Single`, `Five or more apartments`, `Store Combination`, `Hotel & Motels`, `Schools (Private)`, `Hospitals`, `Homes For Aged & Others` | 40,041 |
| `assessor_units` | whole number | Homes on the lot. Null when the tax roll has 0, and on lots that are not housing (problem 39) | 35,817 |
| `assessor_bedrooms` | whole number | Bedrooms on the lot. 99 is probably a placeholder (problem 37) | 35,527 |
| `assessor_year_built` | whole number | Year of the oldest building on the lot | 38,491 |
| `assessor_address` | text | Street address of the lot, in capitals, with no unit number and no city. Every structure on the lot has the same one | 40,161 |
| `assessor_sqft` | whole number | Floor area of the buildings on the lot, in square feet, for the whole lot (problem 38). Highest: 1,352,132. Not used in any rule yet | 38,296 |

**Areas the structure stands in** (public data, joined by `lat` and `lng`; rules in `data/db/areas.py`)

| Column | Type | Meaning | Filled |
|---|---|---|---|
| `fire_hazard_zone` | text | Fire Hazard Severity Zone on the CAL FIRE map dated 2025-03-24: `very_high` (21,888), `high` (1,268), `moderate` (934), or `none` (16,156: the structure is in no zone). It rates the land, not the building (problem 53) | 40,246 |
| `census_tract` | text | 11-digit id of the 2020 census tract. 87 tracts here | 40,246 |
| `tract_pct_age65` | 0 to 100 | Percent of the people in the tract aged 65 or more. Range 0 to 27.9, median 15.3. A value for the tract, not for this building (problem 54) | 40,246 |
| `tract_pct_disability` | 0 to 100 | Percent of the people in the tract with a disability of any kind. Range 0 to 29.1, median 9.2 | 40,246 |
| `tract_pct_no_vehicle` | 0 to 100 | Percent of the households in the tract with no vehicle. Range 0 to 46.5, median 6.9 | 39,273 |

**Copied from CoStar** (null on every Vexcel-only row)

| Column | Type | Meaning | Filled |
|---|---|---|---|
| `construction_material` | text | What the structure is built of: `masonry`, `wood_frame`, `reinforced_concrete`, `steel`, `metal` | 186 |
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
| `risk_score` | number | `people_at_risk` x `structure_factor`. Higher = send help first, when a fire threatens the building. Building data only: no fire position and no distance. 0 for sheds and garages and for structures with 0 units. Null when the people inside are not known (problem 30). Highest: 194.2 | 36,712 |
| `people_at_risk` | number | Estimated people who cannot leave without help. A one-unit home is 0.228. The sum over all rows is about 26,400 | 36,712 |
| `structure_factor` | 0.5 to 2.0 | How likely the structure is to burn, on a relative scale. 1.0 is a structure with no trees near it, no close neighbors and no known protection. Values here run from 0.70 to 1.81, median 1.36 | 40,246 |

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
| `total_units` | whole number | Apartments in the whole property: the sum of CoStar's floor plans, else the count on the apartment listing (hotel rooms for a hotel, 1 for a single home). Not CoStar's `totalNumUnits` (problem 36). Highest: 735. Sum: 16,100 | 275 |
| `floor_area_sqft` | number | Total floor area of the building in square feet (homes: living area) | 299 |
| `is_walkup` | true/false | 23 true, 142 false | 165 |
| `passenger_elevators` | whole number | Highest: 6 | 81 |
| `has_sprinklers` | true/false | 29 true | 36 |
| `has_basement` | true/false | Homes only | 25 |
| `has_accessibility_features` | true/false | Homes only: the listing mentions features such as ramps or wide doors | 25 |
| `vacancy_pct` | 0 to 100 | Apartments: percent of units that are empty. 0 means full. Median 4. The risk score still uses a fixed 5% | 127 |
| `rent_type` | text | Apartments: `market` (229), `mixed` (30: market-rate and affordable units) or `affordable` (2) | 261 |
| `num_buildings` | whole number | Apartments: buildings that make up the property. 1 on 232, 2 to 5 on 26. Compare it with the structures that share the property (problem 12) | 258 |
| `apartment_style` | text | `low_rise` (126), `mid_rise` (122), `high_rise` (4), `garden` (3) | 255 |
| `parcel_number` | text | CoStar's first county lot number, 10 digits, in the form of `buildings.assessor_ain` (problem 51) | 273 |
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

### `facilities` (212 rows)

Places that hold many people who cannot leave without help, or many children. They come from five public lists
(no key needed), cut to the plan area. Import: `data/db/load_facilities.py`, rules: `data/db/facilities.py`.

| Column | Type | Meaning | Filled |
|---|---|---|---|
| `id` | uuid | Our id. Made from `source` and `source_id`, so it stays the same when the import runs again | 212 |
| `source` | text | The list the row comes from: `cdss`, `cdph`, `lahd`, `hud` or `cde` (table below) | 212 |
| `source_id` | text | The publisher's own id for the place | 212 |
| `kind` | text | What the place is (table below) | 212 |
| `name` | text | Name of the place | 212 |
| `address` | text | Street address, as the publisher writes it | 212 |
| `capacity` | whole number | How many people, beds, homes or students. Null means not known | 201 |
| `capacity_unit` | text | What `capacity` counts: `people`, `beds`, `units` (homes) or `students` | 212 |
| `lat`, `lng`, `location` | number, geography | The publisher's point for the address | 212 |
| `source_status` | text | The publisher's status value, as sent (problem 46) | 185 |
| `building_id` | uuid | The `buildings` row the place stands in (rule below). Null when no building is within 50 m | 212 |
| `building_distance_m` | number | 0: the point is inside the building outline (143 rows). Above 0: meters from the point to the nearest outline (69 rows) | 212 |

| `kind` | Rows | `capacity` (sum) | People there | From |
|---|---|---|---|---|
| `elderly_care` | 27 | 1,236 people | Day and night | `cdss`: residential care for the elderly |
| `adult_care` | 7 | 203 people | Day and night | `cdss`: adult residential care, care for the chronically ill |
| `children_home` | 2 | 12 people | Day and night | `cdss`: group home, transitional housing |
| `nursing_home` | 11 | 1,171 beds | Day and night | `cdph`: skilled nursing, congregate living health facility |
| `hospital` | 4 | 1,380 beds | Day and night | `cdph`: general acute care hospital |
| `senior_housing` | 34 | 2,592 units | Day and night | `lahd` type `SENIORS` (16), `hud` client group `Elderly` (18) |
| `special_needs_housing` | 10 | 673 units | Day and night | `lahd` type `SPECIAL NEEDS` |
| `affordable_housing` | 35 | 1,567 units | Day and night | `lahd` and `hud`, all other types |
| `child_care` | 49 | 2,998 people | Day only | `cdss`: day care center, infant center, school-age center |
| `adult_day_care` | 6 | not known | Day only | `cdph`: adult day health care |
| `school` | 27 | 13,718 students | Day only | `cde`: public schools that are open and not online-only |

| `source` | Publisher and list | Rows kept |
|---|---|---|
| `cdss` | California Department of Social Services, Community Care Licensing facilities | 85 |
| `cdph` | California Department of Public Health, licensed and certified healthcare facilities | 21 |
| `lahd` | Los Angeles Housing Department, affordable housing projects | 52 |
| `hud` | US Department of Housing and Urban Development, assisted multifamily properties | 27 |
| `cde` | California Department of Education, public schools 2025-26 | 27 |

The web addresses of the five lists are at the top of `data/db/load_facilities.py`.

**Link to a building:** a point inside a building outline gets that building. Any other point gets the nearest
building that is not a shed or garage, when its outline is within 50 m. The 50 m limit is an assumption
(`LINK_MAX_M` in `data/db/facilities.py`). Of the 69 points outside an outline, 55 are under 5 m from one, and the
farthest is 31.5 m.

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

# care homes and nursing homes, with the building each one stands in
curl "$SUPABASE_URL/rest/v1/facilities?select=kind,name,capacity,capacity_unit,buildings(id,lat,lng,risk_score)&kind=in.(elderly_care,nursing_home)" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY"
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
- The first run also downloads the County Assessor lots (public, no key, 36 calls, about 1 minute) into
  `data/cache/assessor_hollywood/` (or `--assessor-cache <folder>`). Delete that folder to fetch again.
- The first run also downloads the fire hazard zones and the census tracts (public, no key, 2 calls) into
  `data/cache/areas_hollywood/` (or `--areas-cache <folder>`).
- The upload is an upsert. Row ids are made from the parcel and footprint, so a second run updates the same rows.
- `--apply-schema` also needs `SUPABASE_PROJECT_REF` and `SUPABASE_ACCESS_TOKEN`. Or paste `schema.sql` into the
  Supabase SQL editor.
- Another area: `--boundary <file.geojson> --cache <new folder>`. Rows from the old area stay in the tables.
- Checks: `ruff check data/db && pytest data/db`. CI does not run these (it only covers `api/` and `agent/`).

The `facilities` table has its own import. Run it after `load_supabase.py`:

```
python3 data/db/load_facilities.py --dry-run        # build rows, print counts, send nothing
python3 data/db/load_facilities.py                  # upload (a few seconds)
```

- It needs no kit and no key for the lists. It reads the Vexcel cache of `load_supabase.py` to find the building
  of each place (`--vexcel-cache <folder>` when the cache is in another place).
- The first run downloads the five lists (5 calls) into `data/cache/facilities/`. Delete that folder to fetch again.
- The upload is an upsert on `id`. It never deletes a row (problem 47).

## How each resolved value is chosen

`buildings` keeps the measured Vexcel values (`vexcel_height_m`, `vexcel_building_type`, ...), the Assessor values
of the lot (`assessor_*`), and a set of "resolved" columns that the app should use. Each resolved column has a
`*_source` column: `costar`, `assessor`, `vexcel`, `estimated` or null.

Order of trust: CoStar, then the Assessor, then Vexcel, then our own estimate.

| Column | Rule, first match wins |
|---|---|
| `height_m` | CoStar measured height; else CoStar floors x 3.3 m (`estimated`); else Vexcel height if not suspect; else null |
| `floors` | CoStar floors; else Vexcel height / 3.3, rounded, at least 1 (`estimated`); else null |
| `building_type` | CoStar property type; else the Assessor use of the lot (table below); else Vexcel's type. A shed or garage keeps Vexcel's type |
| `units` | CoStar units, split across the parcel's structures; else the homes of the Assessor lot, split across its structures; else 1 for `single_family`; else footprint x floors / 85 m2 for `multi_family`; else null |
| `est_occupants` | `units` x 2.4, always `estimated`; null when `units` is null |
| `year_built` | CoStar; else the Assessor |
| `confidence` | Mean weight of the sources of `building_type`, `height_m`, `floors`, `units` |

The Assessor has no height and no floor count, so `height_m` and `floors` still come from Vexcel for most rows.

Confidence weights: `costar` 1.0, `assessor` 0.8, `vexcel` 0.6, `estimated` 0.3, null 0.

**These numbers are assumptions, not measurements:** 3.3 m per floor, 85 m2 of floor area per unit, 2.4 people
per unit, the 3 m "suspect" limit, and the confidence weights. They are constants at the top of
`data/db/build_rows.py`. If you change one, change this table and run the import again.

**CoStar matching:** a CoStar property goes to the Vexcel parcel that contains its point. Its values go to every
structure on that parcel that is not a shed or garage. Its units are split by footprint area x height, and the
parts add up to the CoStar total. `shares_costar_property` is true when 2 or more structures got the values.

**CoStar unit count:** the sum of the property's floor plans (`models[].numUnits`); else the unit count of its
apartment listing; else hotel rooms. CoStar's `totalNumUnits` is not used (problem 36).

**Assessor matching:** an Assessor lot goes to every structure whose center is inside it. The units of a
condominium are separate lots with one shared outline, so a structure can be on many lots: their homes and
bedrooms are added up. The homes of the lot that CoStar did not already count are split, by footprint area x
height, across its structures that have no CoStar unit count and are not a shed or garage. The parts add up to
the lot total. A structure can get 0 (problem 38).

**Assessor unit count:** the sum of the 5 building slots of the tax record, when the lot is `Residential` or its
description is `Store Combination` (shops with apartments) or `Homes For Aged & Others`. On other lots the count
also covers shops and suites, so we do not use it (problem 39). A slot value of 999 is a placeholder and is left
out (problem 37). A total of 0 means "not known": the row falls back to the estimate.

**Assessor use to our type:** 2 or more homes on the lot: `multi_family`. `Residential`: `single_family` when the
description is `Single`, else `multi_family`. `Hotel & Motels`: `hotel`. `Commercial` and `Recreational`:
`commercial`. `Industrial`: `industrial`. `Institutional` and `Government`: `institutional`. Other or blank: no
type from the Assessor.

**How good the Assessor unit count is:** against the CoStar floor plans of 239 apartment properties here, it is
exactly equal on 180 and within 10% on 209. Our outline estimate is within 10% on 17. CoStar's `totalNumUnits`
is within 10% on 32.

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
| `units` is `estimated` | at most 200 units are counted (problem 26). `assessor` and `costar` counts are not capped |
| `units` is null, type `multi_family` | outline x floors / 85 m2, at least 2 units; 2 floors when `floors` is null |
| `units` is null, type is null, or `institutional` from Vexcel (a guess from a photo) | one home when outline x floors is 400 m2 or less; else as `multi_family` |
| `units` is null, type `institutional` from the Assessor or CoStar (a school, a church, a government building) | people not known: `people_at_risk` and `risk_score` are null |
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
value. The lowest value adds 0 and the highest adds the full adjustment. Rank is used because the tree columns are
not a plain share (problem 28). `roof_condition` is not used yet; its direction is known now (problem 27).

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
8. **Vexcel's building type is wrong for many "institutional" structures.** Vexcel gives this type to 4,480
   structures here. The Assessor says 3,698 of them are homes or apartments, and 340 are institutional. The
   resolved `building_type` now follows the Assessor. 24 institutional rows still rest on Vexcel's guess alone.
9. **`units` is null for 5,846 rows:** sheds and garages (2,250), commercial (1,495), institutional (1,475),
   industrial (473), hotel (97), and 56 others. Null means "people not known". The risk score must handle null,
   not treat it as zero.
10. **`est_occupants` covers homes only.** Offices, shops and hotels have no occupant estimate (day and night
    counts differ, and we did not load tenant data).
11. **Unit counts are records now, heights are still estimates.** `units_source` is `assessor` for 33,524 rows,
    `costar` for 329 and `estimated` for 547. `floors` is an estimate from the Vexcel height for 34,290 rows.
    Average `confidence` is 0.57.
12. **Shared parcels (37 CoStar properties):** every non-accessory structure on the parcel gets the CoStar floors
    and height. A tower next to a low building on one parcel both get the tower's floors. Check
    `shares_costar_property`.
13. **Contact phone numbers are fake.** CoStar replaced every phone in the kit with a 555 number. For a real call
    in the demo, add a `contacts` row with our own phone and `is_test_number = true`.
14. **2 footprints are not valid polygons** (`st_isvalid` is false). They store and draw, and some PostGIS
    functions can fail on them. Wrap with `st_makevalid` if you need area or intersection.
15. **CoStar marks no senior housing in this area.** `is_senior_housing` is false for every apartment property
    here. The Assessor does show care homes: 74 structures (448 units) are on lots described as
    `Homes For Aged & Others`. The risk score does not use this yet: it gives them the normal need rate.
    The `facilities` table now lists them by name: 27 care homes for the elderly, 11 nursing homes and 34 senior
    housing projects (problem 42).

25. **383 Vexcel heights are below zero** (lowest -4.9 m). Each one is `height_suspect` or accessory, so it is never used as `height_m`
    for a home.
26. **Some estimated unit counts are far too high.** The rule (footprint x floors / 85 m2) breaks on very large
    structures that Vexcel types as multi-family. Before the Assessor load, 34 rows had an estimated `units`
    above 200. Now 2 rows do (highest 3,271), because most rows have a real count. Cap or check estimated values
    above about 200 before you use them in a ranking.
27. **`roof_condition`: 5 is best, 1 is worst.** Vexcel's tutorial does not say it. An archived copy of the data
    dictionary of Vexcel's older API (1.0) does: 5 = great, "looks new"; 4 = good; 3 = fair; 2 = poor; 1 = bad.
    Our rows agree: a tarp is on 28.8% of grade 1 roofs, then 6.7%, 3.4%, 1.4%, and 0.4% of grade 5 roofs. The
    dictionary is for the older API, so ask the Vexcel mentors if you need to be certain.
28. **The tree and building zone values are percents that can go above 100.** The same archived dictionary gives
    the rule for the 5-foot zone: area of trees in areas A and B, divided by the area of B. B is the ring out to 5
    feet. A is drawn in a diagram that we could not see; we read it as the structure itself. That explains values
    above 100 when trees hang over the roof: `tree_density_zone1` is above 100 on 712 rows (highest 262), and
    zone 2 on 5 rows. **The zones are cumulative:** the 30-foot value counts everything within 30 feet, the 5-foot
    zone included. The risk score adds zone 1, zone 2 and the mean of zones 3 and 4 as if they were separate
    rings, so trees next to the wall count more than once. The dictionary names the zones by distance (5, 30, 100
    and 200 feet); a second Vexcel page maps them to zones 1 to 4 of the newer API. We read the first page
    ourselves, and the second only through a research summary. Compare rows with each other, and do not read a
    value as a share.
49. **`vexcel_type_confidence` does not find the wrong types.** Vexcel's "institutional" type is wrong on most
    rows (problem 8), and its median confidence there is 0.61, above the 0.55 of single homes. Do not use a low
    value as a sign that the type is wrong. Use the Assessor type (`building_type_source`).
50. **`roof_missing_material` is true on 49% of roofs, and more often on good roofs** (54% of grade 5, 39% of
    grade 1). It does not follow the roof grade. `roof_tarp` does (problem 27). `roof_structural_damage` is true
    on 18% to 31% of every grade. Treat the three defect flags other than `roof_tarp` as weak signs.

### The risk score

29. **`risk_score` does not know where the fire is.** A large apartment block far from any fire scores above a
    small house next to the fire. Before you send a unit, keep only the buildings that the fire threatens (for
    example by `fire_arrival_min`), then use `risk_score` to order them.
30. **`risk_score` is null for 3,534 rows:** commercial (1,495), institutional (1,451), industrial (473), hotel
    (97), office (14), retail (2), and 2 CoStar rows with no unit count and no outline. Null means "people not
    known", not "safe". Schools, hospitals and hotels are in this group. Postgres puts nulls first in a
    descending sort: use `order=risk_score.desc.nullslast`.
31. **The top of the ranking now rests on records.** Of the 50 highest scores, 21 use a CoStar unit count, 23 an
    Assessor count, 4 an estimated count (2 sit at the 200-unit cap), and 2 are structures of unknown use that the
    score filled in. Before the Assessor load and the CoStar fix, 38 of the 50 rested on an estimate.
32. **The order at the top depends little on the weights.** With a unit cap of 100 in place of 200, 44 of the top
    50 stay in the top 50. Each tree, roof and construction weight changes 0 to 2 of the top 50 when moved by 50%,
    because `people_at_risk` runs from 0.2 to 168 and `structure_factor` only from 0.70 to 1.81. The structure
    weights matter among buildings of the same size.
33. **`structure_factor` is a relative scale with a median of 1.36, not 1.** Compare rows with each other. Do not
    read it as a chance of burning.
34. **One-unit homes all have `people_at_risk` = 0.228** (19,364 structures). Among them only `structure_factor`
    changes the score (0.20 to 0.41).
35. **5,837 structures that are not sheds or garages score 0.** They got 0 homes in the split of a lot or a CoStar
    property (problem 38). The other structures on the lot hold the people.

### County Assessor and CoStar unit counts

36. **CoStar's `totalNumUnits` is not the number of units in the building.** The kit's model file says it counts
    the units listed on floor-plan records. Against the sum of the floor plans it is exactly equal on 6 of 239
    apartment properties here and wrong by 2x or more on 105 (typical value: 62% of the real count). Until
    2026-11-14 the import used it, so `units`, `est_occupants` and `risk_score` of CoStar rows were too low. The
    import now uses the sum of the floor plans.
37. **The tax roll has placeholder values.** Three lots in the downloaded area have 999 in a unit slot (a single home with 1 + 999
    units); the import leaves that value out. Bedroom totals of exactly 99 are probably a placeholder too; we
    store them as they are. One lot has a year built of 1822.
38. **Assessor values are for the lot, not for the structure.** About 30% of Vexcel parcels have 2 or more
    structures that can hold people. The homes of the lot are split by size, so a one-home lot with a house and a second small structure
    gives the house 1 and the other 0. Of the 5,837 structures with 0 units, 4,317 have an outline under 60 m2
    (probably garages and sheds that Vexcel typed as homes). For a count of homes or people, add up `units`, never
    `assessor_units`.
39. **Unit counts on lots that are not housing are not used.** On shop, office, hotel and industrial lots the tax
    record counts shops, suites or rooms. We do not count them: the 97 hotel
    structures have null `units`. Mixed lots described as `Store Combination` are counted, because on
    12 of 12 CoStar apartment properties on such lots the count matched the floor plans.
40. **The Assessor and CoStar disagree on about 1 property in 25.** On 10 of 239 apartment properties the two
    counts differ by 2x or more, and on 10 the Assessor has none. Several are new buildings whose lot still has
    the old use (a restaurant, a parking lot). CoStar wins in the import.
41. **Government lots are typed `institutional`.** 1,120 structures stand on lots of use type `Government`. They
    include schools and offices, and the tax record does not say which. People not known.

51. **CoStar's lot number is not always the lot under the building.** Of 252 properties that have a
    `parcel_number` and a structure on an Assessor lot, 239 have a structure whose `assessor_ain` is that number.
    The other 13 name a different lot (a property can cover several lots, and CoStar lists only some).
52. **An Assessor cache made before 2026-11-15 has no address and no floor area.** The import stops and tells you
    to delete `data/cache/assessor_hollywood/`. It does not upload empty values.

53. **`fire_hazard_zone` rates the land, and we did not check its legal status.** CAL FIRE makes the map from
    fuel, slope and weather. It says nothing about the building. The layer is CAL FIRE's map for city land dated
    2025-03-24; we did not check if the City of Los Angeles has adopted it. More than half of the structures here
    are `very_high`, so the column separates the hills from the flats and little more. The risk score does not
    use it.
54. **The tract columns describe about 4,000 people, not one building.** Every structure in a tract has the same
    three values. They come from the CDC/ATSDR Social Vulnerability Index 2022. `tract_pct_no_vehicle` is null on
    973 rows. All are in one tract, where the index has no value for it and gives 0 for the other two shares. So
    a 0 there means "no data", not "no old people". The risk score still uses one fixed need rate (0.10) for every
    building.
55. **Fire zone and tract come from the center of the structure.** A structure that crosses a line gets one side.
    We checked 40 structures against the publishers' own services and all 40 matched, for both columns.

### Facilities

42. **The risk score does not use `facilities` yet.** The 38 care homes for the elderly and nursing homes have a
    capacity of 2,407 people. The 34 buildings they stand in have a `people_at_risk` sum under 90, because the
    score treats them as normal homes, or has no people for them. 96 of the 212 rows are linked to a building with
    a null `risk_score` (67 of the 82 schools and day care places, all 4 hospitals).
43. **A place is linked to one building only.** A school or a hospital has several structures. The link goes to
    the structure under the publisher's point, or to the nearest one. Use the link to find the lot, not to say
    which structure holds the people.
44. **One building can have 2 or more rows, and one place can be in 2 lists.** 15 buildings have 2 or 3 rows, for
    example a school and its child care center, or a nursing home that is also a licensed care home. Do not add
    `capacity` over rows before you look at `kind` and `source`.
45. **`capacity` has four units, and three kinds are day only.** Read `capacity_unit`. A senior housing project
    with 100 units is not 100 people. `school`, `child_care` and `adult_day_care` are empty at night.
46. **`source_status` is not one vocabulary.** It is the publisher's value as sent. For `cdss` it is a number
    whose meaning the list does not give: 83 of 85 rows have 3, one has 4 and one has 6. `hud` sends none. One
    `lahd` row is `Development`: the project is not open yet.
47. **The import never deletes.** A place that closes stays in the table until someone deletes the row.
48. **The lists are not complete.** Private schools, senior housing with no public money, and child care in
    family homes are not in them. We also left out family homes that take foster children and agency offices.

### Differences from other parts of the project

16. **The area is smaller than the demo area.** The demo pipeline on branch `hammad_1` uses the Hollywood plan
    area plus the Sunset Fire evacuation areas (42,557 buildings). This database holds the plan area only
    (40,246). To match, run the import with that boundary (see "How to load it again").
17. **County Assessor data is loaded for units, use, year built, address and floor area** (2026-11-15). Floor
    area is stored and no rule uses it yet. The demo pipeline on branch `hammad_1` reads its own copy. The two can differ.
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
    no name. The County Assessor fills both for 40,161 rows: `assessor_address` and `assessor_ain`.
