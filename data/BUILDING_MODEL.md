# Building model and scoring: draft for discussion

Status: draft for brainstorming, 2026-11-14. Branch `hammad_1`. Numbers are measured on the Hollywood area
(Hollywood plan area + Sunset Fire evacuation areas): 42,557 Vexcel buildings, 275 CoStar buildings.

## 1. Sources and how many buildings each covers

| Source | Buildings covered in Hollywood | Always there? | What it is best for |
|---|---|---|---|
| Vexcel (precomputed) | 42,557 (100%) | yes | Building type, footprint, ground elevation, roof, vegetation around the building |
| LA County Assessor (public) | ~98% of parcels | almost | Use, units (66%), bedrooms (58%), floor area (85%), year built (86%) |
| CoStar | 275 (0.6%) | no | Stories, construction material, units, vacancy, senior, walk-up, elevators, manager contact |
| Matterport | 96 with windows, 15 with stairs | no | Stairs, windows, doors inside the building |
| Vexcel (calculated) | on request, slow | no | Roof height. Unreliable: 4 of 12 samples were negative |
| Manager call | per call | no | Who needs help, live |

Design rule that follows from this table: **the score must work with Vexcel (+ Assessor) alone.** CoStar,
Matterport and the call make the score more precise. They must not be required.

## 2. Fields

Legend for "Switch": **core** = always on, every building has it. **opt** = can be turned on or off in the UI; the
score must give a sensible result in both states. **off** = available but off by default (low trust).

### 2.1 Identity and location

| Field | Type | Source (first available wins) | Hollywood coverage | Switch | Use |
|---|---|---|---|---|---|
| `id` | string | Vexcel footprint hash; CoStar id if present | 100% | core | key |
| `lat`, `lng`, `footprint` | polygon | Vexcel | 100% | core | map, distance to fire |
| `address` | string | CoStar → Assessor | ~98% | core | display, call |
| `parcel_id` (AIN) | string | Assessor | ~98% | core | join key |
| `plan_area`, `evac_zone` | string | our boundaries | 100% | core | filters, ground truth |
| `sources` | list | derived | 100% | core | shows which data the score used |

### 2.2 Exposure: how badly the hazard can reach the building

| Field | Type | Source | Coverage | Switch | Direction |
|---|---|---|---|---|---|
| `dist_to_fire_m`, `eta_min` | number | scenario (fire front model) | 100% | core | nearer, sooner = higher |
| `ground_elevation_m` | number | Vexcel | 100% | core | flood: lower = higher. Fire: upslope of the front = higher |
| `tree_cover_zone1_pct` (0–1.5 m) | number | Vexcel `defensible-space.zone1-tree` | 100% | core | more fuel next to walls = higher |
| `tree_cover_zone2_pct` (1.5–9 m) | number | Vexcel `defensible-space.zone2-tree` | 100% | core | more = higher |
| `building_density_zone2_pct` | number | Vexcel `defensible-space.zone2-building` | 100% | core | close neighbors spread fire = higher |
| `roof_material` | enum | Vexcel `roof-characteristics.material.class` (membrane 67%, shingle 27%, tile 4%, metal 1%) | 100% | core | shingle > membrane > tile/metal |
| `roof_condition` | 1–5 | Vexcel | 100% | core | poor = higher |
| `roof_tree_cover_pct` | number | Vexcel | 100% | core | branches over roof = higher |
| `roof_defects` | flags | Vexcel (missing material, structural damage, debris, tarp) | 100% flags, 26–37% percentages | opt | damaged roof = higher |
| `construction_material` | enum | CoStar (58% of CoStar bldgs) | 0.4% of all | opt | wood frame > masonry > steel/concrete |
| `has_sprinklers` | bool | CoStar (13%) | <0.1% | opt | yes = lower |
| `year_built` | int | CoStar → Assessor | ~86% | opt | older code = higher |

### 2.3 Occupancy: how many people are likely inside

| Field | Type | Source | Coverage | Switch | Note |
|---|---|---|---|---|---|
| `building_type` | enum | Vexcel `building-type.class` (single_family 70%, institutional 12%, multiple_family 9%, shed 4%, commercial 3%, garage 1%) | 100% | core | sheds and garages get people = 0 |
| `use_type` | enum | Assessor `UseType`/`UseDescription` | ~98% | core | e.g. "Five or more apartments" |
| `units` | int | CoStar → Assessor `Units1` → estimate | CoStar 89%, Assessor 66% | opt | |
| `bedrooms` | int | CoStar floor plans → Assessor | CoStar 95%, Assessor 58% | opt | |
| `floor_area_m2` | number | CoStar GBA → Assessor SQFT → Vexcel footprint × stories | ~100% with fallback | core | |
| `vacancy_pct` | number | CoStar | 46% of CoStar | opt | |
| `people_est` | number | derived (see 3.1) | 100% | core | the main occupancy number |

### 2.4 Evacuation difficulty: how hard it is for people to get out

| Field | Type | Source | Coverage | Switch | Direction |
|---|---|---|---|---|---|
| `stories` | int | CoStar → estimate from type + floor area/footprint | CoStar 100%, estimate 100% | core (estimate) / opt (CoStar) | more = harder |
| `is_walkup` | bool | CoStar (60% known) | <0.5% | opt | walk-up = harder |
| `elevators` | int | CoStar (41%) | <0.5% | opt | 0 with stories > 2 = harder |
| `is_senior` | bool | CoStar lifestyle (95% known) | 0.6% | opt | senior = much harder |
| `is_affordable` | bool | CoStar rent type | 0.6% | opt | proxy for fewer cars and more mobility needs |
| `staircases` | int | Matterport | 15 bldgs | opt | 0 known stairs in a multi-story bldg = harder |
| `ladder_windows` | int | Matterport windows | 96 bldgs | opt | more = easier rescue |
| `call_residents_needing_help` | list | manager call | live | opt | strongest signal when present |

### 2.5 Contact

| Field | Source | Coverage | Use |
|---|---|---|---|
| `manager.company`, `manager.phone` | CoStar | 97% / 70% of CoStar | who the agent calls. Without it: no call, the building stays in the queue on its score |

## 3. Scoring that works when fields are on, off or missing

### 3.1 Resolve each field, then record where it came from

Each field has a list of resolvers in order of trust, for example `units`: CoStar → Assessor → estimate from
`floor_area_m2 / 75 m²` for multiple_family. The first one that returns a value wins. We store the value and a
`trust` (CoStar 1.0, Assessor 0.9, estimate 0.5). A switched-off source is skipped, so turning CoStar off makes
the same building fall back to Assessor or the estimate. Nothing else changes.

`people_est = units × 2.4 × (1 − vacancy)`, where 2.4 is an assumed average household size (check against the
census). With no units: use bedrooms, then floor area. Sheds and garages = 0.

### 3.2 Normalize every input to 0..1 risk

Each field has a small function that maps it to 0 (low risk) to 1 (high risk). Examples: stories 1→0.1, 3→0.4,
6+→0.8; walk-up yes→1, no→0; roof shingle→0.7, membrane→0.5, tile/metal→0.2.

### 3.3 Weighted average per component, over the fields that are available

For a component C (exposure, evacuation difficulty) and a building:

    C = Σ wᵢ · trustᵢ · fᵢ  /  Σ wᵢ · trustᵢ        over the fields i that are switched on AND present

    confidence_C = Σ wᵢ · trustᵢ (present)  /  Σ wᵢ (all switched on)

If nothing is present, C = a prior by building type (for example, multiple_family difficulty 0.5).

This is a weighted **average**, not a sum. So a CoStar building does not get a higher score just because it has
more fields. Extra fields make the score more **precise** (higher confidence), not bigger. Turning a field off
removes it from both the top and the bottom of the fraction, so the score stays in 0..1.

### 3.4 Combine

    priority = urgency(eta) × exposure × evac_difficulty × people_factor(people_est)

`people_factor` grows with people but flattens (for example log), so one tower does not hide ten walk-ups.
CONTRACTS.md has `exposure x evac_difficulty x urgency`; this adds the people term.

### 3.5 Show the work

For each building the UI shows: the score, its confidence, and the top 3 fields that pushed it up, each with its
source. This also helps the AI call: low confidence on a field = a question for the manager.

## 4. Draft data shape

```python
class Field(BaseModel):          # one resolved value
    value: float | int | str | bool | None
    source: Literal["vexcel", "assessor", "costar", "matterport", "call", "estimate"]
    trust: float                 # 0..1

class Building(BaseModel):
    id: str; lat: float; lng: float; footprint: list[list[float]]
    address: str | None; parcel_id: str | None; plan_area: str | None; evac_zone: str | None
    fields: dict[str, Field]     # every field in section 2, keyed by name
    people_est: Field
    scores: dict[str, float]     # exposure, evac_difficulty, urgency, priority
    confidence: dict[str, float]
    sources: list[str]           # which sources contributed
```

A switch set is just `{"costar": True, "matterport": False, "roof_defects": True, ...}`. It is passed to the
scorer, so the UI can rescore all 42,557 buildings when a switch changes.

## 5. Open questions for the brainstorm

1. Weights: start by hand, or fit them to the Sunset Fire evacuation areas (which buildings were inside the
   order)? Fitting is possible, but it learns "near the fire", not "hard to evacuate".
2. Vexcel tags 12% of Hollywood buildings as `institutional_buildings`, much more than expected. Many may be
   apartments with flat roofs. Prefer the Assessor use type when the two disagree?
3. Household size 2.4: use one value, or census values per tract?
4. Should `is_senior` be a big multiplier (×2) and not one input in the average? It is rare but very important.
5. Assessor data is public: do we add it to the pipeline now? (Next step in the plan.)
6. Fire front model for `eta_min`: simple ellipse grown from the real perimeter with a wind direction, or
   something more detailed?
