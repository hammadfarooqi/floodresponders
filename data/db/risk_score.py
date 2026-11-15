"""Risk score of one building, from building data only.

    risk_score = people_at_risk x structure_factor

people_at_risk is the estimated number of people who cannot leave without help. structure_factor (0.5 to 2.0) is
higher when the structure is more likely to burn. The score has no fire position, no fire arrival time and no
distance to a responder: matching adds those. So it does not say which buildings a fire threatens.

Pure functions, standard library only. The rules and the weights are described in DATABASE.md. Change a rule in
both places.
"""
import bisect

import build_rows as br

# Assumptions, not measurements. Every weight is a first guess. DATABASE.md lists them; keep the two in step.
WEIGHTS = {
    # People
    "vacancy": 0.05,                    # share of units that are empty
    "need_rate": 0.10,                  # share of residents who cannot leave without help
    "senior_need_rate": 0.5,            # the same share in senior housing
    "walkup_factor": 1.5,               # x need rate: 3+ floors with no elevator
    # x need rate: 3 or 4 floors, elevator not known. 12 of the 86 CoStar apartment properties here with 3 or 4
    # floors and a known answer have no elevator (14%), so: 1 + 0.14 x (walkup_factor - 1). CoStar lists mostly
    # large properties, so the true share for other buildings is probably higher.
    "walkup_unknown_factor": 1.07,
    "units_cap": 200,                   # highest estimated unit count we accept (DATABASE.md problem 26)
    "default_floors": 2,                # floors to assume when they are not known
    "house_max_floor_area_m2": 400.0,   # a structure of unknown use and at most this floor area counts as one home
    # Structure: each value is added to 1. "By rank" values are multiplied by the building's rank (0 to 1).
    "tree_zone1": 0.30,                 # by rank: tree cover in the ring nearest the structure
    "tree_zone2": 0.20,                 # by rank
    "tree_outer": 0.20,                 # by rank: mean of rings 3 and 4
    "neighbor_density": 0.10,           # by rank: mean building cover of rings 1 and 2
    "paved": -0.10,                     # by rank: paved share of the lot
    "roof_shingle": 0.05,
    "roof_tile_or_metal": -0.05,
    "wood_frame": 0.10,
    "concrete_or_steel": -0.15,
    "sprinklers": -0.10,
    "built_2008_or_later": -0.05,
    "factor_min": 0.5,
    "factor_max": 2.0,
}

# Weight name -> the columns whose mean is ranked against all other buildings.
RANKED = {
    "tree_zone1": ("tree_density_zone1",),
    "tree_zone2": ("tree_density_zone2",),
    "tree_outer": ("tree_density_zone3", "tree_density_zone4"),
    "neighbor_density": ("building_density_zone1", "building_density_zone2"),
    "paved": ("parcel_hardscape_pct",),
}

# Types with no estimate of the people inside (it depends on the hour, and tenant data is not loaded).
NO_PEOPLE_ESTIMATE = {"commercial", "office", "retail", "industrial", "hotel", "land"}


# ---------------------------------------------------------------- people at risk

def units_for_score(row, w=WEIGHTS):
    """Homes in the structure as the score counts them, or None when the people inside are not known."""
    units = row.get("units")
    if units is not None:
        return min(units, w["units_cap"]) if row.get("units_source") == "estimated" else units
    area = row.get("footprint_area_m2")
    if row.get("building_type") in NO_PEOPLE_ESTIMATE or not area:
        return None
    floor_area = float(area) * (row.get("floors") or w["default_floors"])
    if row.get("building_type") != "multi_family" and floor_area <= w["house_max_floor_area_m2"]:
        return 1
    return min(max(2, round(floor_area / br.FLOOR_AREA_PER_UNIT_M2)), w["units_cap"])


def need_rate(row, units, senior=False, w=WEIGHTS):
    """Share of the residents who cannot leave without help."""
    rate = w["senior_need_rate"] if senior else w["need_rate"]
    floors = row.get("floors") or 0
    walkup, elevators = row.get("is_walkup"), row.get("passenger_elevators")
    if units > 1 and floors >= 3:
        if walkup is True or elevators == 0:
            rate *= w["walkup_factor"]
        elif walkup is None and elevators is None and floors <= 4:
            rate *= w["walkup_unknown_factor"]
    return min(rate, 1.0)


def people_at_risk(row, senior=False, w=WEIGHTS):
    """Estimated people who cannot leave without help. 0 for a shed or garage. None when not known."""
    if row.get("is_accessory"):
        return 0.0
    units = units_for_score(row, w)
    if units is None:
        return None
    return units * br.PEOPLE_PER_UNIT * (1 - w["vacancy"]) * need_rate(row, units, senior, w)


# ---------------------------------------------------------------- structure factor

def _measure(row, columns):
    values = [row.get(c) for c in columns]
    if any(v is None for v in values):
        return None
    return sum(float(v) for v in values) / len(values)


def build_ranks(rows):
    """Sorted values of every ranked measure over the buildings that can hold people."""
    ranks = {}
    for name, columns in RANKED.items():
        values = (_measure(r, columns) for r in rows if not r.get("is_accessory"))
        ranks[name] = sorted(v for v in values if v is not None)
    return ranks


def rank(sorted_values, value):
    """Share of the buildings with a lower value: 0 for the lowest, almost 1 for the highest."""
    return bisect.bisect_left(sorted_values, value) / len(sorted_values) if sorted_values else 0


def structure_factor(row, ranks, w=WEIGHTS):
    """How likely the structure is to burn, compared with a typical one: 1 + adjustments, kept in bounds."""
    total = 1.0
    for name, columns in RANKED.items():
        value = _measure(row, columns)
        if value is not None:
            total += w[name] * rank(ranks[name], value)
    roof = row.get("roof_material")
    if roof == "shingle":
        total += w["roof_shingle"]
    elif roof in ("tile", "metal"):
        total += w["roof_tile_or_metal"]
    material = row.get("construction_material")
    if material == "wood_frame":
        total += w["wood_frame"]
    elif material in ("reinforced_concrete", "steel"):
        total += w["concrete_or_steel"]
    if row.get("has_sprinklers"):
        total += w["sprinklers"]
    if (row.get("year_built") or 0) >= 2008:
        total += w["built_2008_or_later"]
    return min(max(total, w["factor_min"]), w["factor_max"])


# ---------------------------------------------------------------- the score

def score_rows(rows, senior_ids=frozenset(), w=WEIGHTS):
    """Fill risk_score, people_at_risk and structure_factor on every buildings row. Returns the same rows.

    senior_ids: costar_id of every senior housing property.
    """
    ranks = build_ranks(rows)
    for row in rows:
        people = people_at_risk(row, row.get("costar_id") in senior_ids, w)
        factor = structure_factor(row, ranks, w)
        row["people_at_risk"] = None if people is None else round(people, 3)
        row["structure_factor"] = round(factor, 3)
        row["risk_score"] = None if people is None else round(people * factor, 3)
    return rows
