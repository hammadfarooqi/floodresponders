# explore/: Roll Call demo pages (branch hammad_1)

`npm install && npm run dev` → http://localhost:3001. Needs the generated `data/demo/` files (see `data/README.md`;
gitignored, sponsor data).

| Page | What it is |
|---|---|
| `/sim` | Two runs on the same fire, people, 911 calls and 8 trucks: 1 = today (trucks go only to answered 911 calls, oldest call first, closest free truck, no re-planning; red 📞 = waiting), 2 = Roll Call AI (each truck goes where it helps the most per minute: dynamic risk ÷ (drive + time on scene), only if it can arrive while people can still walk out; re-plans every 5 min and after calls). "risk view" colors buildings by the dynamic risk; "follow trucks" keeps all 8 trucks in view. |
| `/console` | The dispatcher's screen with Roll Call: unit status board, map, AI pairings (mode "AI applies, I review": OK / Undo / Edit unit; mode "I approve each": Approve / Reject / Edit), live feed of calls and pairing changes, priority queue, command line (`E27 out 20`, `E27 back`, `hold E35`, `release E35`, `send E41 to Lanewood`, `stuck 2 at Franklin Plaza`). Keys: A = OK/approve, R = undo/reject, space = play. |
| `/3d` | The 3D map prototype (fire playback, evacuation areas, CoStar toggle). |
| `/risk` | Building risk for a fire origin that you set. Press "Create fire origin", click the map, and pick a wind direction. Each building's stored `risk_score` is multiplied by a fire factor: x2 at the origin, down toward x1 with distance, a slight oval downwind. The map shows the 1,000 highest scores and the list shows each building's rank before the fire. Reads Supabase through `app/api/fire-risk` (server only): it needs `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in the `.env` file at the repo root or in `explore/.env.local`. It does not use `data/demo/` and does not change the fire of `/sim` and `/console`. The rule is in `data/db/fire_risk.py` on `main`. |
| `/` | 2D layer explorer. |

Code: `lib/sim/engine.ts` (pure, deterministic simulation; trucks routed on the OSM road graph), `lib/sim/script.ts`
(the two scripted agent moments), `app/sim/simMap.ts` (map layers shared by both pages).
Headless: `node scripts/run_sim.ts [key=value ...]` runs both strategies, e.g. `assisted_people_per_min=3`.
Research behind the console: `research/DISPATCH_TODAY.md`.

**Dynamic risk score** (AI ranking): `risk(b, t) = people(b) × threat(b, t)`. `people` = Rasul's `people_at_risk`
(Supabase, from CoStar / County Assessor units), until a call gives the real count. `threat = 1 + 9 × urgency`,
urgency = 1 / (1 + minutes until the fire / 30): 1 when the fire is far, up to 10 when it arrives. Rasul's
`structure_factor` is off by default (`risk_structure=true` turns it on). Ranking only: the simulated people are the
same in both runs. Data: `python3 data/pipeline/join_risk.py` joins Supabase to our buildings by location (nearest
centroid within 10 m; 1,488 of 1,527 sim buildings get a score) and writes `data/demo/risk_join.json`. The engine
method `riskScores()` lists all buildings by risk (meant as a tool for the deep agent).

**People leave more slowly from high-risk buildings** (`leave_by_risk`, both runs): the two leaving rates are
multiplied by a factor from the building's rank in Rasul's static `risk_score`: lowest rank 1.5x faster, middle 1x,
highest 3x slower (`leave_fast_low`, `leave_slow_high`). Buildings with no score keep the base rates.

**Fire speed and leaving speed.** `FIRE_SPEED=0.7` (in `data/pipeline/fire_timeline.py`, with
`FIRE_TARGET="-118.335,34.1016"`): the spread rate is 0.7x the rate that would reach Hollywood Blvd at 3:00, so the
front moves 1.6 km/h in brush and reaches 1,124 buildings (9,053 people, 764 who need help) by 3:00, 670 acres.
People leave faster than before: 30%/min of those who can leave alone, 3%/min of those who need help, high-risk
buildings up to 2x slower. Chosen together so many people evacuate and the toll stays in the tens.
Regenerate: `FIRE_TARGET=... FIRE_SPEED=0.7 python3 data/pipeline/fire_timeline.py` then
`python3.12 data/pipeline/roads_stations.py`. The stuck-tenants call picks a building this fire reaches
(`lib/sim/script.ts`; now 1865 N Fuller Apartments). The two scripted calls come early (0:06 stuck tenants,
0:12 driver declines), because with this fire Roll Call reaches every building by about 0:25. Backup of the faster fire: `data/demo/backup_fire_speed_1.0/`.

Result with default assumptions: today's 911 dispatch 41 trapped, Roll Call 6 (86% fewer). 87 calls; median wait
for a call-taker 21 min. Across assumption changes today traps 27-71 and Roll Call 4-7.
911 calls come 1-15 min after the fire starts (`call_after_start_min`; null = the old 10-60 min before the fire). Other settings:
speed 0.4 with the old leaving rates: 35 vs 4 (only 2,295 people); speed 1.0 with fast leaving: 86 vs 22. The numbers below this line were measured with the old,
faster fire and `leave_by_risk=false`. Across assumption changes (seeds, truck 20/45 km/h, crew speed, call share 40%, 10 call-takers, leaving
rate, slow-down 1.5–3x) today traps 419–909 and Roll Call 94–407. Ranking choices on the default run (Roll Call trapped): our 10%
estimate × urgency 52, Rasul's people × urgency 60, Rasul's people × threat k=9 (default) 67, k=1 (max 2×) 100.
In this sim the true people count IS our 10% estimate, so Rasul's counts cannot look better here; that is a limit of
the test, not proof his counts are worse. Simulated; not a count of real lives.
People leave only while they can still walk to safety ahead of the fire (per building, along the street route), so
no dot walks through the fire. Other baselines: `match_rule`/policy "nearest" (nearest building first, 239 trapped).

Demo mode (lighter and faster than dev): `npm run demo` → http://localhost:3002 (builds into `.next-prod`, so it
does not disturb a running `npm run dev`). Open one page at a time: each page holds all 42,557 buildings (~1 GB).
