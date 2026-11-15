"""Tests for build_rows.py. All data here is made up: this repo is public, never put sponsor data in a test."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import build_rows as br


def square(x, y, size=0.001):
    return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]


def wkt_square(x, y, size=0.0002):
    pts = ", ".join(f"{a} {b}" for a, b in square(x, y, size))
    return f"POLYGON (({pts}))"


def structure(x, y, kind="multiple_family", height=10.0, area=400.0, primary=True):
    return {"footprint.wkt": wkt_square(x, y), "footprint.area": area, "ground-elevation.value": 100.0,
            "roof-characteristics.height": height, "building-type.class": kind, "primary-structure": primary,
            "roof-characteristics.condition": 3.0, "roof-characteristics.material.class": "membrane",
            "roof-characteristics.shape.value": "flat", "defensible-space.zone1-tree": 5.0}


def parcel(x, y, structures):
    return {"geometry": {"type": "MultiPolygon", "coordinates": [[square(x, y)]]},
            "properties": {"structures": structures, "metadata.collection": "test-2026",
                           "metadata.ortho-date-estimate": "2026-07-03T00:00:00"}}


def prop(lng, lat, **over):
    base = {"costar_id": "1", "kind": "commercial", "lat": lat, "lng": lng, "location": br.point_ewkt(lng, lat),
            "property_type": "multi_family", "floors": 4, "height_m": None, "total_units": 40,
            "construction_material": "wood_frame", "year_built": 1990, "is_walkup": True,
            "passenger_elevators": 0, "has_sprinklers": None}
    base.update(over)
    return base


def test_parse_wkt_polygon_and_multipolygon_with_hole():
    assert br.parse_wkt_polygons("POLYGON ((0 0, 1 0, 1 1, 0 0))") == [[[(0, 0), (1, 0), (1, 1), (0, 0)]]]
    multi = br.parse_wkt_polygons("MULTIPOLYGON (((0 0, 4 0, 4 4, 0 0), (1 1, 2 1, 2 2, 1 1)), ((9 9, 8 9, 8 8, 9 9)))")
    assert len(multi) == 2 and len(multi[0]) == 2 and multi[1][0][0] == (9, 9)
    assert br.to_multipolygon_ewkt(multi).startswith("SRID=4326;MULTIPOLYGON(((0.0 0.0,")


def test_point_in_polygons_respects_holes():
    polys = [[[(0, 0), (4, 0), (4, 4), (0, 4), (0, 0)], [(1, 1), (2, 1), (2, 2), (1, 2), (1, 1)]]]
    assert br.point_in_polygons(3, 3, polys)
    assert not br.point_in_polygons(1.5, 1.5, polys)
    assert not br.point_in_polygons(5, 5, polys)


def test_split_units_adds_up():
    assert br.split_units(10, [1, 1, 1]) in ([4, 3, 3],)
    assert sum(br.split_units(101, [5.5, 2.25, 9])) == 101
    assert br.split_units(7, [0, 0]) == [4, 3]


def test_vexcel_only_structure_gets_estimates_with_low_confidence():
    rows = br.build([parcel(0, 0, [structure(0.0001, 0.0001, "multiple_family", height=10.0, area=425.0)])], [])
    row = rows[0]
    assert row["costar_id"] is None
    assert (row["height_m"], row["height_source"]) == (10.0, "vexcel")
    assert (row["floors"], row["floors_source"]) == (3, "estimated")
    assert (row["units"], row["units_source"]) == (15, "estimated")       # 425 m2 x 3 floors / 85 m2
    assert row["est_occupants"] == 36
    assert row["building_type"] == "multi_family" and row["building_type_source"] == "vexcel"
    assert row["confidence"] == 0.45                                       # (0.6 + 0.6 + 0.3 + 0.3) / 4
    assert row["vexcel_survey_date"] == "2026-07-03" and row["roof_condition"] == 3


def test_costar_values_win_and_height_uses_floors_when_no_measured_height():
    rows = br.build([parcel(0, 0, [structure(0.0001, 0.0001, height=20.0)])], [prop(0.0005, 0.0005)])
    row = rows[0]
    assert row["costar_id"] == "1" and not row["shares_costar_property"]
    assert (row["floors"], row["floors_source"]) == (4, "costar")
    assert (row["height_m"], row["height_source"]) == (13.2, "estimated")
    assert row["vexcel_height_m"] == 20.0                                  # kept for the cross-check
    assert (row["units"], row["units_source"]) == (40, "costar")
    assert row["construction_material"] == "wood_frame" and row["is_walkup"] is True
    measured = br.build([parcel(0, 0, [structure(0.0001, 0.0001)])], [prop(0.0005, 0.0005, height_m=15.5)])[0]
    assert (measured["height_m"], measured["height_source"]) == (15.5, "costar")


def test_units_split_across_structures_and_shed_gets_nothing():
    structures = [structure(0.0001, 0.0001, area=300.0, height=10.0),
                  structure(0.0005, 0.0001, area=100.0, height=10.0, primary=False),
                  structure(0.0005, 0.0005, kind="shed", area=10.0, height=2.0, primary=False)]
    rows = br.build([parcel(0, 0, structures)], [prop(0.0008, 0.0008)])
    main, second, shed = rows
    assert (main["units"], second["units"]) == (30, 10)
    assert main["shares_costar_property"] and second["shares_costar_property"]
    assert shed["costar_id"] is None and shed["is_accessory"] and shed["units"] is None
    assert shed["est_occupants"] is None and not shed["height_suspect"]


def test_suspect_height_is_not_used():
    row = br.build([parcel(0, 0, [structure(0.0001, 0.0001, "single_family", height=0.4)])], [])[0]
    assert row["height_suspect"] and row["height_m"] is None and row["floors"] is None
    assert (row["units"], row["units_source"]) == (1, "estimated")
    assert row["vexcel_height_m"] == 0.4


def test_costar_property_without_structure_keeps_a_row():
    rows = br.build([parcel(0, 0, [])], [prop(0.0005, 0.0005), prop(5.0, 5.0, costar_id="2")])
    assert sorted(r["costar_id"] for r in rows) == ["1", "2"]
    for row in rows:
        assert row["footprint"] is None and row["parcel_key"] is None
        assert (row["units"], row["floors_source"]) == (40, "costar")
    assert rows[0]["id"] != rows[1]["id"]


def test_ids_are_stable_between_runs():
    make = lambda: br.build([parcel(0, 0, [structure(0.0001, 0.0001)])], [])[0]["id"]
    assert make() == make()


def test_commercial_property_and_contacts():
    record = {"id": 7, "buildingName": "Test Arms", "propertyType": 11, "numStoriesAboveGrade": 5,
              "buildingHeightInFeet": 100.0, "buildingConstructionMaterial": 3, "hasSprinklers": True,
              "primaryAddress": {"latitude": 34.1, "longitude": -118.3, "postcode": "900281234",
                                 "streetNumber": "1", "streetName": "Test", "streetType": "St"},
              "constructionEvents": [{"eventType": 2, "year": 1988}, {"eventType": 4, "year": 2010}],
              "propertyApartment": {"totalNumUnits": 60, "apartmentLifestyleType": 2, "isWalkup": False,
                                    "sitePhoneNumber": "5550000001",
                                    "elevators": [{"elevatorType": 1, "elevatorState": 1, "numElevators": 2},
                                                  {"elevatorType": 2, "elevatorState": 1, "numElevators": 1}]},
              "attachments": [{"videoKey": "abc", "videoExternalReferenceType": 36},
                              {"videoKey": "photo", "videoExternalReferenceType": 0}],
              "contacts": [{"contactRole": 4, "locationId": 99, "contactPhoneNumber": "5550000002"},
                           {"contactRole": 7, "locationId": 98}]}
    row = br.commercial_property(record)
    assert row["costar_id"] == "7" and row["postcode"] == "90028" and row["address"] == "1 Test St"
    assert row["height_m"] == 30.5 and row["year_built"] == 1988
    assert row["construction_material"] == "reinforced_concrete" and row["is_senior_housing"] is True
    assert row["passenger_elevators"] == 2 and row["matterport_model_ids"] == ["abc"]
    contacts = br.contacts_for(record, {99: "Test Management Co"})
    assert {(c["role"], c["company_name"], c["phone"]) for c in contacts} == {
        ("site_office", "Test Arms", "5550000001"), ("property_manager", "Test Management Co", "5550000002")}


def test_residential_property():
    record = {"property": {"address": {"id": 5, "latitude": 34.1, "longitude": -118.3, "zip": "90068",
                                       "fullStreetAddress": "2 Test Way"},
                           "listingPropertyType": 1, "stories": 2, "yearBuilt": 1950, "sqftMax": 1500},
              "resoValues": {"hasBasement": False, "hasAccessibilityFeatures": True},
              "media": [{"videoKey": "m1", "externalReferenceType": 234}]}
    row = br.residential_property(record)
    assert row["costar_id"] == "res-5" and row["property_type"] == "single_family" and row["total_units"] == 1
    assert row["has_accessibility_features"] is True and row["matterport_model_ids"] == ["m1"]
    assert br.residential_property({"property": {"address": {}}}) is None


def test_vexcel_roof_details_and_confidence():
    extra = {"roof-characteristics.tree-cover.percent": 12.5, "roof-defects.structural-damage.detected": True,
             "roof-defects.missing-material.detected": False, "roof-defects.tarp.detected": True,
             "roof-defects.debris.detected": False, "roof-objects.solar.value": True, "building-type.score": 0.58,
             "roof-characteristics.material.score": 0.81, "roof-characteristics.shape.score": 0.99}
    row = br.build([parcel(0, 0, [{**structure(0.0001, 0.0001), **extra}])], [])[0]
    assert row["roof_tree_cover_pct"] == 12.5 and row["has_solar_panels"] is True
    assert (row["roof_structural_damage"], row["roof_missing_material"]) == (True, False)
    assert (row["roof_tarp"], row["roof_debris"]) == (True, False)
    assert row["vexcel_type_confidence"] == 0.58
    assert (row["roof_material_confidence"], row["roof_shape_confidence"]) == (0.81, 0.99)


def test_vexcel_roof_details_are_null_when_vexcel_sends_none():
    row = br.build([parcel(0, 0, [structure(0.0001, 0.0001)])], [])[0]
    for column in ("roof_tree_cover_pct", "roof_structural_damage", "roof_tarp", "has_solar_panels",
                   "vexcel_type_confidence"):
        assert row[column] is None
    only_costar = br.build([], [prop(-118.3, 34.1)])[0]
    assert only_costar["roof_tarp"] is None and only_costar["vexcel_type_confidence"] is None


# ---------------------------------------------------------------- CoStar unit count

def apartment_record(**apartment):
    return {"id": 8, "propertyType": 11, "primaryAddress": {"latitude": 34.1, "longitude": -118.3},
            "propertyApartment": apartment}


def test_costar_units_come_from_the_floor_plans_not_from_total_num_units():
    plans = [{"numUnits": 30}, {"numUnits": 25}, {"numUnits": None}]
    assert br.commercial_property(apartment_record(totalNumUnits=15, models=plans))["total_units"] == 55
    assert br.commercial_property(apartment_record(totalNumUnits=15, models=plans), listing_units=70)["total_units"] == 55
    assert br.commercial_property(apartment_record(totalNumUnits=15), listing_units=48)["total_units"] == 48
    assert br.commercial_property(apartment_record(totalNumUnits=15))["total_units"] is None
    hotel = {"id": 9, "propertyType": 1, "primaryAddress": {"latitude": 34.1, "longitude": -118.3},
             "propertyHospitality": {"numUnits": 120}}
    assert br.commercial_property(hotel)["total_units"] == 120


def test_costar_rent_vacancy_style_and_lot_number():
    record = apartment_record(vacancyPercent=4, apartmentRentType=3, numBuildings=2, apartmentStyleType=4)
    record["parcelNumbers"] = ["5548-007-014", "5548-007-015"]
    row = br.commercial_property(record)
    assert row["vacancy_pct"] == 4 and row["rent_type"] == "mixed" and row["num_buildings"] == 2
    assert row["apartment_style"] == "low_rise" and row["parcel_number"] == "5548007014"
    assert br.commercial_property(apartment_record(apartmentRentType=2))["rent_type"] == "affordable"
    plain = br.commercial_property(apartment_record(apartmentRentType=0, apartmentStyleType=0))
    for column in ("vacancy_pct", "rent_type", "num_buildings", "apartment_style", "parcel_number"):
        assert plain[column] is None
    assert br.commercial_property(apartment_record(vacancyPercent=0))["vacancy_pct"] == 0     # 0 = full, not unknown
    home = br.residential_property({"property": {"address": {"id": 5, "latitude": 34.1, "longitude": -118.3}}})
    assert home["rent_type"] is None and home["parcel_number"] is None


# ---------------------------------------------------------------- County Assessor

def lot(x, y, size=0.001, ain="5000000001", use_type="Residential", description="Five or more apartments",
        units=(12,), years=("1960",), bedrooms=(20,), sqft=(), **address):
    """One feature of the county parcel layer, in the shape the service returns."""
    attributes = {"AIN": ain, "UseType": use_type, "UseDescription": description, **address}
    for n in range(1, 6):
        attributes[f"SQFTmain{n}"] = sqft[n - 1] if n <= len(sqft) else None
        attributes[f"Units{n}"] = units[n - 1] if n <= len(units) else None
        attributes[f"YearBuilt{n}"] = years[n - 1] if n <= len(years) else None
        attributes[f"Bedrooms{n}"] = bedrooms[n - 1] if n <= len(bedrooms) else None
    return {"attributes": attributes, "geometry": {"rings": [square(x, y, size)]}}


def one(kind="multiple_family", lots=(), properties=(), **over):
    """The row of one structure at (0.0001, 0.0001) on a Vexcel parcel at (0, 0)."""
    return br.build([parcel(0, 0, [structure(0.0001, 0.0001, kind, **over)])], list(properties), list(lots))[0]


def test_assessor_units_type_and_year_beat_our_estimate():
    row = one(lots=[lot(0, 0)], height=10.0, area=425.0)
    assert (row["units"], row["units_source"]) == (12, "assessor")          # the estimate would be 15
    assert row["est_occupants"] == 29
    assert (row["building_type"], row["building_type_source"]) == ("multi_family", "assessor")
    assert (row["year_built"], row["year_built_source"]) == (1960, "assessor")
    assert (row["assessor_ain"], row["assessor_units"], row["assessor_bedrooms"]) == ("5000000001", 12, 20)
    assert (row["assessor_use_type"], row["assessor_use_description"]) == ("Residential", "Five or more apartments")
    assert row["assessor_year_built"] == 1960
    assert row["confidence"] > 0.45


def test_no_assessor_lot_leaves_the_row_as_before():
    row = one(lots=[lot(5, 5)], height=10.0, area=425.0)
    assert (row["units"], row["units_source"]) == (15, "estimated")
    assert row["building_type_source"] == "vexcel"
    assert row["year_built"] is None and row["year_built_source"] is None
    assert row["assessor_ain"] is None and row["assessor_units"] is None


def test_costar_beats_the_assessor():
    row = one(lots=[lot(0, 0)], properties=[prop(0.0005, 0.0005)])
    assert (row["units"], row["units_source"]) == (40, "costar")
    assert (row["building_type"], row["building_type_source"]) == ("multi_family", "costar")
    assert (row["year_built"], row["year_built_source"]) == (1990, "costar")
    assert row["assessor_units"] == 12                                      # kept for the cross-check


def test_assessor_fills_what_costar_does_not_know():
    row = one(lots=[lot(0, 0)], properties=[prop(0.0005, 0.0005, total_units=None, year_built=None)])
    assert (row["units"], row["units_source"]) == (12, "assessor")
    assert (row["year_built"], row["year_built_source"]) == (1960, "assessor")
    assert row["building_type_source"] == "costar"


def test_assessor_units_are_split_across_the_structures_of_a_lot():
    structures = [structure(0.0001, 0.0001, area=300.0, height=10.0),
                  structure(0.0005, 0.0001, area=100.0, height=10.0, primary=False),
                  structure(0.0005, 0.0005, kind="shed", area=10.0, height=2.0, primary=False)]
    main, second, shed = br.build([parcel(0, 0, structures)], [], [lot(0, 0, units=(5, 3))])
    assert (main["units"], second["units"]) == (6, 2)                       # the lot has 5 + 3 = 8
    assert main["units_source"] == second["units_source"] == "assessor"
    assert main["assessor_units"] == second["assessor_units"] == 8
    assert shed["units"] is None and shed["building_type"] == "accessory"


def test_one_home_lot_with_two_structures_gives_the_unit_to_the_larger():
    structures = [structure(0.0001, 0.0001, "single_family", area=200.0, height=6.0),
                  structure(0.0005, 0.0001, "single_family", area=40.0, height=3.5, primary=False)]
    home, small = br.build([parcel(0, 0, structures)], [], [lot(0, 0, description="Single", units=(1,))])
    assert (home["units"], small["units"]) == (1, 0)
    assert small["est_occupants"] == 0


def test_stacked_condo_lots_add_up():
    lots = [lot(0, 0, ain=f"500000000{n}", description="Single", units=(1,), bedrooms=(2,)) for n in (1, 2, 3)]
    row = one(lots=lots)
    assert (row["units"], row["units_source"]) == (3, "assessor")
    assert row["building_type"] == "multi_family"
    assert row["assessor_units"] == 3 and row["assessor_bedrooms"] == 6


def test_the_same_lot_in_two_tiles_counts_once():
    row = one(lots=[lot(0, 0), lot(0, 0)])
    assert row["units"] == 12


def test_residential_lot_with_no_unit_count_falls_back_to_the_estimate():
    row = one("single_family", lots=[lot(0, 0, description="Single", units=(0,))])
    assert (row["units"], row["units_source"]) == (1, "estimated")
    assert (row["building_type"], row["building_type_source"]) == ("single_family", "assessor")
    assert row["assessor_units"] is None                                    # 0 on the tax roll: not known


def test_assessor_corrects_a_wrong_vexcel_type():
    row = one("institutional_buildings", lots=[lot(0, 0, description="Single", units=(1,))])
    assert (row["building_type"], row["units"], row["units_source"]) == ("single_family", 1, "assessor")


def test_units_on_a_shop_lot_are_not_homes_but_store_combination_and_care_homes_are():
    shop = one(lots=[lot(0, 0, use_type="Commercial", description="Stores", units=(4,))], height=10.0, area=425.0)
    assert (shop["building_type"], shop["building_type_source"]) == ("commercial", "assessor")
    assert shop["units"] is None and shop["assessor_units"] is None and shop["est_occupants"] is None
    mixed = one(lots=[lot(0, 0, use_type="Commercial", description="Store Combination", units=(20,))])
    assert (mixed["building_type"], mixed["units"], mixed["units_source"]) == ("multi_family", 20, "assessor")
    care = one(lots=[lot(0, 0, use_type="Institutional", description="Homes For Aged & Others", units=(30,))])
    assert (care["units"], care["units_source"]) == (30, "assessor")
    assert care["assessor_use_description"] == "Homes For Aged & Others"


def test_assessor_use_types_map_to_our_types():
    kinds = {("Commercial", "Hotel & Motels"): "hotel", ("Commercial", "Office Buildings"): "commercial",
             ("Industrial", "Industrial"): "industrial", ("Institutional", "Churches"): "institutional",
             ("Government", "Government Parcel"): "institutional", ("Recreational", "Theaters"): "commercial"}
    for (use_type, description), expected in kinds.items():
        row = one(lots=[lot(0, 0, use_type=use_type, description=description, units=())])
        assert (row["building_type"], row["building_type_source"]) == (expected, "assessor"), description
    unknown = one(lots=[lot(0, 0, use_type="Miscellaneous", description="Utility", units=())])
    assert (unknown["building_type"], unknown["building_type_source"]) == ("multi_family", "vexcel")
    blank = one(lots=[lot(0, 0, use_type=None, description=None, units=())])
    assert blank["building_type_source"] == "vexcel"


def test_costar_units_are_taken_off_the_lot_before_the_split():
    """One assessor lot of 50 units over two Vexcel parcels. CoStar has 40 on the first, so 10 are left."""
    parcels = [parcel(0, 0, [structure(0.0001, 0.0001)]), parcel(0.002, 0, [structure(0.0021, 0.0001)])]
    with_costar, other = br.build(parcels, [prop(0.0005, 0.0005)], [lot(0, 0, size=0.004, units=(50,))])
    assert (with_costar["units"], with_costar["units_source"]) == (40, "costar")
    assert (other["units"], other["units_source"]) == (10, "assessor")


def test_assessor_year_ignores_bad_values():
    row = one(lots=[lot(0, 0, years=("0000", "1975", "1931"))])
    assert row["year_built"] == 1931
    assert one(lots=[lot(0, 0, years=("0",))])["year_built"] is None


def test_assessor_placeholder_999_is_not_a_unit_count():
    row = one("single_family", lots=[lot(0, 0, description="Single", units=(1, 999))])
    assert (row["units"], row["assessor_units"]) == (1, 1)
    only_placeholder = one("single_family", lots=[lot(0, 0, description="Single", units=(999,))])
    assert (only_placeholder["units"], only_placeholder["units_source"]) == (1, "estimated")
    assert only_placeholder["assessor_units"] is None


def test_assessor_address_and_floor_area():
    row = one(lots=[lot(0, 0, sqft=(9000, 1500), SitusHouseNo="1645", SitusFraction=" ", SitusDirection="N",
                        SitusStreet="TEST ST")])
    assert row["assessor_address"] == "1645 N TEST ST" and row["assessor_sqft"] == 10500
    bare = one(lots=[lot(0, 0, SitusHouseNo=" ", SitusStreet=" ")])
    assert bare["assessor_address"] is None and bare["assessor_sqft"] is None
    old_cache = one(lots=[lot(0, 0)])                       # a cache made before these fields were fetched
    assert old_cache["assessor_address"] is None and old_cache["assessor_sqft"] is None


def test_stacked_condo_lots_share_one_address_and_add_their_floor_area():
    street = {"SitusHouseNo": "7", "SitusDirection": " ", "SitusStreet": "TEST AVE"}
    condos = [lot(0, 0, ain=f"500000000{n}", description="Single", units=(1,), sqft=(900,), **street) for n in (1, 2, 3)]
    row = one(lots=condos)
    assert row["assessor_address"] == "7 TEST AVE" and row["assessor_sqft"] == 2700
