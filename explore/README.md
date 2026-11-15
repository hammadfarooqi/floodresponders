# explore/: Roll Call demo pages (branch hammad_1)

`npm install && npm run dev` → http://localhost:3001. Needs the generated `data/demo/` files (see `data/README.md`;
gitignored, sponsor data).

| Page | What it is |
|---|---|
| `/sim` | Two runs on the same fire, people and 8 trucks: 1 = old way (nearest building that needs help, never re-plans), 2 = Roll Call AI (each truck goes where it helps the most people per minute: people needing help × urgency ÷ (drive + time on scene), only if it arrives before the fire, re-plans every 5 min and after calls). Counters, dispatch feed, scripted agent calls, assumptions, comparison card. |
| `/console` | The dispatcher's screen with Roll Call: unit status board, map, AI pairings (mode "AI applies, I review": OK / Undo / Edit unit; mode "I approve each": Approve / Reject / Edit), live feed of calls and pairing changes, priority queue, command line (`E27 out 20`, `E27 back`, `hold E35`, `release E35`, `send E41 to Lanewood`, `stuck 2 at Franklin Plaza`). Keys: A = OK/approve, R = undo/reject, space = play. |
| `/3d` | The 3D map prototype (fire playback, evacuation areas, CoStar toggle). |
| `/` | 2D layer explorer. |

Code: `lib/sim/engine.ts` (pure, deterministic simulation; trucks routed on the OSM road graph), `lib/sim/script.ts`
(the two scripted agent moments), `app/sim/simMap.ts` (map layers shared by both pages).
Headless: `node scripts/run_sim.ts [key=value ...]` runs both strategies, e.g. `assisted_people_per_min=3`.
Research behind the console: `research/DISPATCH_TODAY.md`.

Result with default assumptions (fire stops at Hollywood Blvd): old way 193 trapped, AI 32 (84% fewer). The AI is
better under each single assumption change we tried (crew speed, truck speed 20–45 km/h, leaving rates, urgency
scale, re-match interval). Simulated; not a count of real lives.

Demo mode (lighter and faster than dev): `npm run demo` → http://localhost:3002 (builds into `.next-prod`, so it
does not disturb a running `npm run dev`). Open one page at a time: each page holds all 42,557 buildings (~1 GB).
