# Master prompt: Roll Call simulation agent (phase 2: trucks + dynamic risk)

You are the engineer for the **Roll Call** demo (HackPrinceton, CoStar track). You own `explore/` on branch
`hammad_1`. Hammad (the human) wants few questions: decide, build, verify on the running page, then tell him
in plain words what you saw and measured. This file is the full hand-off from the previous agent. Read all of it.

---

## 0. Your two goals, in order

1. **Fire trucks: make them reliable and obviously right on screen.** Hammad has said several times that he
   cannot see the trucks, or that they do not do what they should. The previous agent saw them working in its
   own browser and told him to hard-refresh. That did not solve his problem. Treat every report from Hammad as
   true until you have reproduced it **on his screen setup** (see section 5). Goal: in both runs, a viewer can
   always see all 8 trucks, see each truck go to a building, stop there with its ladder up, see people leave
   faster while it is there, and see it drive on.
2. **Dynamic risk score.** Rasul built a static risk score per building (Supabase, `buildings.risk_score`).
   Use it together with **where the fire is** (distance from the fire origin and/or the fire front, and the
   fire arrival time we already have) to compute a risk score **that changes over time**. Show it on the map
   and use it in the AI matching. Details in section 6.

Then keep the demo simple, honest and fast (sections 7 and 8).

---

## 1. Read first

1. `AGENTS.md`, `CONTRACTS.md` and `DATABASE.md` **on `origin/main`** (`git show origin/main:CONTRACTS.md`). Read
   "Architecture: the six phases" (phases 3 and 4 matter most), and in DATABASE.md "How the risk score is
   computed" and known problems 19, 26–36 and 53–54.
2. On `hammad_1`: `explore/README.md`, `explore/JUDGE_SCRIPT.md`, `explore/research/DISPATCH_TODAY.md`,
   `data/README.md`, `data/BUILDING_MODEL.md` (section 0).
3. The coord log: `AGENT_NAME=hammad_1 tools/coord tail 80`.
4. PR #80 (merged into `hammad_1`) and its comment with the rule comparison table.

---

## 2. Where you work and the rules

- Repo folder `/Users/hammadfarooqi/Documents/Code/HackPrincetonF26`, **branch `hammad_1`**. Commit small and
  often, push to `origin hammad_1`. Do not open PRs to `main` or merge to `main` unless Hammad asks.
- Coordination name `hammad_1`, shared-folder mode: prefix coord commands with `AGENT_NAME=hammad_1`. Post
  `PROGRESS`/`NOTE` events when you finish something others should know.
- **This repo is public. Never commit sponsor data** (CoStar, Vexcel, Matterport, or files made from them).
  `data/demo/`, `data/processed/`, `data/cache/`, `data/costar-kit/`, `.env` are gitignored.
- **Hammad's dev server** runs on port 3001 (`cd explore && npm run dev`). It is his process: do not kill it.
  **Never run `next build` with the default build folder**: it overwrites `.next` and breaks his dev server
  (the previous agent did this once). Use `npm run demo` or `NEXT_DIST_DIR=.next-prod npx next build`, then
  `NEXT_DIST_DIR=.next-prod npx next start -p 3002`. Port 3002 = demo build.
- After a production build, `next` rewrites `explore/next-env.d.ts` and `explore/tsconfig.json`. Restore them with
  `git checkout -- explore/next-env.d.ts explore/tsconfig.json` before you commit.
- Writing style for Hammad: ASD-STE100 simple English. Short sentences, active voice, no jargon without a reason.
  Ask only questions that change what you build.

---

## 3. What exists now (all in `explore/`, branch `hammad_1`)

### Pages (Next.js 15, MapLibre GL 5)
| URL | What it is |
|---|---|
| `/sim` | The demo. Run 1 **"Today: 911 calls"** vs run 2 **"Roll Call AI"**, same fire, people, calls, trucks. Counters, dispatch feed, call transcripts, assumptions panel, comparison card at the end. |
| `/console` | The dispatcher's screen with Roll Call (CAD style): unit board, map, AI pairings with OK/Undo/Edit, live feed, priority queue, command line. |
| `/3d` | Old 3D map prototype. `/` = old 2D data viewer. Ignore both for the demo. |

### Code
| File | What it does |
|---|---|
| `lib/sim/engine.ts` | The simulation (pure, deterministic). Policies: `"calls"` (today's baseline), `"ours"` (Roll Call), `"nearest"` (old simple baseline). AI rules via `match_rule`: `"rate"` (default), `"fleet"` (Rasul's whole-fleet rule from PR #80), `"priority"`. |
| `lib/sim/graph.ts` | Road graph (OSM): Dijkstra (with fire closure at the minute the truck reaches a street, early-exit `stop`), escape routes for walkers, node fire times. |
| `lib/sim/script.ts` | Two scripted agent calls (driver declines at 0:35; supervisor reports 3 stuck tenants at Lanewood Court at 1:40). |
| `lib/sim/engine.test.ts` | Rasul's 8 tests (run with `match_rule: "fleet"`): `node --test explore/lib/sim/engine.test.ts`. |
| `app/sim/simMap.ts` | Map layers + `SimRenderer` shared by both pages: fire cells, building colors, walkers, truck markers, dashed lines, phone icons. |
| `app/sim/SimView.tsx`, `app/console/ConsoleView.tsx` | The two pages. |
| `app/3d/mapStyle.ts` | Base style (Esri imagery, AWS terrain DEM, 42,557 buildings, fire cells). |
| `app/api/sim/route.ts`, `app/api/demo/[name]/route.ts` | Serve demo data from `data/demo/` with ETag caching. |
| `scripts/run_sim.ts` | Headless run of all policies: `cd explore && node scripts/run_sim.ts [key=value ...]`. Use it for every model change. |

Debug handles in the browser (prototype only): `window.__map`, `window.__sim`, `window.__renderer`.

### The model (labeled assumptions, all in `DEFAULT_CONFIG` and the /sim assumptions panel)
- **Fire:** real Sunset Fire origin (Runyon Canyon, 8 Jan 2025), stronger wind toward Hollywood (about 130°),
  30 m grid, fast in brush, slower in built-up areas; the front stops at **Hollywood Blvd** at 3:00.
  `data/pipeline/fire_timeline.py` (env `FIRE_TARGET="lng,lat"` changes the stop point). Gives
  `fire_arrival_min` per building. Origin: `fire_timeline.json` → `origin`.
- **People:** 1,527 buildings with people in the fire's path, ~21,600 people, ~1,900 who need help
  (units × 2.4 × 0.95; need help = 10%). Evacuation order at 0:00. People who can leave alone: 15%/min.
  People who need help: 1%/min alone; 1.5 people/min with a crew on scene.
- **Walk-out deadline:** per building, the last minute a person can start walking along its street route
  (80 m/min alone, 30 m/min needing help) and stay ahead of the fire, minus 2 min. People leave and crews work
  only before it; after it, people stay and are trapped when the fire arrives. Verified in the browser:
  0 of ~37,000 walker dots on burned ground.
- **Trucks:** 8 engines from LAFD stations 6, 20, 27, 35, 41, 52, 56, 82 (south of the hills), OSM streets at
  30 km/h, streets close when the fire reaches them, crews pull out 3 min before the fire.
- **Today (policy "calls"):** 70% of buildings with people who need help call 911, 10–60 min before the fire;
  4 call-takers answer in order (2.5 min each); oldest answered call → closest free truck (search outward from
  the building, first free truck found); no re-planning; buildings that never get through get no truck.
- **Roll Call (policy "ours", rule "rate"):** for each truck–building pair,
  value = people needing help × urgency ÷ (drive min + min on scene + 1), urgency = 1 / (1 + minutes until fire / 30);
  only if the truck can arrive before the building's deadline; best pair first; re-plan every 5 min and after
  each call. It gets the same 911 calls but does not wait for them.

### Current results (`node scripts/run_sim.ts`)
| | Today (911 calls) | Roll Call |
|---|---|---|
| Trapped | 310 | 52 |

Across assumption changes (call share 40–100%, 2–10 call-takers, truck 20/45 km/h, crew speed, leaving rate,
seeds): today 280–470, Roll Call 44–136. Rasul's "fleet" rule did much worse on our data (see PR #80 comment).

### What the map shows (as of commit 291441b)
- Buildings by state (feature-state `st`): yellow = people inside, blue = everyone out, charcoal = burned
  empty, red = burned with people inside.
- Dots only for people who **left**, walking on streets away from the fire: green = 20 people (fast),
  purple = 1 person who needed help (slow).
- **Fire trucks:** HTML markers with an SVG side-view truck (58×36 px), station number, faces the way it
  drives, bumps + light bar while driving, ladder swings up when on scene and folds down when it leaves,
  grey when out of service. CSS in `TRUCK_CSS` (simMap.ts).
- Dashed line truck → building **only while the truck drives**.
- Phone icon above a building that called 911: shaking = waiting for a truck, still = truck on the way,
  gone = truck arrived.
- 3D terrain is **off by default** ("3D hills" button): it cut playback from 74 to 20 fps.

---

## 4. Lessons already learned (do not repeat)

- **Measure, do not guess.** For animation, measure sim clock vs wall time, fps, frames > 50 ms, long tasks
  (PerformanceObserver), JS heap. One screenshot proves nothing about motion.
- **Never change data-driven paint or filters every frame** on the 42k-building layer; use feature-state, set
  once per change. Small moving layers: `setData` at most ~20/s. Play loops: at most 30 updates/s.
- **3D terrain + frequent updates = slow.** Keep it off while playing.
- A fixed-tick sim driven by `requestAnimationFrame` needs its own accumulating clock.
- **Walker dots must be created the moment people leave** (any departure marks the building dirty). An earlier
  bug created them only when a rounded count changed, sometimes as the building burned.
- Approval of every AI move by a person idled trucks and trapped more people than the baseline. Default in
  /console: the AI applies, the dispatcher reviews (OK/Undo/Edit).
- **Hammad's reports beat your screenshots.** "I can't see the trucks" happened twice. Causes found so far: tiny
  markers, markers under the side panels or legend, phone icons removed too early, a stale page after the dev
  server broke. Your own browser is not his: check his port, his zoom, his window size (section 5).
- Each page holds all 42,557 buildings (~1 GB per tab). One demo page open at a time.

---

## 5. Goal 1 in detail: fire trucks you can always see and follow

Start here, before any new feature.

1. **Reproduce Hammad's view.** Ask him (one question) for: the URL and port, a screenshot, and his window
   size, OR use the Chrome tools on `http://localhost:3001/sim` with a hard reload, the default camera, and
   window sizes from 1280×720 to 1920×1080. Check the dev server answers 200 (`curl -s -o /dev/null -w
   "%{http_code}" http://localhost:3001/sim`).
2. **Check, by measurement, at several sim times in both runs:** number of `.truck` elements = 8; each one's
   bounding box is inside the visible map and **not covered** by the left card, the right panel, the legend
   or the Next.js dev badge (`document.elementFromPoint` at the truck centre must return the truck); truck
   position = `__sim.trucks[i]` position; status changes (`idle` → `en_route` → `on_scene` → ...) happen and the
   ladder class follows.
3. **Make the story readable:**
   - Camera: keep the trucks and the fire in the free part of the screen (between the panels). Consider a
     camera that frames the active trucks, or make the side panels narrower/collapsible.
   - Trucks waiting at their stations should look "parked" (not hidden), and the first dispatch should be easy
     to see.
   - On scene: ladder up, and the purple dots (1 per person) come out of that building faster; consider a
     short label above the truck ("bringing out 3") so the speed-up is obvious.
   - Show where each truck goes with the dashed line, ending at the phone icon (already done; verify).
4. **Add tests** for the "calls" policy (oldest call first, closest free truck, no re-planning, buildings that
   never call get no truck) in `engine.test.ts`, using small made-up graphs like Rasul's tests.
5. Report to Hammad with a screenshot of his exact view and the numbers you measured.

---

## 6. Goal 2 in detail: dynamic risk score from Rasul's static score + the fire's position

### What Rasul built (on `main`, merged #81, #86, #88, #90, #92)
- Supabase table `buildings` (40,246 rows, Hollywood plan area): `risk_score = people_at_risk × structure_factor`,
  `people_at_risk` (people who cannot leave without help: units × 2.4 × 0.95 × need rate, raised for walk-ups /
  no elevator), `structure_factor` (0.5–2.0: trees, close neighbours, construction, sprinklers, roof, year).
  **No fire position, no distance, no time** — that is our job. Null for commercial/institutional with unknown
  people. Weights: `data/db/risk_score.py` `WEIGHTS`; rules in DATABASE.md "How the risk score is computed".
- Newer columns: `fire_hazard_zone` (CAL FIRE), `census_tract`, `tract_pct_age65`, `tract_pct_disability`,
  `tract_pct_no_vehicle`; a `facilities` table (care homes, hospitals, senior housing, schools) linked to
  buildings; CoStar units now from floor plans; County Assessor units, use type, year built.
- **Ids do not match ours** (DATABASE.md problem 19): `buildings.id` is a UUID. Our `DemoBuilding.id` is a
  Vexcel footprint hash. Join by **location** (nearest centroid / point-in-footprint) or by `costar_id`. Areas
  differ too: 40,246 (plan area) vs 42,557 (plan area + evacuation areas); some of our buildings will have no
  score. Floor height differs (3.3 vs 3.2 m).
- **Access:** reading needs `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (server code only, never in the browser, never
  in a `NEXT_PUBLIC_` variable). **They are not in Hammad's root `.env` yet**: ask Hammad to get them from Rasul.
  REST: `GET /rest/v1/buildings?select=id,lat,lng,costar_id,risk_score,people_at_risk,structure_factor,...`,
  max 1,000 rows per request (page with `offset`/`limit` or `Range` headers). Do the join once in a pipeline
  script (e.g. `data/pipeline/join_risk.py`) and write the result into `data/demo/` (gitignored), so the browser
  never calls Supabase.

### What Hammad wants
"Use Rasul's predetermined risk scores with the **distance from the origin** to figure out **updated risk
scores over time**." So:
- `risk(b, t) = static_risk(b) × threat(b, t)`, where `threat` grows as the fire gets closer.
- Inputs you have for `threat`: distance from the fire **origin** (Hammad's words), the distance from the
  **current fire front** at time t (from `fire_cells.geojson` / the arrival grid), and `fire_arrival_min − t`
  (minutes until the fire reaches the building). Distance from the origin alone does not change over time;
  distance to the moving front and time-until-arrival do. **Propose the formula in one short message, with a
  default** (recommended: threat = 1 / (1 + max(0, fire_arrival_min − t) / τ), or a front-distance version with
  the same shape), and confirm it with Hammad before building it in. Keep every constant labeled in
  `DEFAULT_CONFIG` and the assumptions panel.
- Decide with Hammad what `people_at_risk` replaces: our 10% `need` estimate per building, or only the ranking.
  Note: the simulated people must stay the same in both runs (fair comparison).

### Where it shows up
1. **Map:** a "risk" view: building color = `risk(b, t)` (heat scale), updated by feature-state as t moves
   (only buildings whose bucket changes). Must not drop playback below ~60 fps on port 3002.
2. **AI matching** (`engine.ts`, rule "rate"): replace `needKnown × urgency` with the dynamic risk (or multiply in
   `structure_factor`), keep "÷ truck minutes" and the deadline check. Re-run `scripts/run_sim.ts` and the
   assumption sweep; report today vs Roll Call. If results get worse, say so and show why.
3. **/console priority queue:** sort by `risk(b, t)`, show static score, threat, and source (CoStar / Assessor /
   estimate / call).
4. **Judge script:** one paragraph on how the score is built and why it changes over time.

### Open conflict to know about
CONTRACTS.md (main) now says the score includes structure burn risk ("decided by Rasul"). Hammad's
BUILDING_MODEL.md argued the score should count people who cannot leave, not building burn risk. Rasul's formula
does both (people × structure factor). Do not resolve this yourself; build it so `structure_factor` can be
switched on/off in the config, and show both results.

---

## 7. Other goals (after 1 and 2)
- Simple story mode (one page: fire plays → calls appear as big chat boxes → two big bars at the end), inspired
  by the Cal Hacks "Standard Response" video (very similar idea; we must stress our building data + trucks).
- Run both policies ~50 times (wind, origin, rates, seeds) and show the spread (#55).
- Real phone call for one scripted moment (Jackson's PRs #71/#73, Telegram demo), if Hammad wants it.
- A whole-fleet version of the "rate" value using Rasul's `assignMax` (may beat both rules).

## 8. Definition of done for any change
- `npx tsc --noEmit -p explore` passes; `node --test explore/lib/sim/engine.test.ts` passes;
  `node explore/scripts/run_sim.ts` numbers reported.
- Verified on the running page (port 3001 after hard reload, and port 3002 demo build): measured fps / slow
  frames for a full run, trucks visible (section 5 checks), screenshot.
- README, JUDGE_SCRIPT and the assumptions panel match the model.
- Committed and pushed to `hammad_1`; coord `PROGRESS` posted.
- Hammad gets a short plain-English summary: what changed, what you measured, what is still open.

## 9. Decisions that are Hammad's
Deadline (#9); the dynamic-risk formula and whether `structure_factor` counts; getting the Supabase keys from
Rasul; sharing `data/demo/` with teammates outside git; what the final demo runs from (`explore/` on
`hammad_1` vs `web/` on `main`).
