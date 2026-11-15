"""Tests for risk_score.py. All data here is made up: this repo is public, never put sponsor data in a test."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import risk_score as rs

HOUSE_PEOPLE = 1 * 2.4 * 0.95 * 0.10        # 1 unit x people per unit x (1 - vacancy) x need rate


def building(**over):
    """A 40-unit apartment block with typical values. Vexcel fields set, CoStar fields not known."""
    row = {"building_type": "multi_family", "is_accessory": False, "units": 40, "units_source": "costar",
           "floors": 2, "footprint_area_m2": 1700.0, "is_walkup": None, "passenger_elevators": None,
           "has_sprinklers": None, "construction_material": None, "year_built": None, "roof_material": "membrane",
           "tree_density_zone1": 10.0, "tree_density_zone2": 10.0, "tree_density_zone3": 10.0,
           "tree_density_zone4": 10.0, "building_density_zone1": 10.0, "building_density_zone2": 10.0,
           "parcel_hardscape_pct": 30.0}
    row.update(over)
    return row


def house(**over):
    return building(**{"building_type": "single_family", "units": 1, "units_source": "estimated", "floors": 1,
                       "footprint_area_m2": 170.0, **over})


def trees(level):
    return {f"tree_density_zone{n}": level for n in (1, 2, 3, 4)}


# Every measure runs from 0 to 100 in steps of 1, so a value's rank is value / 101.
RANKS = {key: [float(v) for v in range(101)] for key in rs.RANKED}


# ---------------------------------------------------------------- people at risk

def test_people_at_risk_is_units_times_people_times_need_rate():
    assert rs.people_at_risk(building()) == pytest.approx(40 * 2.4 * 0.95 * 0.10)
    assert rs.people_at_risk(house()) == pytest.approx(HOUSE_PEOPLE)


def test_more_units_never_lowers_people_at_risk():
    counts = [rs.people_at_risk(building(units=u)) for u in (1, 2, 10, 40, 400)]
    assert counts == sorted(counts)


def test_shed_or_garage_has_no_people():
    assert rs.people_at_risk(building(is_accessory=True, units=None)) == 0


def test_commercial_people_are_not_known():
    for kind in ("commercial", "office", "retail", "industrial"):
        assert rs.people_at_risk(building(building_type=kind, units=None, units_source=None)) is None


def test_null_units_on_housing_is_never_zero():
    for kind in ("multi_family", "institutional", None):
        for floors in (None, 1, 3):
            row = building(building_type=kind, units=None, units_source=None, floors=floors)
            assert rs.people_at_risk(row) > 0


def test_house_sized_institutional_counts_as_one_home():
    row = building(building_type="institutional", units=None, units_source=None, floors=1, footprint_area_m2=170.0)
    assert rs.people_at_risk(row) == pytest.approx(HOUSE_PEOPLE)


def test_large_institutional_is_estimated_like_apartments():
    row = building(building_type="institutional", units=None, units_source=None, floors=2, footprint_area_m2=1700.0)
    assert rs.people_at_risk(row) == pytest.approx(40 * 2.4 * 0.95 * 0.10)      # 1700 x 2 / 85 = 40 units


def test_estimated_units_are_capped_and_costar_units_are_not():
    capped = rs.people_at_risk(building(units=3000, units_source="estimated"))
    assert capped == pytest.approx(200 * 2.4 * 0.95 * 0.10)
    assert rs.people_at_risk(building(units=500, units_source="costar")) == pytest.approx(500 * 2.4 * 0.95 * 0.10)


def test_stairs_raise_the_need_rate():
    base = rs.people_at_risk(building())
    assert rs.people_at_risk(building(floors=3, is_walkup=True)) == pytest.approx(base * 1.5)
    assert rs.people_at_risk(building(floors=3, passenger_elevators=0)) == pytest.approx(base * 1.5)
    assert rs.people_at_risk(building(floors=3)) == pytest.approx(base * 1.07)          # not known, 3 floors
    assert rs.people_at_risk(building(floors=6)) == pytest.approx(base)                 # not known, tall
    assert rs.people_at_risk(building(floors=3, is_walkup=False)) == pytest.approx(base)
    assert rs.people_at_risk(building(floors=2, is_walkup=True)) == pytest.approx(base)
    assert rs.people_at_risk(house(floors=3)) == pytest.approx(HOUSE_PEOPLE)            # one home: no stair factor


def test_senior_housing_uses_the_senior_need_rate():
    assert rs.people_at_risk(building(), senior=True) == pytest.approx(40 * 2.4 * 0.95 * 0.5)


# ---------------------------------------------------------------- structure factor

def test_rank_is_the_share_of_buildings_with_a_lower_value():
    assert rs.rank([0.0, 0.0, 5.0, 9.0], 0.0) == 0
    assert rs.rank([0.0, 0.0, 5.0, 9.0], 5.0) == 0.5
    assert rs.rank([0.0, 0.0, 5.0, 9.0], 9.0) == 0.75
    assert rs.rank([], 3.0) == 0


def test_more_trees_never_lowers_the_factor():
    factors = [rs.structure_factor(building(**trees(level)), RANKS) for level in (0, 10, 50, 100)]
    assert factors == sorted(factors)
    assert factors[-1] > factors[0]


def test_closer_neighbors_never_lower_the_factor():
    low = rs.structure_factor(building(building_density_zone1=0.0, building_density_zone2=0.0), RANKS)
    high = rs.structure_factor(building(building_density_zone1=60.0, building_density_zone2=60.0), RANKS)
    assert high > low


def test_sprinklers_lower_the_factor_a_little():
    without = rs.structure_factor(building(), RANKS)
    with_sprinklers = rs.structure_factor(building(has_sprinklers=True), RANKS)
    assert with_sprinklers == pytest.approx(without - 0.10)
    assert rs.structure_factor(building(has_sprinklers=False), RANKS) == pytest.approx(without)


def test_construction_roof_year_and_paving():
    base = rs.structure_factor(building(), RANKS)
    assert rs.structure_factor(building(construction_material="wood_frame"), RANKS) == pytest.approx(base + 0.10)
    assert rs.structure_factor(building(construction_material="reinforced_concrete"), RANKS) == pytest.approx(base - 0.15)
    assert rs.structure_factor(building(construction_material="steel"), RANKS) == pytest.approx(base - 0.15)
    assert rs.structure_factor(building(construction_material="masonry"), RANKS) == pytest.approx(base)
    assert rs.structure_factor(building(roof_material="shingle"), RANKS) == pytest.approx(base + 0.05)
    assert rs.structure_factor(building(roof_material="tile"), RANKS) == pytest.approx(base - 0.05)
    assert rs.structure_factor(building(year_built=2015), RANKS) == pytest.approx(base - 0.05)
    assert rs.structure_factor(building(year_built=1990), RANKS) == pytest.approx(base)
    assert rs.structure_factor(building(parcel_hardscape_pct=90.0), RANKS) < base


def test_missing_structure_data_gives_factor_one():
    row = {"building_type": "multi_family", "is_accessory": False, "units": 40, "units_source": "costar"}
    assert rs.structure_factor(row, RANKS) == 1.0


def test_factor_stays_in_bounds_even_with_extreme_weights():
    worst = building(construction_material="wood_frame", roof_material="shingle", parcel_hardscape_pct=0.0,
                     building_density_zone1=100.0, building_density_zone2=100.0, **trees(100.0))
    best = building(construction_material="steel", roof_material="metal", has_sprinklers=True, year_built=2020,
                    parcel_hardscape_pct=100.0, building_density_zone1=0.0, building_density_zone2=0.0, **trees(0.0))
    assert 0.5 <= rs.structure_factor(best, RANKS) < 1.0 < rs.structure_factor(worst, RANKS) <= 2.0
    bounds = ("factor_min", "factor_max")
    extreme = {k: v if k in bounds else v * 10 for k, v in rs.WEIGHTS.items()}
    assert rs.structure_factor(worst, RANKS, extreme) == 2.0
    assert rs.structure_factor(best, RANKS, extreme) == 0.5


# ---------------------------------------------------------------- the score

def test_score_rows_fills_three_columns():
    rows = rs.score_rows([building(), house(), building(is_accessory=True, units=None),
                          building(building_type="commercial", units=None, units_source=None)])
    for row in rows[:2]:
        assert row["risk_score"] == pytest.approx(row["people_at_risk"] * row["structure_factor"], abs=0.01)
    assert rows[2]["risk_score"] == 0 and rows[2]["people_at_risk"] == 0
    assert rows[3]["risk_score"] is None and rows[3]["people_at_risk"] is None
    assert rows[3]["structure_factor"] is not None


def test_senior_ids_reach_the_need_rate():
    plain, senior = rs.score_rows([building(costar_id="1"), building(costar_id="2")], senior_ids={"2"})
    assert senior["people_at_risk"] == pytest.approx(plain["people_at_risk"] * 5)


def test_worked_examples_keep_their_order():
    """The four examples from the design: structure data changes the order between like buildings only."""
    wood_walkup = building(floors=3, is_walkup=True, construction_material="wood_frame", **trees(90.0))
    concrete = building(floors=3, is_walkup=False, passenger_elevators=2, construction_material="reinforced_concrete",
                        has_sprinklers=True, **trees(2.0))
    house_in_trees = house(building_density_zone1=60.0, building_density_zone2=60.0, **trees(90.0))
    house_on_paving = house(parcel_hardscape_pct=95.0, **trees(0.0))
    filler = [building(parcel_hardscape_pct=float(v), building_density_zone1=float(v), building_density_zone2=float(v),
                       **trees(float(v))) for v in range(0, 101, 5)]
    scored = rs.score_rows([wood_walkup, concrete, house_in_trees, house_on_paving] + filler)[:4]
    risks = [row["risk_score"] for row in scored]
    assert risks == sorted(risks, reverse=True)
    assert len(set(risks)) == 4
    assert scored[1]["risk_score"] > 10 * scored[2]["risk_score"]       # no house outranks a 40-unit block


def test_institutional_type_from_a_record_is_not_filled_in_as_housing():
    """A photo guess of "institutional" is often a home. A tax or CoStar record of it is a school or a church."""
    for source in ("assessor", "costar"):
        row = building(building_type="institutional", building_type_source=source, units=None, units_source=None)
        assert rs.people_at_risk(row) is None
    guess = building(building_type="institutional", building_type_source="vexcel", units=None, units_source=None)
    assert rs.people_at_risk(guess) > 0
    care_home = building(building_type="institutional", building_type_source="assessor", units=30, units_source="assessor")
    assert rs.people_at_risk(care_home) == pytest.approx(30 * 2.4 * 0.95 * 0.10)


def test_assessor_units_are_not_capped():
    assert rs.people_at_risk(building(units=450, units_source="assessor")) == pytest.approx(450 * 2.4 * 0.95 * 0.10)
