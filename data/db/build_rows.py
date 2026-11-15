"""Turn Vexcel parcels and CoStar records into rows for the Supabase tables.

Pure functions, standard library only. No network and no file access here: load_supabase.py does that.
The rules are described in DATABASE.md. Change a rule in both places.
"""
import hashlib
import re
import uuid

# Assumptions. DATABASE.md lists them; keep the two in step.
METERS_PER_FLOOR = 3.3
FLOOR_AREA_PER_UNIT_M2 = 85.0
PEOPLE_PER_UNIT = 2.4
SUSPECT_HEIGHT_M = 3.0
SOURCE_WEIGHT = {"costar": 1.0, "assessor": 0.8, "vexcel": 0.6, "estimated": 0.3, None: 0.0}

ACCESSORY_TYPES = {"shed", "garages_carports"}
VEXCEL_TYPE = {
    "single_family": "single_family",
    "mobile_home": "single_family",
    "multiple_family": "multi_family",
    "condo_apartment": "multi_family",
    "commercial": "commercial",
    "institutional_buildings": "institutional",
    "industrial_buildings": "industrial",
    "shed": "accessory",
    "garages_carports": "accessory",
}
COSTAR_PROPERTY_TYPE = {
    1: "hotel", 2: "industrial", 3: "land", 5: "office", 6: "retail", 7: "industrial",
    8: "commercial", 9: "commercial", 10: "commercial", 11: "multi_family", 13: "institutional",
}
COSTAR_HOME_TYPE = {1: "single_family", 2: "single_family", 64: "single_family"}  # other home types: multi_family
COSTAR_MATERIAL = {1: "masonry", 2: "metal", 3: "reinforced_concrete", 4: "steel", 5: "wood_frame",
                   6: "masonry", 7: "masonry"}
COSTAR_RENT_TYPE = {1: "market", 2: "affordable", 3: "mixed"}       # mixed: market-rate and affordable units
COSTAR_APARTMENT_STYLE = {1: "garden", 2: "mid_rise", 3: "high_rise", 4: "low_rise", 5: "single_family",
                          6: "townhome"}
MATTERPORT_REFERENCE_TYPES = {36, 234}
ASSESSOR_USE_TYPE = {"Commercial": "commercial", "Recreational": "commercial", "Industrial": "industrial",
                     "Institutional": "institutional", "Government": "institutional"}
# The Assessor unit count of a lot is a count of homes on residential lots and on lots with these descriptions.
# On other lots it also counts shops or suites, so we do not use it.
ASSESSOR_HOME_DESCRIPTIONS = {"Store Combination", "Homes For Aged & Others"}
ASSESSOR_UNKNOWN_UNITS = 999            # placeholder on the tax roll, for example a single home with 1 + 999 units
LOT_CELL_DEG = 0.002                    # size of a cell of the lot lookup grid, about 200 m
_NAMESPACE = uuid.UUID("6f1b0c1e-59a0-4c59-9d0e-0b6a3c1d7e59")


# ---------------------------------------------------------------- geometry

def parse_wkt_polygons(wkt):
    """'POLYGON((x y, ...), (hole))' or 'MULTIPOLYGON(...)' -> [[ring, ...], ...], ring = [(lng, lat), ...]."""
    body = wkt[wkt.index("("):]
    if not wkt.lstrip().upper().startswith("MULTI"):
        body = "(" + body + ")"
    polygons, depth, start = [], 0, 0
    for i, ch in enumerate(body):
        if ch == "(":
            depth += 1
            if depth == 2:
                polygons.append([])
            elif depth == 3:
                start = i + 1
        elif ch == ")":
            if depth == 3:
                points = body[start:i].split(",")
                polygons[-1].append([tuple(float(v) for v in pt.split()[:2]) for pt in points])
            depth -= 1
    return polygons


def geojson_polygons(geometry):
    """GeoJSON Polygon or MultiPolygon -> the same shape as parse_wkt_polygons."""
    coords = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
    return [[[(p[0], p[1]) for p in ring] for ring in poly] for poly in coords]


def to_multipolygon_ewkt(polygons):
    parts = []
    for rings in polygons:
        parts.append("(" + ",".join("(" + ",".join(f"{x} {y}" for x, y in ring) + ")" for ring in rings) + ")")
    return "SRID=4326;MULTIPOLYGON(" + ",".join(parts) + ")"


def point_ewkt(lng, lat):
    return f"SRID=4326;POINT({lng} {lat})"


def _in_ring(lng, lat, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lng < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def point_in_polygons(lng, lat, polygons):
    """True when the point is inside any polygon (outer ring) and not inside one of its holes."""
    for rings in polygons:
        if _in_ring(lng, lat, rings[0]) and not any(_in_ring(lng, lat, hole) for hole in rings[1:]):
            return True
    return False


def bounds(polygons):
    xs = [x for rings in polygons for x, _ in rings[0]]
    ys = [y for rings in polygons for _, y in rings[0]]
    return min(xs), min(ys), max(xs), max(ys)


def center(polygons):
    """Mean of the outer ring vertices of the largest polygon. Good enough to place a marker."""
    ring = max((rings[0] for rings in polygons), key=len)
    pts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    return sum(x for x, _ in pts) / len(pts), sum(y for _, y in pts) / len(pts)


# ---------------------------------------------------------------- CoStar

def _year_built(record):
    years = [e.get("year") for e in record.get("constructionEvents") or [] if e.get("eventType") == 2]
    return min((y for y in years if y), default=None)


def _passenger_elevators(type_block):
    """(count or None, exists or None) for passenger elevators in a CoStar type block."""
    entries = [e for e in (type_block.get("elevators") or []) + ((type_block.get("structural") or {}).get("elevators") or [])
               if e.get("elevatorType") == 1]
    if not entries:
        return None, None
    counts = [e["numElevators"] for e in entries if e.get("numElevators")]
    if counts:
        return sum(counts), True
    if any(e.get("elevatorState") == 2 for e in entries):
        return 0, False
    return None, True


def _matterport_ids(record):
    found = []

    def walk(obj):
        if isinstance(obj, dict):
            if obj.get("videoKey") and obj.get("videoExternalReferenceType") in MATTERPORT_REFERENCE_TYPES:
                found.append(obj["videoKey"])
            for value in obj.values():
                walk(value)
        elif isinstance(obj, list):
            for value in obj:
                walk(value)

    walk(record)
    return sorted(set(found))


def _street_address(a):
    parts = [a.get("streetNumber"), a.get("streetDirection"), a.get("streetName"), a.get("streetType"), a.get("streetSuffix")]
    return " ".join(str(p).strip() for p in parts if p) or None


def commercial_property(record, listing_units=None):
    """One line of commercial-property.jsonl -> a costar_properties row.

    listing_units: the unit count of the property in apartment-listing.jsonl, used when it has no floor plans.
    The unit count is the sum of the floor plans. propertyApartment.totalNumUnits is not used: it counts only the
    units listed one by one, and is far too low for most properties (DATABASE.md, problem 36).
    """
    a = record["primaryAddress"]
    apt = record.get("propertyApartment") or {}
    blocks = [record.get(k) or {} for k in ("propertyApartment", "propertyOffice", "propertyRetail",
                                             "propertyIndustrial", "propertyFlex")]
    elevators = None
    for block in blocks:
        count, _ = _passenger_elevators(block)
        if count is not None:
            elevators = (elevators or 0) + count
    height_ft = record.get("buildingHeightInFeet")
    hotel = record.get("propertyHospitality") or {}
    floor_plan_units = sum(plan.get("numUnits") or 0 for plan in apt.get("models") or [])
    lot_numbers = record.get("parcelNumbers") or []
    return {
        "costar_id": str(record["id"]),
        "kind": "commercial",
        "name": record.get("buildingName"),
        "address": _street_address(a),
        "postcode": (str(a["postcode"])[:5] if a.get("postcode") else None),
        "lat": a["latitude"], "lng": a["longitude"],
        "location": point_ewkt(a["longitude"], a["latitude"]),
        "property_type": COSTAR_PROPERTY_TYPE.get(record.get("propertyType")),
        "is_senior_housing": apt.get("apartmentLifestyleType") == 2 if apt else None,
        "is_student_housing": apt.get("apartmentLifestyleType") == 3 if apt else None,
        "floors": record.get("numStoriesAboveGrade") or None,
        "height_m": round(height_ft * 0.3048, 1) if height_ft else None,
        "year_built": _year_built(record),
        "construction_material": COSTAR_MATERIAL.get(record.get("buildingConstructionMaterial")),
        "total_units": floor_plan_units or listing_units or hotel.get("numUnits") or None,
        "floor_area_sqft": record.get("grossBuildingAreaSquareFeet"),
        "is_walkup": apt.get("isWalkup"),
        "passenger_elevators": elevators,
        "has_sprinklers": record.get("hasSprinklers"),
        "has_basement": None,
        "has_accessibility_features": None,
        "vacancy_pct": apt.get("vacancyPercent"),
        "rent_type": COSTAR_RENT_TYPE.get(apt.get("apartmentRentType")),
        "num_buildings": apt.get("numBuildings") or None,
        "apartment_style": COSTAR_APARTMENT_STYLE.get(apt.get("apartmentStyleType")),
        "parcel_number": re.sub(r"\D", "", lot_numbers[0]) or None if lot_numbers else None,
        "matterport_model_ids": _matterport_ids(record),
    }


def residential_property(record):
    """One line of residential-listings.jsonl -> a costar_properties row, or None when it has no location.

    Several listings can describe one home. They share property.address.id, so the row id is built from it.
    """
    p = record["property"]
    a = p.get("address") or {}
    if a.get("latitude") is None or a.get("longitude") is None or a.get("id") is None:
        return None
    reso = record.get("resoValues") or {}
    home_type = p.get("listingPropertyType")
    return {
        "costar_id": f"res-{a['id']}",
        "kind": "residential",
        "name": None,
        "address": a.get("fullStreetAddress"),
        "postcode": a.get("zip"),
        "lat": a["latitude"], "lng": a["longitude"],
        "location": point_ewkt(a["longitude"], a["latitude"]),
        "property_type": COSTAR_HOME_TYPE.get(home_type, "multi_family" if home_type else None),
        "is_senior_housing": None,
        "is_student_housing": None,
        "floors": p.get("stories") or None,
        "height_m": None,
        "year_built": p.get("yearBuilt"),
        "construction_material": None,
        "total_units": 1 if COSTAR_HOME_TYPE.get(home_type) else None,
        "floor_area_sqft": p.get("sqftMax"),
        "is_walkup": None,
        "passenger_elevators": None,
        "has_sprinklers": None,
        "has_basement": reso.get("hasBasement"),
        "has_accessibility_features": reso.get("hasAccessibilityFeatures"),
        "vacancy_pct": None, "rent_type": None, "num_buildings": None, "apartment_style": None,
        "parcel_number": None,
        "matterport_model_ids": sorted({m["videoKey"] for m in record.get("media") or []
                                        if m.get("videoKey") and m.get("externalReferenceType") in MATTERPORT_REFERENCE_TYPES}),
    }


def contacts_for(record, company_names, apartment_manager=None):
    """Contact rows for one commercial property.

    company_names: {company-detail id: name}. apartment_manager: management company name from the apartment listing.
    """
    costar_id = str(record["id"])
    rows = []

    def add(role, company, phone):
        if not company and not phone:
            return
        key = f"contact:{costar_id}:{role}:{company}:{phone}"
        rows.append({"id": str(uuid.uuid5(_NAMESPACE, key)), "costar_id": costar_id, "role": role,
                     "company_name": company, "phone": phone, "is_test_number": False})

    site_phone = (record.get("propertyApartment") or {}).get("sitePhoneNumber") \
        or (record.get("propertyHospitality") or {}).get("phoneNumber")
    add("site_office", record.get("buildingName"), site_phone)
    managers = [c for c in record.get("contacts") or [] if c.get("contactRole") == 4]
    for c in managers:
        add("property_manager", company_names.get(c.get("locationId")) or apartment_manager, c.get("contactPhoneNumber"))
    if not managers and apartment_manager:
        add("property_manager", apartment_manager, None)
    return list({r["id"]: r for r in rows}.values())


# ---------------------------------------------------------------- Vexcel

def _clean(value):
    return None if value in (None, "NULL", "") else value


def parcel_key(feature):
    ring = geojson_polygons(feature["geometry"])[0][0]
    return hashlib.md5(repr(ring).encode()).hexdigest()[:16]


def vexcel_structure(feature, structure):
    """The Vexcel columns of one buildings row."""
    parcel = feature["properties"]
    polygons = parse_wkt_polygons(structure["footprint.wkt"])
    centroid = structure.get("roof-characteristics.centroid.wkt")
    if centroid:
        lng, lat = (float(v) for v in re.findall(r"-?\d+\.?\d*", centroid)[:2])
    else:
        lng, lat = center(polygons)
    key = parcel_key(feature)
    condition = structure.get("roof-characteristics.condition")
    survey_date = parcel.get("metadata.ortho-date-estimate")
    zone = {f"{kind}_density_zone{n}": structure.get(f"defensible-space.zone{n}-{kind}")
            for kind in ("tree", "building") for n in (1, 2, 3, 4)}
    return {
        "id": str(uuid.uuid5(_NAMESPACE, f"{key}:{structure['footprint.wkt'][:120]}")),
        "parcel_key": key,
        "lat": lat, "lng": lng, "location": point_ewkt(lng, lat),
        "footprint": to_multipolygon_ewkt(polygons),
        "footprint_area_m2": structure.get("footprint.area"),
        "ground_elevation_m": structure.get("ground-elevation.value"),
        "vexcel_height_m": structure.get("roof-characteristics.height"),
        "vexcel_building_type": _clean(structure.get("building-type.class")),
        "is_primary_on_parcel": bool(structure.get("primary-structure")),
        "roof_condition": int(condition) if condition is not None else None,
        "roof_material": _clean(structure.get("roof-characteristics.material.class")),
        "roof_shape": _clean(structure.get("roof-characteristics.shape.value")),
        "roof_tree_cover_pct": structure.get("roof-characteristics.tree-cover.percent"),
        "roof_structural_damage": structure.get("roof-defects.structural-damage.detected"),
        "roof_missing_material": structure.get("roof-defects.missing-material.detected"),
        "roof_tarp": structure.get("roof-defects.tarp.detected"),
        "roof_debris": structure.get("roof-defects.debris.detected"),
        "has_solar_panels": structure.get("roof-objects.solar.value"),
        "vexcel_type_confidence": structure.get("building-type.score"),
        "roof_material_confidence": structure.get("roof-characteristics.material.score"),
        "roof_shape_confidence": structure.get("roof-characteristics.shape.score"),
        **zone,
        "parcel_tree_cover_pct": parcel.get("parcel-tree-cover.percent"),
        "parcel_hardscape_pct": parcel.get("hardscapes.percent"),
        "vexcel_survey": parcel.get("metadata.collection"),
        "vexcel_survey_date": survey_date[:10] if survey_date else None,
    }


_VEXCEL_COLUMNS = ("parcel_key", "footprint", "footprint_area_m2", "ground_elevation_m", "vexcel_height_m",
                   "vexcel_building_type", "is_primary_on_parcel", "roof_condition", "roof_material", "roof_shape",
                   "roof_tree_cover_pct", "roof_structural_damage", "roof_missing_material", "roof_tarp",
                   "roof_debris", "has_solar_panels", "vexcel_type_confidence", "roof_material_confidence",
                   "roof_shape_confidence",
                   "tree_density_zone1", "tree_density_zone2", "tree_density_zone3", "tree_density_zone4",
                   "building_density_zone1", "building_density_zone2", "building_density_zone3",
                   "building_density_zone4", "parcel_tree_cover_pct", "parcel_hardscape_pct", "vexcel_survey",
                   "vexcel_survey_date")


# ---------------------------------------------------------------- County Assessor

def assessor_lot(feature):
    """One feature of the Los Angeles County parcel layer (the tax record of one lot) -> the values we keep."""
    a = feature["attributes"]
    slots = range(1, 6)                 # the record describes up to 5 buildings on the lot
    has_homes = a.get("UseType") == "Residential" or a.get("UseDescription") in ASSESSOR_HOME_DESCRIPTIONS
    years = [int(y) for y in (str(a.get(f"YearBuilt{n}") or "") for n in slots) if y.isdigit() and int(y) > 1800]
    units = [a.get(f"Units{n}") or 0 for n in slots]
    street = " ".join(" ".join(str(a.get(f"Situs{part}") or "") for part in ("HouseNo", "Fraction", "Direction",
                                                                             "Street")).split())
    return {"address": street or None, "sqft": sum(a.get(f"SQFTmain{n}") or 0 for n in slots),
            "ain": a["AIN"], "rings": [[(p[0], p[1]) for p in ring] for ring in feature["geometry"]["rings"]],
            "use_type": a.get("UseType"), "use_description": a.get("UseDescription"),
            "units": sum(u for u in units if u != ASSESSOR_UNKNOWN_UNITS) if has_homes else 0,
            "bedrooms": sum(a.get(f"Bedrooms{n}") or 0 for n in slots),
            "year_built": min(years, default=None)}


def index_lots(lots):
    """Grid of lots for a fast lookup by point. A lot that comes twice (it lies in two tiles) is kept once."""
    grid, seen = {}, set()
    for lot in lots:
        if lot["ain"] in seen:
            continue
        seen.add(lot["ain"])
        xs = [x for ring in lot["rings"] for x, _ in ring]
        ys = [y for ring in lot["rings"] for _, y in ring]
        lot["bounds"] = (min(xs), min(ys), max(xs), max(ys))
        for i in range(int(min(xs) // LOT_CELL_DEG), int(max(xs) // LOT_CELL_DEG) + 1):
            for j in range(int(min(ys) // LOT_CELL_DEG), int(max(ys) // LOT_CELL_DEG) + 1):
                grid.setdefault((i, j), []).append(lot)
    return grid


def lots_at(grid, lng, lat):
    """Every lot that contains the point. The units of a condominium are separate lots with one shared outline."""
    found = []
    for lot in grid.get((int(lng // LOT_CELL_DEG), int(lat // LOT_CELL_DEG)), ()):
        west, south, east, north = lot["bounds"]
        if west <= lng <= east and south <= lat <= north \
                and sum(_in_ring(lng, lat, ring) for ring in lot["rings"]) % 2:     # odd: inside and not in a hole
            found.append(lot)
    return found


def merge_lots(lots):
    """The lots under one structure as one record, or None when there is no lot."""
    if not lots:
        return None
    main = min(lots, key=lambda lot: (-lot["units"], lot["ain"]))
    years = [lot["year_built"] for lot in lots if lot["year_built"]]
    return {"key": tuple(sorted(lot["ain"] for lot in lots)), "ain": main["ain"], "use_type": main["use_type"],
            "use_description": main["use_description"], "units": sum(lot["units"] for lot in lots),
            "bedrooms": sum(lot["bedrooms"] for lot in lots), "year_built": min(years, default=None),
            "address": main["address"], "sqft": sum(lot["sqft"] for lot in lots)}


def assessor_building_type(lot):
    """Our building type for a merged lot, or None when the tax record does not say."""
    if lot["units"] >= 2:
        return "multi_family"
    if lot["use_type"] == "Residential":
        return "single_family" if lot["use_description"] == "Single" else "multi_family"
    if lot["use_description"] == "Hotel & Motels":
        return "hotel"
    return ASSESSOR_USE_TYPE.get(lot["use_type"])


# ---------------------------------------------------------------- resolve

def split_units(total, weights):
    """Split a whole number across weights. The parts are whole numbers and add up to total."""
    if not weights:
        return []
    if not sum(weights):
        weights = [1] * len(weights)
    exact = [total * w / sum(weights) for w in weights]
    parts = [int(e) for e in exact]
    by_remainder = sorted(range(len(exact)), key=lambda i: exact[i] - parts[i], reverse=True)
    for i in by_remainder[: total - sum(parts)]:
        parts[i] += 1
    return parts


def resolve(row, prop=None, units_share=None, lot=None, lot_units=None):
    """Fill the resolved columns of one buildings row.

    prop: its costar_properties row, or None. units_share: its part of the CoStar unit count, or None.
    lot: the merged Assessor lot under the structure, or None. lot_units: its part of the homes on that lot, or None.
    """
    prop = prop or {}
    vexcel_type = row.get("vexcel_building_type")
    vexcel_height = row.get("vexcel_height_m")
    row["is_accessory"] = vexcel_type in ACCESSORY_TYPES
    row["height_suspect"] = (vexcel_height is not None and vexcel_height < SUSPECT_HEIGHT_M
                             and not row["is_accessory"])
    usable_height = vexcel_height if vexcel_height is not None and not row["height_suspect"] else None

    lot_type = assessor_building_type(lot) if lot and not row["is_accessory"] else None
    if prop.get("property_type"):
        row["building_type"], row["building_type_source"] = prop["property_type"], "costar"
    elif lot_type:
        row["building_type"], row["building_type_source"] = lot_type, "assessor"
    elif VEXCEL_TYPE.get(vexcel_type):
        row["building_type"], row["building_type_source"] = VEXCEL_TYPE[vexcel_type], "vexcel"
    else:
        row["building_type"], row["building_type_source"] = None, None

    if prop.get("height_m"):
        row["height_m"], row["height_source"] = prop["height_m"], "costar"
    elif prop.get("floors"):
        row["height_m"], row["height_source"] = round(prop["floors"] * METERS_PER_FLOOR, 1), "estimated"
    elif usable_height is not None:
        row["height_m"], row["height_source"] = round(usable_height, 1), "vexcel"
    else:
        row["height_m"], row["height_source"] = None, None

    if prop.get("floors"):
        row["floors"], row["floors_source"] = prop["floors"], "costar"
    elif usable_height is not None and not row["is_accessory"]:
        row["floors"], row["floors_source"] = max(1, round(usable_height / METERS_PER_FLOOR)), "estimated"
    else:
        row["floors"], row["floors_source"] = None, None

    area = row.get("footprint_area_m2")
    if units_share is not None:
        row["units"], row["units_source"] = units_share, "costar"
    elif row["is_accessory"]:
        row["units"], row["units_source"] = None, None
    elif lot_units is not None:
        row["units"], row["units_source"] = lot_units, "assessor"
    elif row["building_type"] == "single_family":
        row["units"], row["units_source"] = 1, "estimated"
    elif row["building_type"] == "multi_family" and area and row["floors"]:
        row["units"] = max(2, round(area * row["floors"] / FLOOR_AREA_PER_UNIT_M2))
        row["units_source"] = "estimated"
    else:
        row["units"], row["units_source"] = None, None

    if row["units"] is not None and not row["is_accessory"]:
        row["est_occupants"], row["occupants_source"] = round(row["units"] * PEOPLE_PER_UNIT), "estimated"
    else:
        row["est_occupants"], row["occupants_source"] = None, None

    for column in ("construction_material", "is_walkup", "passenger_elevators", "has_sprinklers"):
        row[column] = prop.get(column)
    if prop.get("year_built"):
        row["year_built"], row["year_built_source"] = prop["year_built"], "costar"
    elif lot and lot["year_built"]:
        row["year_built"], row["year_built_source"] = lot["year_built"], "assessor"
    else:
        row["year_built"], row["year_built_source"] = None, None
    lot = lot or {}
    row["assessor_ain"] = lot.get("ain")
    row["assessor_use_type"] = lot.get("use_type")
    row["assessor_use_description"] = lot.get("use_description")
    row["assessor_units"] = lot.get("units") or None                # 0 on the tax roll means "not known"
    row["assessor_bedrooms"] = lot.get("bedrooms") or None
    row["assessor_year_built"] = lot.get("year_built")
    row["assessor_address"] = lot.get("address")
    row["assessor_sqft"] = lot.get("sqft") or None                  # 0 on the tax roll means "not known"
    row["costar_id"] = prop.get("costar_id")
    row.setdefault("shares_costar_property", False)
    sources = [row["building_type_source"], row["height_source"], row["floors_source"], row["units_source"]]
    row["confidence"] = round(sum(SOURCE_WEIGHT[s] for s in sources) / len(sources), 2)
    return row


def _size(structure):
    """Weight of a structure when a unit count is split: footprint area x height."""
    return (structure.get("footprint_area_m2") or 0) * max(structure.get("vexcel_height_m") or 0, SUSPECT_HEIGHT_M)


def build(parcel_features, properties, lot_features=()):
    """All buildings rows for the given Vexcel parcels, costar_properties rows and County Assessor lots.

    A CoStar property goes to the parcel that contains its point. Its values go to every structure on that parcel
    that is not a shed or garage (to all structures when there are only sheds and garages). Units are split by
    footprint area x height. A property with no parcel, or a parcel with no structure, gets its own row.

    An Assessor lot goes to every structure whose center is inside it. The homes of the lot that CoStar did not
    count go to its structures that have no CoStar unit count and are not a shed or garage, split the same way.
    """
    parcels = []
    for feature in parcel_features:
        polygons = geojson_polygons(feature["geometry"])
        structures = [vexcel_structure(feature, s) for s in feature["properties"].get("structures") or []]
        parcels.append({"polygons": polygons, "bounds": bounds(polygons), "structures": structures, "props": []})

    unmatched = []
    for prop in properties:
        lng, lat = prop["lng"], prop["lat"]
        home = next((p for p in parcels
                     if p["bounds"][0] <= lng <= p["bounds"][2] and p["bounds"][1] <= lat <= p["bounds"][3]
                     and point_in_polygons(lng, lat, p["polygons"])), None)
        if home and home["structures"]:
            home["props"].append(prop)
        else:
            unmatched.append(prop)

    pending = []                                        # (structure, its CoStar property, its CoStar units)
    for parcel in parcels:
        structures = parcel["structures"]
        prop = parcel["props"][0] if parcel["props"] else None
        unmatched.extend(parcel["props"][1:])           # a second property on one parcel keeps its own row
        targets = [s for s in structures if s["vexcel_building_type"] not in ACCESSORY_TYPES] or structures
        shares = {}
        if prop and prop.get("total_units"):
            shares = {s["id"]: u for s, u in zip(targets, split_units(prop["total_units"], [_size(s) for s in targets]))}
        target_ids = {s["id"] for s in targets}
        for s in structures:
            attached = prop if prop and s["id"] in target_ids else None
            s["shares_costar_property"] = bool(attached) and len(targets) > 1
            pending.append((s, attached, shares.get(s["id"])))

    grid = index_lots([assessor_lot(f) for f in lot_features])
    lot_of, on_lot = {}, {}
    for s, _, costar_units in pending:
        lot_of[s["id"]] = lot = merge_lots(lots_at(grid, s["lng"], s["lat"]))
        if lot and lot["units"] and s["vexcel_building_type"] not in ACCESSORY_TYPES:
            on_lot.setdefault(lot["key"], []).append((s, costar_units))
    lot_units = {}
    for members in on_lot.values():
        homes = lot_of[members[0][0]["id"]]["units"]
        left = max(0, homes - sum(units or 0 for _, units in members))
        targets = [s for s, units in members if units is None]
        lot_units.update({s["id"]: u for s, u in zip(targets, split_units(left, [_size(s) for s in targets]))})

    rows = [resolve(s, attached, costar_units, lot_of[s["id"]], lot_units.get(s["id"]))
            for s, attached, costar_units in pending]
    for prop in unmatched:
        row = {column: None for column in _VEXCEL_COLUMNS}
        row.update({"id": str(uuid.uuid5(_NAMESPACE, f"costar:{prop['costar_id']}")),
                    "lat": prop["lat"], "lng": prop["lng"], "location": prop["location"]})
        rows.append(resolve(row, prop, prop.get("total_units")))
    return rows
