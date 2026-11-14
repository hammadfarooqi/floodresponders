# Building model and scoring: draft for discussion

Status: v2, 2026-11-14. Branch `hammad_1`. Measured on the Hollywood area (Hollywood plan area + Sunset Fire
evacuation areas). Section 0 is the current proposal. Sections 1-5 are the v1 field inventory, kept for reference.

## 0. v2 proposal: score people who need help, with few knobs that have units

### 0.1 Coverage, one denominator (42,557 buildings)

Denominator: 42,557 buildings (all Vexcel outlines in the area). Assessor matched 42,098.

| Field | Source | Has a value | Yes | No | Unknown |
|---|---|---|---|---|---|
| building_type | Vexcel | 99.8% | | | 0.2% |
| footprint_m2 | Vexcel | 100.0% | | | 0% |
| ground_elevation_m | Vexcel | 100.0% | | | 0% |
| roof_material | Vexcel | 100.0% | | | 0.03% |
| roof_condition | Vexcel | 100.0% | | | 0% |
| roof_tree_cover_pct | Vexcel | 100.0% | | | 0% |
| tree_cover_zone1_pct | Vexcel | 100.0% | | | 0% |
| tree_cover_zone2_pct | Vexcel | 100.0% | | | 0% |
| roof_structural_damage | Vexcel | 100.0% | 20.3% | 79.7% | 0% |
| use_type | Assessor | 98.6% | | | 1.4% |
| units | Assessor | 91.7% | | | 8.3% |
| bedrooms | Assessor | 89.7% | | | 10.3% |
| floor_area_sqft | Assessor | 95.8% | | | 4.2% |
| year_built | Assessor | 95.5% | | | 4.5% |
| stories | CoStar | 0.7% | | | 99.3% |
| construction_material | CoStar | 0.4% | | | 99.6% |
| units | CoStar | 0.7% | | | 99.3% |
| is_walkup | CoStar | 0.5% | 0.08% | 0.4% | 99.5% |
| elevators | CoStar | 0.2% | | | 99.8% |
| is_senior | CoStar | 0.7% | 0% | 0.7% | 99.3% |
| manager_phone | CoStar | 0.5% | | | 99.5% |
| staircases > 0 | Matterport | 0.7% | 0.04% | 0.7% | 99.3% |
| windows > 0 | Matterport | 0.7% | 0.2% | 0.5% | 99.3% |

Findings from this table:
- **The Assessor is the real backbone, not CoStar.** Units 92%, use 99%, floor area 96%, year built 96%.
- **CoStar and Matterport fields cover under 1% each.** Matterport stairs: 0.04%. Senior housing: 0% yes in this
  area (none of LA's 10 senior communities is in Hollywood).
- **Vexcel building type is wrong for "institutional_buildings":** of 5,209, the Assessor says 2,406 are single
  homes and 1,996 are apartments (2 or more units). Use the Assessor for use; use Vexcel only to drop sheds and
  garages.
- **Assessor units are per parcel.** A parcel with a house and a garage would count its units twice. Give the
  units to the parcel's primary structure only.

### 0.2 Reframe: what decision does the score drive?

Inside an evacuation order, everyone is told to leave. Roll Call adds value by finding the people who **cannot leave
on their own**, and calling about them first. So the score should estimate **people who need help**, not how likely
the building is to burn. Roof, vegetation and construction fields predict building ignition. They do not say who is
trapped. Keep them for a later "structure risk" view, not for the call queue.

### 0.3 The model (6 knobs, each with a unit and a source)

    priority = people_needing_help × urgency

    people_needing_help = people_est × need_rate
    people_est          = units × household_size × (1 − vacancy)              [people]
                          units: CoStar → Assessor; vacancy: CoStar, else area default
                          sheds/garages = 0; non-residential = off for now (day/night question)
    need_rate           = base_need_rate × building_multiplier                 [share of people]
                          base_need_rate: share of residents 65+ or with an ambulatory disability (census tract)
                          building_multiplier: senior housing → replace base rate with senior rate;
                                               3+ stories and (walk-up or no elevator) → × upper_floor_factor
    stories             = CoStar → Assessor floor area ÷ Vexcel footprint (works for 95% of buildings)
    urgency             = 1 / (1 + eta_min / tau)                               [0..1]
                          eta_min from the fire scenario; dense vegetation in zones 1-2 shortens eta

| Knob | Default | Source / reason |
|---|---|---|
| `household_size` | 2.4 (check) | US Census for LA; per tract when we have census access |
| `base_need_rate` | 0.10 (check) | ACS share 65+ or ambulatory difficulty, per tract |
| `senior_need_rate` | 0.5 (assumption) | senior housing residents, many with limited mobility |
| `upper_floor_factor` | 1.5 (assumption) | stairs are the only way out in a fire (elevators are not used) |
| `default_vacancy` | 0.05 (check) | CoStar median for the area |
| `tau` | 30 min (assumption) | time scale: a building 30 min from the fire gets half the urgency |

**Optional switches** (each changes a resolver or a multiplier, never adds a new weight): CoStar on/off,
Matterport on/off, census on/off, vegetation-shortens-eta on/off, the call result on/off.
When the call reports N people who need help, `people_needing_help = N`.

### 0.4 How to set the knobs without training data

1. **Use numbers with units and public sources** (census, household size). Most knobs are facts, not weights.
2. **The rest are labeled assumptions** in one config file, visible in the UI.
3. **Sensitivity test:** change each knob by ±50% and measure how much the top 50 of the queue changes. If the
   order hardly moves, the knob does not matter much and the exact value is not important. If it moves a lot,
   say so in the demo.
4. **Sanity cases:** a senior walk-up near the fire must rank above a vacant office far away. Write these as tests.
5. **Do not claim accuracy.** The only ground truth (the evacuation area) checks the fire model, not who needed help.

### 0.5 Questions we have not answered yet

1. **Census access:** the Census API now needs a free key (one human sign-up). Without it, there is no per-area
   data on seniors or disability, so `base_need_rate` is one number for the whole city.
2. **Day or night?** At night people are at home; by day, offices and shops are full. The demo should pick one.
3. **Responder capacity:** a queue only matters if responders are the limit. How many units, and how long per
   building?
4. **The call is the best data source.** Design the queue to call the buildings where the score is both high and
   uncertain first.

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
