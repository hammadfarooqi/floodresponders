# explore/: Roll Call demo pages (branch hammad_1)

`npm install && npm run dev` → http://localhost:3001. Needs the generated `data/demo/` files (see `data/README.md`;
gitignored, sponsor data).

| Page | What it is |
|---|---|
| `/sim` | Two runs on the same fire, people, 911 calls and 8 trucks: 1 = today (trucks go only to answered 911 calls, oldest call first, closest free truck, no re-planning; red 📞 = waiting), 2 = Roll Call AI (each truck goes where it helps the most people per minute: people needing help × urgency ÷ (drive + time on scene), only if it can arrive while people can still walk out; re-plans every 5 min and after calls). |
| `/console` | The dispatcher's screen with Roll Call: unit status board, map, AI pairings (mode "AI applies, I review": OK / Undo / Edit unit; mode "I approve each": Approve / Reject / Edit), live feed of calls and pairing changes, priority queue, command line (`E27 out 20`, `E27 back`, `hold E35`, `release E35`, `send E41 to Lanewood`, `stuck 2 at Franklin Plaza`). Keys: A = OK/approve, R = undo/reject, space = play. |
| `/3d` | The 3D map prototype (fire playback, evacuation areas, CoStar toggle). |
| `/risk` | Building risk for a fire origin that you set. Press "Create fire origin", click the map, and pick a wind direction. Each building's stored `risk_score` is multiplied by a fire factor: x2 at the origin, down toward x1 with distance, a slight oval downwind. The map shows the 1,000 highest scores and the list shows each building's rank before the fire. Reads Supabase through `app/api/fire-risk` (server only): it needs `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in the `.env` file at the repo root or in `explore/.env.local`. It does not use `data/demo/` and does not change the fire of `/sim` and `/console`. The rule is in `data/db/fire_risk.py` on `main`. |
| `/` | 2D layer explorer. |

Code: `lib/sim/engine.ts` (pure, deterministic simulation; trucks routed on the OSM road graph), `lib/sim/script.ts`
(the two scripted agent moments), `app/sim/simMap.ts` (map layers shared by both pages).
Headless: `node scripts/run_sim.ts [key=value ...]` runs both strategies, e.g. `assisted_people_per_min=3`.
Research behind the console: `research/DISPATCH_TODAY.md`.

Result with default assumptions (fire stops at Hollywood Blvd): today's 911 dispatch 310 trapped, Roll Call 52
(83% fewer). Across the assumption changes we tried (call share 40–100%, 2–10 call-takers, truck speed, crew speed,
leaving rates, seeds) today traps 280–470 and Roll Call 44–136. Simulated; not a count of real lives.
People leave only while they can still walk to safety ahead of the fire (per building, along the street route), so
no dot walks through the fire. Other baselines: `match_rule`/policy "nearest" (nearest building first, 239 trapped).

Demo mode (lighter and faster than dev): `npm run demo` → http://localhost:3002 (builds into `.next-prod`, so it
does not disturb a running `npm run dev`). Open one page at a time: each page holds all 42,557 buildings (~1 GB).
