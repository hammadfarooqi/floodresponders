"""Tests for facilities.py. All records here are made up."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import facilities as fc


def square(x, y, size=0.0002):
    return [[(x, y), (x + size, y), (x + size, y + size), (x, y + size), (x, y)]]


def building(id_, x, y, accessory=False):
    return {"id": id_, "polygons": [square(x, y)], "is_accessory": accessory}


def facility(lng, lat):
    return {"lng": lng, "lat": lat, "building_id": None, "building_distance_m": None}


# ---------------------------------------------------------------- one row per source record

def test_care_home_for_the_elderly():
    row = fc.cdss_row({"FAC_NBR": 197600001, "TYPE": 740, "STATUS": 3, "CAPACITY": 60,
                       "NAME": "TEST CARE HOME          ", "RES_STREET_ADDR": "1 Test St       ",
                       "FAC_LATITUDE": "34.1", "FAC_LONGITUDE": "-118.3"})
    assert row["source"] == "cdss" and row["source_id"] == "197600001"
    assert row["kind"] == "elderly_care"
    assert row["name"] == "TEST CARE HOME" and row["address"] == "1 Test St"
    assert (row["capacity"], row["capacity_unit"]) == (60, "people")
    assert (row["lat"], row["lng"]) == (34.1, -118.3)
    assert row["source_status"] == "3"
    assert row["location"] == "SRID=4326;POINT(-118.3 34.1)"


def test_care_list_skips_family_homes_and_agencies():
    base = {"FAC_NBR": 1, "STATUS": 3, "CAPACITY": 4, "NAME": "X", "RES_STREET_ADDR": "X",
            "FAC_LATITUDE": "34.1", "FAC_LONGITUDE": "-118.3"}
    assert fc.cdss_row({**base, "TYPE": 403}) is None      # a family home that takes foster children
    assert fc.cdss_row({**base, "TYPE": 400}) is None      # an adoption agency office
    assert fc.cdss_row({**base, "TYPE": 850})["kind"] == "child_care"


def test_record_without_a_position_is_skipped():
    assert fc.cdss_row({"FAC_NBR": 1, "TYPE": 740, "STATUS": 3, "CAPACITY": 4, "NAME": "X",
                        "RES_STREET_ADDR": "X", "FAC_LATITUDE": None, "FAC_LONGITUDE": None}) is None


def test_nursing_home_and_hospital():
    base = {"FACID": "930000001", "FACNAME": "TEST NURSING", "ADDRESS": "2 TEST AVE", "CAPACITY": "99",
            "FAC_STATUS_TYPE_CODE": "OPEN", "LATITUDE": "34.1", "LONGITUDE": "-118.3"}
    row = fc.cdph_row({**base, "FAC_TYPE_CODE": "SNF"})
    assert row["kind"] == "nursing_home" and (row["capacity"], row["capacity_unit"]) == (99, "beds")
    assert fc.cdph_row({**base, "FAC_TYPE_CODE": "GACH"})["kind"] == "hospital"
    assert fc.cdph_row({**base, "FAC_TYPE_CODE": "HHA"}) is None            # an agency office, no patients stay there


def test_capacity_zero_means_not_known():
    row = fc.cdph_row({"FACID": "1", "FACNAME": "DAY CENTER", "ADDRESS": "X", "CAPACITY": "0",
                       "FAC_TYPE_CODE": "ADHC", "FAC_STATUS_TYPE_CODE": "OPEN", "LATITUDE": "34.1",
                       "LONGITUDE": "-118.3"})
    assert row["kind"] == "adult_day_care" and row["capacity"] is None


def test_city_housing_project():
    base = {"project_number": "10-000001", "site_cd": "2", "name": "TEST VILLAS", "address": "3 TEST BLVD",
            "site_units": "40", "development_stage": "In-Service", "latitude": "34.1", "longitude": "-118.3"}
    row = fc.lahd_row({**base, "housing_type": "SENIORS"})
    assert row["source_id"] == "10-000001:2"
    assert row["kind"] == "senior_housing" and (row["capacity"], row["capacity_unit"]) == (40, "units")
    assert fc.lahd_row({**base, "housing_type": "SPECIAL NEEDS"})["kind"] == "special_needs_housing"
    assert fc.lahd_row({**base, "housing_type": "FAMILY"})["kind"] == "affordable_housing"


def test_federal_housing_property():
    base = {"PROPERTY_ID": "800000001", "PROPERTY_NAME_TEXT": "Test Towers", "STD_ADDR": "4 TEST WAY",
            "TOTAL_UNIT_COUNT": 151, "LAT": 34.1, "LON": -118.3}
    assert fc.hud_row({**base, "CLIENT_GROUP_TYPE": "Elderly"})["kind"] == "senior_housing"
    assert fc.hud_row({**base, "CLIENT_GROUP_TYPE": "Disabled"})["kind"] == "special_needs_housing"
    row = fc.hud_row({**base, "CLIENT_GROUP_TYPE": "Family"})
    assert row["kind"] == "affordable_housing" and row["capacity"] == 151


def test_school():
    base = {"CDSCode": "19000000000001", "SchoolName": "Test Elementary", "Street": "5 Test Rd", "Status": "Active",
            "Virtual": "N", "EnrollTotal": 486, "Latitude": 34.1, "Longitude": -118.3}
    row = fc.school_row(base)
    assert row["kind"] == "school" and (row["capacity"], row["capacity_unit"]) == (486, "students")
    assert fc.school_row({**base, "Virtual": "F"}) is None                  # online only: no students on site
    assert fc.school_row({**base, "Status": "Closed"}) is None


def test_id_is_stable_and_differs_by_source():
    a = fc.hud_row({"PROPERTY_ID": "7", "CLIENT_GROUP_TYPE": "Family", "LAT": 34.1, "LON": -118.3})
    b = fc.hud_row({"PROPERTY_ID": "7", "CLIENT_GROUP_TYPE": "Elderly", "LAT": 34.2, "LON": -118.4})
    c = fc.school_row({"CDSCode": "7", "Status": "Active", "Virtual": "N", "Latitude": 34.1, "Longitude": -118.3})
    assert a["id"] == b["id"] and a["id"] != c["id"]


# ---------------------------------------------------------------- link to a building

def test_point_inside_an_outline_links_to_that_building():
    rows = [facility(-118.2999, 34.1001)]
    fc.link_buildings(rows, [building("a", -118.3, 34.1), building("b", -118.31, 34.1)])
    assert rows[0]["building_id"] == "a" and rows[0]["building_distance_m"] == 0


def test_point_on_the_street_links_to_the_nearest_building():
    # 0.0001 degrees of latitude below building a is about 11 m
    rows = [facility(-118.2999, 34.0999)]
    fc.link_buildings(rows, [building("a", -118.3, 34.1), building("b", -118.3, 34.0990)])
    assert rows[0]["building_id"] == "a"
    assert 10 < rows[0]["building_distance_m"] < 12


def test_nearest_shed_is_passed_over():
    rows = [facility(-118.2999, 34.0999)]
    fc.link_buildings(rows, [building("shed", -118.3, 34.1, accessory=True), building("house", -118.3, 34.0994)])
    assert rows[0]["building_id"] == "house"


def test_point_far_from_every_building_has_no_link():
    rows = [facility(-118.2999, 34.0990)]                                   # about 110 m away
    fc.link_buildings(rows, [building("a", -118.3, 34.1)])
    assert rows[0]["building_id"] is None and rows[0]["building_distance_m"] is None
