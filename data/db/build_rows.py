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
MATTERPORT_REFERENCE_TYPES = {36, 234}
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


def commercial_property(record):
    """One line of commercial-property.jsonl -> a costar_properties row."""
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
        "total_units": apt.get("totalNumUnits") or hotel.get("numUnits") or None,
        "floor_area_sqft": record.get("grossBuildingAreaSquareFeet"),
        "is_walkup": apt.get("isWalkup"),
        "passenger_elevators": elevators,
        "has_sprinklers": record.get("hasSprinklers"),
        "has_basement": None,
        "has_accessibility_features": None,
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
        **zone,
        "parcel_tree_cover_pct": parcel.get("parcel-tree-cover.percent"),
        "parcel_hardscape_pct": parcel.get("hardscapes.percent"),
        "vexcel_survey": parcel.get("metadata.collection"),
        "vexcel_survey_date": survey_date[:10] if survey_date else None,
    }


_VEXCEL_COLUMNS = ("parcel_key", "footprint", "footprint_area_m2", "ground_elevation_m", "vexcel_height_m",
                   "vexcel_building_type", "is_primary_on_parcel", "roof_condition", "roof_material", "roof_shape",
                   "tree_density_zone1", "tree_density_zone2", "tree_density_zone3", "tree_density_zone4",
                   "building_density_zone1", "building_density_zone2", "building_density_zone3",
                   "building_density_zone4", "parcel_tree_cover_pct", "parcel_hardscape_pct", "vexcel_survey",
                   "vexcel_survey_date")


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


def resolve(row, prop=None, units_share=None):
    """Fill the resolved columns of one buildings row. prop is its costar_properties row, or None."""
    prop = prop or {}
    vexcel_type = row.get("vexcel_building_type")
    vexcel_height = row.get("vexcel_height_m")
    row["is_accessory"] = vexcel_type in ACCESSORY_TYPES
    row["height_suspect"] = (vexcel_height is not None and vexcel_height < SUSPECT_HEIGHT_M
                             and not row["is_accessory"])
    usable_height = vexcel_height if vexcel_height is not None and not row["height_suspect"] else None

    if prop.get("property_type"):
        row["building_type"], row["building_type_source"] = prop["property_type"], "costar"
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

    for column in ("construction_material", "year_built", "is_walkup", "passenger_elevators", "has_sprinklers"):
        row[column] = prop.get(column)
    row["costar_id"] = prop.get("costar_id")
    row.setdefault("shares_costar_property", False)
    sources = [row["building_type_source"], row["height_source"], row["floors_source"], row["units_source"]]
    row["confidence"] = round(sum(SOURCE_WEIGHT[s] for s in sources) / len(sources), 2)
    return row


def build(parcel_features, properties):
    """All buildings rows for the given Vexcel parcels and costar_properties rows.

    A CoStar property goes to the parcel that contains its point. Its values go to every structure on that parcel
    that is not a shed or garage (to all structures when there are only sheds and garages). Units are split by
    footprint area x height. A property with no parcel, or a parcel with no structure, gets its own row.
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

    rows = []
    for parcel in parcels:
        structures = parcel["structures"]
        prop = parcel["props"][0] if parcel["props"] else None
        unmatched.extend(parcel["props"][1:])           # a second property on one parcel keeps its own row
        targets = [s for s in structures if s["vexcel_building_type"] not in ACCESSORY_TYPES] or structures
        shares = {}
        if prop and prop.get("total_units"):
            weights = [(s.get("footprint_area_m2") or 0) * max(s.get("vexcel_height_m") or 0, SUSPECT_HEIGHT_M)
                       for s in targets]
            shares = {s["id"]: u for s, u in zip(targets, split_units(prop["total_units"], weights))}
        target_ids = {s["id"] for s in targets}
        for s in structures:
            attached = prop if prop and s["id"] in target_ids else None
            s["shares_costar_property"] = bool(attached) and len(targets) > 1
            rows.append(resolve(s, attached, shares.get(s["id"])))

    for prop in unmatched:
        row = {column: None for column in _VEXCEL_COLUMNS}
        row.update({"id": str(uuid.uuid5(_NAMESPACE, f"costar:{prop['costar_id']}")),
                    "lat": prop["lat"], "lng": prop["lng"], "location": prop["location"]})
        rows.append(resolve(row, prop, prop.get("total_units")))
    return rows
