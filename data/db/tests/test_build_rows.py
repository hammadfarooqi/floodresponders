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
