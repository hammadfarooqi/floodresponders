"""Step 1: flatten CoStar commercial properties into one record per building, split by city.

Reads  data/costar-kit/ (local only, gitignored)
Writes data/processed/costar_{la,houston}.json  (gitignored: derived sponsor data)

Run: python3 data/pipeline/costar_extract.py
"""
import collections
import csv
import json
import re
from pathlib import Path

DATA = Path(__file__).resolve().parents[1]
KIT = DATA / "costar-kit"
OUT = DATA / "processed"
MARKETS = {14: "houston", 20: "la"}  # CoStar researchMarketId
ENUMS = json.loads((KIT / "schemas/enums.json").read_text())


def _md_enum(model: str, name: str) -> dict:
    """Read an enum table (### Name, then | value | meaning |) from a kit model page.
    enums.json has a residential PropertyType under the same name, so read the commercial one here."""
    text = (KIT / "models" / model).read_text().split(f"### {name}\n", 1)[1]
    table = {}
    for line in text.splitlines()[1:]:
        if line.startswith("### "):
            break
        m = re.match(r"\| (\d+) \| (\w+) \|", line)
        if m:
            table[int(m.group(1))] = m.group(2)
    return table


PROPERTY_TYPES = _md_enum("commercial-property.md", "PropertyType")


def enum(name, v):
    if v is None:
        return None
    return ENUMS.get(name, {}).get(str(v), str(v))


def main():
    OUT.mkdir(exist_ok=True)

    scans = collections.defaultdict(list)
    for r in csv.DictReader(open(KIT / "commercial-properties.csv")):
        if r["MatterportModelId"]:
            scans[r["PropertyId"]].append(r["MatterportModelId"])

    props = [json.loads(line) for line in open(KIT / "data/commercial-property.jsonl")]

    # Property-manager company names and phones, from company-detail (joined on contact locationId).
    pm_ids = {c["locationId"] for p in props for c in (p.get("contacts") or [])
              if c.get("contactRole") == 4 and c.get("locationId")}
    companies = {}
    for line in open(KIT / "data/company-detail.jsonl"):
        c = json.loads(line)
        if c["id"] in pm_ids:
            companies[c["id"]] = {"name": c.get("name") or (c.get("profile") or {}).get("companyName"),
                                  "phone": c.get("phoneNumber")}

    by_city = collections.defaultdict(list)
    for p in props:
        addr = p.get("primaryAddress") or {}
        city = MARKETS.get(addr.get("researchMarketId"))
        if not city:
            continue
        a = p.get("propertyApartment") or {}
        built = [e["year"] for e in (p.get("constructionEvents") or []) if e.get("eventType") == 2 and e.get("year")]
        elev = [e for e in (a.get("elevators") or []) if e.get("elevatorType") == 1]
        elevator_count = None
        if elev:
            e = elev[0]
            elevator_count = e.get("numElevators") if e.get("elevatorState") == 1 else 0
        pm = next((companies.get(c["locationId"]) for c in (p.get("contacts") or [])
                   if c.get("contactRole") == 4 and c.get("locationId") in companies), None)
        street = " ".join(str(x) for x in (addr.get("streetNumber"), addr.get("streetName"), addr.get("streetType")) if x)
        material = enum("BuildingConstructionMaterialType", p.get("buildingConstructionMaterial"))
        by_city[city].append({
            "id": str(p["id"]),
            "city": city,
            "name": p.get("buildingName") or street,
            "address": f"{street}, {addr.get('city')}, {addr.get('state')}",
            "lat": addr.get("latitude"),
            "lng": addr.get("longitude"),
            "property_type": PROPERTY_TYPES.get(p.get("propertyType"), "Unknown"),
            "stories": p.get("numStoriesAboveGrade"),
            "height_ft": p.get("buildingHeightInFeet"),
            "construction_material": None if material in (None, "Unknown") else material,
            "year_built": min(built) if built else None,
            "has_sprinklers": p.get("hasSprinklers"),
            "is_apartment": bool(a),
            "units": a.get("totalNumUnits") or None,
            "vacancy_pct": a.get("vacancyPercent"),
            "lifestyle": enum("ApartmentLifestyleType", a.get("apartmentLifestyleType")) if a else None,
            "is_senior": a.get("apartmentLifestyleType") == 2 or p.get("propertySubtype") in (26, 27, 28, 31),
            "apartment_style": enum("ApartmentStyleType", a.get("apartmentStyleType")) if a else None,
            "is_walkup": a.get("isWalkup"),
            "elevators": elevator_count,
            "rent_type": enum("ApartmentRentType", a.get("apartmentRentType")) if a else None,
            "manager": {"company": pm["name"], "phone": a.get("sitePhoneNumber") or pm["phone"]} if pm
            else ({"company": None, "phone": a.get("sitePhoneNumber")} if a.get("sitePhoneNumber") else None),
            "matterport_ids": scans.get(str(p["id"]), []),
        })

    for city, rows in by_city.items():
        path = OUT / f"costar_{city}.json"
        path.write_text(json.dumps(rows, indent=1))
        print(f"{city}: {len(rows)} buildings -> {path.relative_to(DATA.parent)}")
        print("   types:", collections.Counter(r["property_type"] for r in rows).most_common())


if __name__ == "__main__":
    main()
