# explore/: Roll Call demo pages (branch hammad_1)

`npm install && npm run dev` → http://localhost:3001. Needs the generated `data/demo/` files (see `data/README.md`;
gitignored, sponsor data).

| Page | What it is |
|---|---|
| `/sim` | Two runs on the same fire, people and 8 trucks: 1 = old way (nearest building that needs help, never re-plans), 2 = Roll Call AI (each truck goes where it helps the most people per minute: people needing help × urgency ÷ (drive + time on scene), only if it arrives before the fire, re-plans every 5 min and after calls). Counters, dispatch feed, scripted agent calls, assumptions, comparison card. |
| `/console` | The dispatcher's screen with Roll Call: unit status board, map, AI pairings (mode "AI applies, I review": OK / Undo / Edit unit; mode "I approve each": Approve / Reject / Edit), live feed of calls and pairing changes, priority queue, command line (`E27 out 20`, `E27 back`, `hold E35`, `release E35`, `send E41 to Lanewood`, `stuck 2 at Franklin Plaza`). Keys: A = OK/approve, R = undo/reject, space = play. |
| `/3d` | The 3D map prototype (fire playback, evacuation areas, CoStar toggle). |
| `/interior` | Interior layouts: every property with a usable Matterport scan. Floor plan of one scanned apartment, a green search route from the entrance to each bedroom, and the 3D tour. `/console` opens the same panel from a building card ("See interior layout"). Needs `python3 data/pipeline/interior_layouts.py` (see below). |
| `/` | 2D layer explorer. |

Code: `lib/sim/engine.ts` (pure, deterministic simulation; trucks routed on the OSM road graph), `lib/sim/script.ts`
(the two scripted agent moments), `app/sim/simMap.ts` (map layers shared by both pages).
Headless: `node scripts/run_sim.ts [key=value ...]` runs both strategies, e.g. `assisted_people_per_min=3`.
Research behind the console: `research/DISPATCH_TODAY.md`.

Interior layouts: `data/pipeline/interior_layouts.py` writes `data/demo/interiors_index.json` and `interiors.json`
(gitignored, sponsor data). Without them the console works as before and no building offers a layout. Route logic:
`lib/interior/route.ts` (entrance guess, then each bedroom, nearest first); tests: `node --test lib/interior/route.test.ts`.
The scans are leasing tours of sample apartments: the plan is a typical apartment of the building, not a known unit,
and the scans do not cover hallways or stairs. Only rooms that Matterport labels "Bedroom" are on the route.

Route inside the 3D tour: run `explore/scripts/get_matterport_bundle.sh` once, then start the dev server again. The
script downloads Matterport's viewer ("SDK Bundle", 27 MB, not in git) into `public/matterport-bundle/` and copies
`MATTERPORT_SDK_KEY` from the root `.env` into `explore/.env.local`. The "3D tour" tab then draws the route as a green
line on the floor, with a numbered sign at each bedroom (`app/interior/Tour3D.tsx`). The camera then walks along the
line with no clicks: from the entrance to each bedroom, one full turn in each bedroom, and then again from the start.
Without the bundle or the key, the tab shows the plain public tour with no line and no walk. Our key works on localhost with scans of other accounts (checked
2026-11-14); another host name must be added to the key in the Matterport account first.

Result with default assumptions (fire stops at Hollywood Blvd): old way 193 trapped, AI 32 (84% fewer). The AI is
better under each single assumption change we tried (crew speed, truck speed 20–45 km/h, leaving rates, urgency
scale, re-match interval). Simulated; not a count of real lives.

Demo mode (lighter and faster than dev): `npm run demo` → http://localhost:3002 (builds into `.next-prod`, so it
does not disturb a running `npm run dev`). Open one page at a time: each page holds all 42,557 buildings (~1 GB).
