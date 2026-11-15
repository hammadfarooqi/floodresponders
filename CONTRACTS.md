# CONTRACTS.md: shared interfaces for Roll Call

This file is the single source for anything two work areas share: API shapes, data models, env vars, ports.
To change it, update this file in the same PR and post an `INTERFACE` event that names who is affected.
Plan v2 (fire evacuation demo, Hollywood) replaced the first draft on 2026-11-14. `TBD` means nobody has decided yet.

## Product summary (plan v2, 2026-11-14, decided by Hammad)

Roll Call is an AI dispatcher for a wildfire evacuation. It scores buildings by **people who need help to get out**,
matches fire trucks to buildings before the fire reaches them, and keeps that matching up to date in real time.

1. **Score** each building from building data: estimated people who need help x how likely the structure is to
   burn. The fire's position is not in the score; matching adds it (changed 2026-11-14, decided by Rasul).
2. **Match** fire trucks to buildings (most at-risk buildings get nearby trucks). Re-match every few simulated minutes.
3. **Deep agent** runs the response: it takes calls from truck drivers ("I can't go there, I'm busy") and from
   building supervisors ("a tenant is stuck"), re-matches on its own, then calls everyone affected with the change.
4. **On arrival:** show the responder the building (Matterport stairs and windows, where we have them).

**Scope:** fire only, Los Angeles only (Hollywood). No floods, no Houston, no disaster, origin or severity controls.

## Demo (plan v2)

One fixed fire: the real **Sunset Fire** (8 Jan 2025, Runyon Canyon origin) with **stronger wind** blowing toward
Hollywood. The fire front reaches the middle of the Hollywood area (about Sunset Blvd) and stops there.

- **3D map** of Hollywood with hills, every real building (Vexcel outlines) extruded, camera moves per demo step.
- **Fire:** an animated orange area that grows over about 3 simulated hours; the demo run plays it in under 30 seconds
  (play, pause, speed).
- **Buildings:** all buildings in the area take part. A toggle (bottom left) highlights buildings with CoStar data.
  Only CoStar buildings have a manager phone, so only they can be called.
- **People:** dots (about 1 dot = 10 people). Green = can leave alone; a second color = needs help (seniors,
  wheelchair users), slower. People leave slowly on their own, much faster once a truck arrives, and walk away from
  the fire. People still inside when the fire reaches the building turn red. A counter shows evacuated / trapped.
- **Trucks:** 8-12 fire trucks start at real LAFD stations, drive on real streets (no traffic rules), with a dashed
  line to their assigned building. The line moves when the agent re-matches.
- **Agent moments:** a driver declines an assignment; a supervisor reports a stuck tenant. The agent re-matches and
  notifies. Transcript shown on screen.
- **Two runs:** (1) our matching, risk-aware, re-matches after calls; (2) comparison: each truck goes to the nearest
  building that needs help and never re-plans. Same fire, same people, same trucks.
- **Stretch:** run both policies about 50 times with varied wind, start points and leaving rates; show the spread.

Honesty rules for the demo: numbers come from a simulation with labeled assumptions; do not claim measured lives
saved; do not present "who was trapped" statistics that only follow from our own assumptions.

## Architecture: the six phases

The system has six phases. Each phase reads what the phases before it produce. Read this section to learn where
your work sits and what the other phases expect from it. The exact shapes are in "Data models" and "API" below.

```
Vexcel, CoStar kit, public data
        |  import once
        v
  [1] Data ----------> [2] 3D map <------- colors ------- [3] Score
        |                   ^                                 |
        |                   | trucks, routes, people          | priority per building
        |                   |                                 v
        +--------------> [5] Routing on the map <------- [4] Matching and routing
                                                              ^
                                                              | events from calls
                                                         [6] Phone call
```

| Phase | What it does | Reads | Produces | Code |
|---|---|---|---|---|
| 1. Data | Loads every building of the area one time | Vexcel API, CoStar kit, public data | Supabase tables, `DemoBuilding` | `data/` |
| 2. 3D map | Draws every building in 3D on the terrain | Outlines and heights from phase 1 | The map that phases 3 and 5 draw on | `web/` |
| 3. Score | Ranks buildings and colors them on the map | The `buildings` rows | A priority for each building (`risk_score`) | `data/db/`, `web/` |
| 4. Matching and routing | Sends each responder unit to a building, on real streets | Priorities, `RoadGraph`, `Station`, `Truck` | `[Assignment]`, a route for each unit | `api/` |
| 5. Routing on the map | Shows units, routes and people leaving, over time | Assignments, routes, simulation state | The animated run and its counters | `web/` |
| 6. Phone call | Talks to building managers and drivers, and changes the plan | The call, the current state | `AgentEvent`, then `AgentAction` | `agent/`, `api/` |

A "responder unit" is a fire truck in the demo. The same design holds for police or ambulance units.

**The loop that matters:** a call (6) produces an event, the event changes the matching (4), and the map (5) shows
the unit on its new route. Phases 1 to 3 run before the fire starts. Phases 4 to 6 repeat during the run.

### Phase 1: Data

**Goal:** all building data for the area is in our own store before the demo starts. The app never calls Vexcel
or CoStar while it runs.

- **Why import once:** the area is fixed, so the data does not change during a run. The app does not wait for a
  sponsor API, and the Vexcel rate limit only affects how long the import takes.
- **Vexcel is the list of buildings.** It has an outline for every structure. CoStar adds detail to under 1% of
  them (362 of 40,246 rows). No phase may assume that a building has CoStar data.
- **Two sets of columns.** `buildings` keeps the measured Vexcel values, and a second set of resolved values that
  the app uses (`height_m`, `floors`, `units`, `est_occupants`, `building_type`). Each resolved value has a
  `*_source` column, and each row has a `confidence` from 0 to 1.
- **Order of trust:** CoStar first, then the County Assessor, then Vexcel, then our own estimate.
- **Null means "not known".** It never means "no" or zero.
- **Not stored:** fire arrival times, assignments and call data. They depend on the run and belong to
  phases 4 to 6. The risk score is stored, because it uses building data only (phase 3).
- **Two forms today:** the Supabase tables, and the generated files in `data/demo/` that the API serves as
  `DemoBuilding`. They differ in area (40,246 and 42,557 buildings), floor height and ids. See `DATABASE.md`,
  problems 16 to 19.
- **A live sponsor call can still be right** for data that is large and needed for one building only, such as a
  photo of the building a unit is sent to. Nothing uses this yet.

### Phase 2: 3D map

**Goal:** a 3D view of the real area. Every building is its Vexcel outline, raised to `height_m`, on real terrain.

- **About 40,000 buildings.** Load the outlines one time. The Supabase REST API returns at most 1,000 rows for
  each request, so do not load them from the browser row by row.
- **Change single buildings, do not repaint all of them.** A change of the paint or filter rules on every frame was
  slow in the MapLibre prototype with 42,000 buildings. Set the state of the buildings that changed (MapLibre
  feature state).
- **Some heights are missing.** About 3,400 rows have no `height_m`. The map needs a default height for them.
- **Most buildings have no name and no address.** Vexcel gives a location and an outline only. A building detail
  panel must work without them.
- **The map is the base for phases 3 and 5.** Colors, units, routes and people are layers on this map. They must
  not need a second map.
- `SUPABASE_SECRET_KEY` is never used in `web/`. The web app reads through the API.

### Phase 3: Score

**Goal:** one priority for each building, shown as a color on the map, so a person can see where help is needed.

- **The score uses building data only:** `risk_score` = `people_at_risk` x `structure_factor`. It has no fire
  position, no fire arrival time and no distance to a unit. Decided by Rasul on 2026-11-14: we have no fire
  arrival time that we trust enough to build the score on, and distance belongs to matching.
- **So the score does not say which buildings a fire threatens.** A large block far from the fire scores above a
  small house next to it. Phase 4 must add `fire_arrival_min` and travel time before it sends a unit.
- **`people_at_risk`** is the estimated number of people who cannot leave without help: units x people for each
  unit x share who need help, raised for upper floors with no elevator.
- **`structure_factor`** (0.5 to 2.0) is higher when the structure is more likely to burn: tree cover near it,
  close neighbor buildings, wood frame. It is lower for concrete or steel, sprinklers and a paved lot. This
  replaces the earlier rule that roof, tree and construction fields are not part of the priority.
- **It is computed once, in the import, and stored** in `buildings` (`risk_score`, `people_at_risk`,
  `structure_factor`). Code: `data/db/risk_score.py`. It does not change during a run.
- **Every weight is in `WEIGHTS`** in that file and is listed in `DATABASE.md`. All are first guesses that nobody
  has checked against a real fire yet. Do not put a second copy of a weight in other code.
- **Missing values.** A value that is not known takes the typical value for the building type; it never makes
  the score zero. Sheds and garages (`is_accessory`) score 0. Commercial, industrial, hotel and
  institutional structures (schools, hospitals, government) have a null `risk_score`, because nobody has an
  estimate of the people inside. Sort with nulls last.
- **Show confidence with the score.** Most occupant numbers are estimates. "High priority, low confidence" is a
  correct result, and a call (phase 6) is how the system learns more about that building.
- **Flags for the responder.** These exist on CoStar rows only: `floors`, `is_walkup`, `passenger_elevators`,
  `has_sprinklers`, `construction_material`. `year_built` and the use of the lot (`assessor_use_description`:
  school, hospital, care home, hotel) come from the County Assessor for most rows. Fire escapes, stairwells and
  exits are not in the database. Matterport has interior data for under 1% of buildings.

### Phase 4: Matching and routing

**Goal:** decide which unit goes to which building, and the streets it uses. Decide again when something changes.

- **Matching:** `match(state, policy) -> [Assignment]`. Policy `"ours"` uses the phase 3 priority and the travel
  time. Policy `"nearest"` is the comparison. Both are pure functions over the same state.
- **Routing:** the shortest path on `RoadGraph` from the unit to `building_node` of the building. Units start at
  `Station.node`. The graph is undirected, because responders ignore one-way rules.
- **The fire closes streets.** A unit may use an edge only if it finishes crossing the edge before `fire_min`.
  Check the minute the unit reaches the edge, not the minute it leaves. A route that was valid can become
  invalid, so travel times change during the run.
- **Input from phase 3, per building:** `building_id`, `priority` (building only: it must not include distance or
  travel time, because matching adds those), `people_need_help` (estimate, or the number a call confirmed), and
  `fire_arrival_min`. In the database, `priority` is `risk_score` and the estimate of `people_need_help` is
  `people_at_risk`. `fire_arrival_min` comes from the fire timeline, not from phase 3.
- **Policy `"ours"` matches the whole fleet at once,** not one building at a time. The value of a unit-building
  pair is the number of people that crew can help between arrival and `withdraw_before_fire_min`, with the road
  ETA. A second unit at the same building counts only the extra people it can help. A unit may stay idle.
- **Order of checks for each pair:** (1) a route exists that avoids closed streets; (2) the real ETA meets the fire
  deadline; (3) only then add the small bonus that keeps a unit on its current building. Do not cut the list to
  the top N buildings before you check (1) and (2).
- **No building is ignored.** If no unit can reach a building in time, flag it. After the main match, a unit that
  would stay idle goes to the flagged building with the highest priority, by a safe route. The log calls this a
  check, not a rescue, and the simulation does not count it as one.
- **When to match again:** every `rematch_every_min` simulated minutes, and after each `AgentEvent` from phase 6.
  A unit that is already on the road can get a new building.
- **Each assignment has a `reason`.** Phase 5 shows it, and phase 6 says it on the phone.
- **Matching has no state of its own.** The caller sends the full state each time. This keeps the two demo runs
  fair and makes the result easy to test.

### Phase 5: Routing on the map

**Goal:** show the run over time on the phase 2 map: the fire, the units on their routes, and the people.

- **The simulation runs in the browser.** It owns the clock, the unit positions and the people counts. The API
  serves data and runs matching and the agent.
- **Time:** about 180 simulated minutes play in under 30 seconds, with play, pause and speed.
- **Units** move along the phase 4 route, with a dashed line to the assigned building. The line moves when the
  assignment changes.
- **People** are dots. They leave slowly without help and faster when a unit is on scene. People still inside
  when the fire arrives count as trapped.
- **Same seed, same run.** The simulation is deterministic for one `seed`, so the two policies are compared on the
  same fire, people and units.
- **Call results must be visible.** When phase 6 changes an assignment, the map shows the change and the
  transcript panel shows why.
- **Honesty rules** from the "Demo" section apply to every number on screen.

### Phase 6: Phone call

**Goal:** the agent speaks for the dispatcher on the phone, learns what the data cannot tell us, and changes the
plan.

- **Who is on the call:** building managers and supervisors, and the drivers of the units. In the demo these are
  our own phones and voices.
- **Why it exists:** occupant numbers are estimates. A manager knows if a tenant is stuck or if the building is
  already empty. A driver knows if the unit cannot go.
- **Only CoStar buildings can be called,** because only they have a manager contact. Every phone number in the
  CoStar kit is fake. A real call needs a `contacts` row with our own number and `is_test_number = true`.
  Never commit a real phone number.
- **The call produces an event, and the agent does not edit the plan directly.**
  `handle_event(state, event)` returns `AgentAction`s: a `rematch` from phase 4, and `notify` messages to the
  people affected.
- **Events:** `driver_declines`, `tenant_stuck` and `building_cleared`. A `building_cleared` report with
  `people_remaining: 0` removes the building from the queue, and the unit sent there is matched again at once,
  from where it is now. A report with `people_remaining > 0` sets the number still needing help. For the
  hackathon we trust the report.
- **Voice is a separate layer.** The conversation logic must work with text in and text out, so that a real phone
  call, a voice in the browser and a simulated manager all use the same code. The provider is TBD.
- **Call data is personal.** Keep it in memory only and delete it when the simulation is reset.

### Rules that apply to every phase

- **One building id through the whole run.** Phases 2 to 6 use `DemoBuilding.id`. Database row ids are different
  (`DATABASE.md`, problem 19).
- **Earlier phases do not depend on later ones.** The map and the score work with no calls and no units.
- **Assumptions have one home:** `SimConfig` for the simulation, the constants in `data/db/build_rows.py` for the
  import, `WEIGHTS` in `data/db/risk_score.py` for the risk score.
- **Estimates stay labeled** from the database to the screen (`*_source`, `confidence`).
- **This repo is public.** No sponsor data, no real phone numbers and no keys in any commit.

## Stack

| Part | Choice |
|---|---|
| `web/` | Next.js + TypeScript. Map: MapLibre GL JS + deck.gl, with free terrain tiles (no account needed). This replaces CesiumJS from #33 if the prototype holds up (see the map issue) |
| `api/` | Python, FastAPI, Pydantic models, pytest, ruff |
| `agent/` | Python, LangChain Deep Agents (`deepagents` package). LLM provider: TBD |
| Voice or phone for the call | TBD (human decision) |
| Storage | Supabase: hosted Postgres with PostGIS, project `Responder0`, region us-east-1. Building tables are loaded (see "Database" below and `DATABASE.md`). Code that reads the JSON files in `data/demo/` keeps working; moving it to Supabase is a separate step |
| Hosting | TBD. Local demo is the default |

## Data sources

Sponsor data comes from CoStar Group (CoStar, Vexcel, Matterport). We have access to all three (tested
2026-11-14): Matterport and Vexcel by API, CoStar as a local data kit. They cover Houston and Los Angeles only.
The exploration work (probes, pipeline, maps) lives on branch `hammad_1` (`data/README.md` there). Decisions are in the coord log.

| Source | Fields it gives | Coverage in Hollywood (42,557 buildings) |
|---|---|---|
| Vexcel | building outline, ground elevation, building type, roof | ~100% |
| LA County Assessor (public) | use, units, bedrooms, floor area, year built | 92-99% |
| CoStar | stories, units, walk-up, elevators, senior housing, construction material, **manager contact** | 0.7% (275 buildings) |
| Matterport | stairs, windows, doors inside the building | <1% |
| OpenStreetMap (public) | streets for truck routes, evacuation area edges | 100% |
| LAFD stations (public) | truck start points | - |
| Phone calls (agent) | who needs help, driver availability | live |

Facts about the sponsor data that every area should know (details and more in `DATABASE.md`):

- **The CoStar kit is a fixed list, not the whole city:** 3,339 commercial properties (2,765 are apartment
  communities) and 1,867 homes, across Houston and Los Angeles. A building that is not on the list has no CoStar data.
- **Every phone number and email in the CoStar kit is fake** (555 numbers). The agent cannot reach a real manager
  with them. Real calls in the demo go to our own phones.
- **A missing CoStar value means "not known", not "no".** For example, sprinklers are known for about 1 in 5 properties.
- **CoStar amenity lists are ids with no name table** in the kit, so we cannot use them.
- **Vexcel describes shapes, not addresses.** It gives an outline, ground elevation, roof and a type guess for every
  structure, and no address, name or parcel number. Its computed height is noisy.
- **Vexcel is fast for whole areas:** one call returns up to 500 parcels, and the Hollywood plan area took 129 calls.

**This repo is public.** Never commit files that contain CoStar, Vexcel or Matterport data, or files made from them.
Demo data is generated on each machine by the pipeline (needs the keys and the CoStar kit), or loaded from Supabase.

## Data models (plan v2, draft)

JSON field names are `snake_case`. Demo data files live in `data/demo/` (gitignored, generated).

```
DemoBuilding {                       # data/demo/buildings.json
  id: string
  lat: number, lng: number
  footprint: [[lng, lat], ...]
  height_m: number                   # CoStar stories x 3.2, else Assessor floor area / footprint, else type default
  ground_elevation_m: number         # Vexcel
  use: "residential" | "commercial" | "other" | "none"   # "none" = shed, garage: no people
  units: int | null                  # CoStar, else Assessor
  people_est: int                    # units x household_size x (1 - vacancy)
  people_need_help_est: int          # people_est x need_rate
  fire_arrival_min: number | null    # from the fire timeline; null = fire never arrives
  costar: null | {                   # only for CoStar buildings
    id: string, name: string, address: string, stories: int | null, units: int | null,
    is_walkup: bool | null, elevators: int | null, is_senior: bool,
    manager: { company: string | null, phone: string | null }
  }
  matterport_ids: [string]
}

FireTimeline {                       # data/demo/fire_timeline.json
  origin: [lng, lat]
  wind_from_deg: number
  step_min: number                   # e.g. 2
  fronts: [GeoJSON Polygon]          # burned area at each step
}

Station { id: string, name: string, number: int, lat: number, lng: number,
          node: int }                # nearest road node    # data/demo/stations.json (OSM): 11 LAFD stations
RoadGraph {                          # data/demo/roads.json (OSM, ODbL). Undirected: trucks ignore one-way rules
  nodes: [[lng, lat]]
  edges: [[from, to, meters, fire_min]]   # fire_min: minute the fire closes this edge, or null
  building_node: { building_id: node }    # nearest road node for every DemoBuilding
}

Truck {
  id: string, station_id: string
  lat: number, lng: number
  status: "idle" | "en_route" | "on_scene" | "unavailable"
  building_id: string | null
}

Assignment { truck_id: string, building_id: string, eta_min: number, reason: string }

SimConfig {                          # all assumptions in one place, shown in the UI
  household_size: 2.4, default_vacancy: 0.05, need_rate: 0.10,
  self_evac_rate_per_min: number, assisted_evac_rate_per_min: number,
  rematch_every_min: 5, truck_speed_kmh: 40, seed: int
}

AgentEvent =
  | { type: "driver_declines", truck_id, building_id, reason }
  | { type: "tenant_stuck", building_id, count, note }
  | { type: "building_cleared", building_id, people_remaining: int, note }   # 0 = everyone who needs help is out
AgentAction =
  | { type: "rematch", assignments: [Assignment] }
  | { type: "notify", to: "truck" | "supervisor", id: string, message: string }
```

Matching: `match(state, policy) -> [Assignment]`, with `policy` = `"ours"` (risk-aware: the phase 3 priority, the fire deadline
and travel time, re-match allowed) or `"nearest"` (comparison: nearest building that needs help, no re-plan).
Both are pure functions over the same state, so the two runs are fair.

Call data holds personal information. Keep it in memory only and delete it when the simulation is reset.

## API (plan v2, draft)

Base path `/api`. JSON in and out. The web app reads the base URL from `NEXT_PUBLIC_API_URL`. The simulation runs
in the browser; the API serves data and runs matching and the agent.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/health` | | `{ "status": "ok" }` |
| `GET /api/demo/buildings` | | `{ "buildings": [DemoBuilding] }` |
| `GET /api/demo/fire` | | `FireTimeline` |
| `GET /api/demo/stations` | | `{ "stations": [Station] }` |
| `GET /api/demo/roads` | | `RoadGraph` |
| `POST /api/match` | `{ state, policy }` | `{ "assignments": [Assignment] }` |
| `POST /api/agent/event` | `{ state, event: AgentEvent }` | `{ "actions": [AgentAction], "transcript": [...] }` |

Errors: HTTP status plus `{ "detail": string }` (the FastAPI default).

## Database (Supabase)

Schema: `data/db/schema.sql`. Import: `data/db/load_supabase.py`. **Read `DATABASE.md` before you use the
database:** it lists how each value is chosen and the known data problems.

| Table or view | One row is | Key columns |
|---|---|---|
| `buildings` (40,246) | One Vexcel structure in the Hollywood plan area, or a CoStar property with no structure | `id`, `lat`, `lng`, `footprint`, `height_m`, `floors`, `units`, `est_occupants`, `building_type`, each with a `*_source`; `costar_id`, `confidence`, `is_accessory`, `height_suspect`; `risk_score`, `people_at_risk`, `structure_factor`; `assessor_ain`, `assessor_use_type`, `assessor_use_description`, `assessor_units`, `assessor_address` (street address for 40,161 rows) |
| `costar_properties` (300) | One CoStar property, with CoStar's own values | `costar_id`, `name`, `address`, `floors`, `total_units`, `is_walkup`, `passenger_elevators`, `matterport_model_ids` |
| `contacts` (436) | Site office or property manager of a CoStar property | `costar_id`, `role`, `company_name`, `phone`, `is_test_number` |
| `facilities` (212) | One care home, nursing home, hospital, senior or affordable housing project, or school, from public lists | `kind`, `name`, `address`, `capacity`, `capacity_unit`, `lat`, `lng`, `building_id` (link to `buildings.id`), `building_distance_m` |
| `buildings_geojson` | `buildings` plus `footprint_geojson` | Use this to draw outlines |
| `buildings_near(p_lat, p_lng, radius_m)` | Function: buildings near a point, nearest first | |

Row security is on with no rules: only `SUPABASE_SECRET_KEY` (server code) can read or write.
`DemoBuilding` above is still the shape the API serves. `DATABASE.md` lists where the database differs from it
(area, floor height).

## Agent interface (draft)

`agent/` is a Python package named `rollcall_agent`. The API installs it with `pip install -e ../agent`.

```
handle_event(state: dict, event: dict) -> dict
# returns { "actions": [AgentAction], "transcript": [...] }. Tools: match(), notify_truck(), notify_supervisor(),
# bump_building(). run_manager_call() from #17 becomes the supervisor-call tool.
```

How the manager side of the call is produced (real phone call, voice in the browser, or simulated text) is TBD.

## Env vars

| Name | Used by | Meaning |
|---|---|---|
| `AGENT_NAME` | tools/coord | Your agent name, for example `rasul_1`. Needed only in shared folder mode. Otherwise coord reads it from your folder |
| `PORT` | web | Dev server port. `3000 + X`, X is the number in your agent name |
| `API_PORT` | api | Dev server port. `8000 + X` |
| `NEXT_PUBLIC_API_URL` | web | API base URL, for example `http://localhost:8001` |
| `SUPABASE_URL` | api, data | Supabase project URL. Ask Rasul for the value |
| `SUPABASE_SECRET_KEY` | api, data | Full read and write access, skips row security. Server code and import scripts only. Never in `web/`, never in a `NEXT_PUBLIC_` variable |
| `SUPABASE_PUBLISHABLE_KEY` | web (later) | Key that is safe in a browser. It can read a table only after that table has a row security rule. Not needed while the web app reads through the API |
| `SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN` | data | Only for `data/db/load_supabase.py --apply-schema` (it runs `schema.sql`). The access token has full account access: `.env` only |
| LLM provider key | agent | TBD, name depends on the provider |
| Voice or phone provider keys | agent | TBD |
| `MATTERPORT_API_KEY`, `MATTERPORT_API_TOKEN`, `MATTERPORT_SDK_KEY`, `VEXCEL_API_KEY`, `COSTAR_KIT_ZIP_PASSWORD` | data | Sponsor keys, in the root `.env`. CoStar data is a local kit at `data/costar-kit/`, not an API. Probes and pipeline: branch `hammad_1`, `data/README.md` |
| Map token | web | TBD, only if the map library needs one |

Never commit secrets. This repo is public. Use a local `.env` file. `.env*` is in `.gitignore`. Each area keeps a `.env.example`
with names only.

## File layout

```
web/      Next.js app
api/      FastAPI app, package `app`, tests in api/tests, deps in api/requirements.txt
agent/    package `rollcall_agent`, tests in agent/tests, deps in agent/requirements.txt
data/     pipeline scripts (branch hammad_1 for now); data/demo/ = generated demo files, gitignored
          data/db/ = Supabase schema and import script (see DATABASE.md)
tools/    coord, coord_smoke.sh
```
