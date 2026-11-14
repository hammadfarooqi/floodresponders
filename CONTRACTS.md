# CONTRACTS.md: shared interfaces for Roll Call

This file is the single source for anything two work areas share: API shapes, data models, env vars, ports.
To change it, update this file in the same PR and post an `INTERFACE` event that names who is affected.
Everything here is a first draft from the project description. `TBD` means nobody has decided yet.

## Product summary

Roll Call helps responders during fires and floods.

1. **Risk score** for each building: exposure x difficulty of evacuation x how soon the hazard arrives.
2. **Priority queue:** at-risk buildings go to nearby responder units in priority order, one responder per building.
3. **AI calling agent:** calls the building manager, says which responder it acts for, asks who needs help
   to evacuate, and moves the building up the queue based on the answer.
4. **Unit directions:** once a unit is flagged, show the nearest usable stairwell or a window a ladder can reach.

**Demo:** the user picks a disaster type (fire or flood), a point of origin (N, NE, E, SE, S, SW, W, NW), and
a severity from 1 to 5. Then they click a building in a sample city of made-up buildings and have the agent
call its manager.

## Stack

| Part | Choice |
|---|---|
| `web/` | Next.js + TypeScript. Map library: TBD |
| `api/` | Python, FastAPI, Pydantic models, pytest, ruff |
| `agent/` | Python, LangChain Deep Agents (`deepagents` package). LLM provider: TBD |
| Voice or phone for the call | TBD (human decision) |
| Storage | In memory, loaded from JSON files in `data/`. No database for now |
| Hosting | TBD. Local demo is the default |

## Data sources

Sponsor data comes from CoStar Group (CoStar, Vexcel, Matterport). How we get access to real sponsor data is
TBD. Until then, `data/` holds made-up buildings with the same fields.

| Source | Fields it gives |
|---|---|
| Vexcel | elevation, roof condition, building footprint, height |
| CoStar | property type (including senior housing), units, tenants, floors, elevators, construction type, manager contact |
| Matterport | stairwells, exits, fire escapes, street-facing windows a ladder can reach |
| Public feeds | FEMA flood zones, NASA FIRMS fire detections, responder vehicle locations |
| Phone call | unit-level needs, collected live. Used for the incident, then deleted |

## Data models (draft)

JSON field names are `snake_case` in the API and in `data/` files.

```
Building {
  id: string
  name: string
  address: string
  lat: number, lng: number
  footprint: [[lng, lat], ...]        # polygon ring            (Vexcel)
  height_m: number                     #                         (Vexcel)
  elevation_m: number                  #                         (Vexcel)
  roof_condition: "good" | "fair" | "poor"                      (Vexcel)
  property_type: "residential" | "senior_housing" | "commercial" | "mixed"   (CoStar)
  units: int, tenants: int, floors: int, elevators: int         (CoStar)
  construction_type: string            # value set TBD           (CoStar)
  manager: { name: string, phone: string }                      (CoStar)
  egress: {                            #                         (Matterport)
    stairwells: int, exits: int, fire_escapes: int,
    ladder_windows: int                # street-facing windows a ladder can reach
  }
}

Scenario {
  disaster_type: "fire" | "flood"
  origin: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW"
  severity: 1..5
}

RiskScore {
  building_id: string
  exposure: number           # 0..1
  evac_difficulty: number    # 0..1
  eta_minutes: number        # time until the hazard arrives
  score: number              # exposure x evac_difficulty x urgency(eta). Exact formula TBD
}

Responder {
  id: string
  kind: "fire" | "police" | "ambulance"
  lat: number, lng: number
}

QueueEntry {
  rank: int                  # 1 is most urgent
  building_id: string
  risk: RiskScore
  responder_id: string | null    # one responder per building
  call_boost: number             # change from the manager call, 0 if no call yet
}

Call {
  id: string
  building_id: string
  status: "queued" | "in_progress" | "completed" | "failed"
  transcript: [{ speaker: "agent" | "manager", text: string }]
  residents_needing_help: [{ unit: string, need: string }]
}
```

Call data holds personal information. Keep it in memory only and delete it when the scenario is reset.

## API (draft)

Base path `/api`. JSON in and out. The web app reads the base URL from `NEXT_PUBLIC_API_URL`.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/health` | | `{ "status": "ok" }` |
| `GET /api/buildings` | | `{ "buildings": [Building] }` |
| `GET /api/buildings/{id}` | | `Building` |
| `GET /api/responders` | | `{ "responders": [Responder] }` |
| `POST /api/scenario` | `Scenario` | `{ "scenario": Scenario, "queue": [QueueEntry] }`. Replaces the current scenario and deletes call data |
| `GET /api/queue` | | `{ "scenario": Scenario or null, "queue": [QueueEntry] }` |
| `POST /api/buildings/{id}/call` | | `Call` (starts a manager call) |
| `GET /api/calls/{id}` | | `Call` (poll for status and transcript) |
| `GET /api/buildings/{id}/directions?unit=` | | TBD |

Errors: HTTP status plus `{ "detail": string }` (the FastAPI default).

## Agent interface (draft)

`agent/` is a Python package named `rollcall_agent`. The API installs it with `pip install -e ../agent`.

```
run_manager_call(building: dict, responder: dict, scenario: dict) -> dict
# returns { "transcript": [...], "residents_needing_help": [...] } in the Call shapes above
```

How the manager side of the call is produced (real phone call, voice in the browser, or simulated text) is TBD.

## Env vars

| Name | Used by | Meaning |
|---|---|---|
| `AGENT_NAME` | tools/coord | Your agent name, for example `rasul_1` |
| `PORT` | web | Dev server port. `3000 + X`, X is the number in your agent name |
| `API_PORT` | api | Dev server port. `8000 + X` |
| `NEXT_PUBLIC_API_URL` | web | API base URL, for example `http://localhost:8001` |
| LLM provider key | agent | TBD, name depends on the provider |
| Voice or phone provider keys | agent | TBD |
| Sponsor data keys (CoStar, Vexcel, Matterport) | data | TBD |
| Map token | web | TBD, only if the map library needs one |

Never commit secrets. Use a local `.env` file. `.env*` is in `.gitignore`. Each area keeps a `.env.example`
with names only.

## File layout

```
web/      Next.js app
api/      FastAPI app, package `app`, tests in api/tests, deps in api/requirements.txt
agent/    package `rollcall_agent`, tests in agent/tests, deps in agent/requirements.txt
data/     buildings.json, responders.json, scripts that make or import them
tools/    coord, coord_smoke.sh
```
