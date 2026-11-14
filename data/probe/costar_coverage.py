"""How often each Roll Call field is filled in the CoStar commercial-property data.

Usage: python3 data/probe/costar_coverage.py   (expects the kit unzipped at data/costar-kit/)
"""
import collections
import json
from pathlib import Path

KIT = Path(__file__).resolve().parents[1] / "costar-kit"
ENUMS = json.loads((KIT / "schemas/enums.json").read_text())


def enum(name, v):
    return ENUMS.get(name, {}).get(str(v), v)


props = [json.loads(line) for line in open(KIT / "data/commercial-property.jsonl")]
apt = [p for p in props if p.get("propertyApartment")]
print(f"properties: {len(props)}  with apartment block: {len(apt)}")
print("property types:", collections.Counter(enum("PropertyType", p.get("propertyType")) for p in props).most_common())


def filled(rows, fn):
    n = 0
    for p in rows:
        try:
            v = fn(p)
        except (KeyError, TypeError, IndexError):
            v = None
        if v not in (None, 0, [], "", False):
            n += 1
    return f"{n}/{len(rows)} ({100 * n / len(rows):.0f}%)"


A = lambda p: p["propertyApartment"]  # noqa: E731
checks = {
    "lat/lng": lambda p: p["primaryAddress"]["latitude"],
    "numStoriesAboveGrade": lambda p: p["numStoriesAboveGrade"],
    "buildingHeightInFeet": lambda p: p["buildingHeightInFeet"],
    "buildingConstructionMaterial": lambda p: p["buildingConstructionMaterial"],
    "hasSprinklers (known)": lambda p: p["hasSprinklers"] is not None,
    "year built (constructionEvents)": lambda p: p["constructionEvents"],
    "elevators (top level)": lambda p: p["elevators"],
    "contacts": lambda p: p["contacts"],
    "floors": lambda p: p["floors"],
}
apt_checks = {
    "apt totalNumUnits": lambda p: A(p)["totalNumUnits"],
    "apt vacancyPercent (known)": lambda p: A(p)["vacancyPercent"] is not None,
    "apt sitePhoneNumber": lambda p: A(p)["sitePhoneNumber"],
    "apt elevators": lambda p: A(p)["elevators"],
    "apt lifestyle known": lambda p: A(p)["apartmentLifestyleType"],
}
for k, fn in checks.items():
    print(f"{k:34s} {filled(props, fn)}")
for k, fn in apt_checks.items():
    print(f"{k:34s} {filled(apt, fn)}")

print("construction material:", collections.Counter(
    enum("BuildingConstructionMaterialType", p.get("buildingConstructionMaterial")) for p in props).most_common())
print("apartment lifestyle:", collections.Counter(
    enum("ApartmentLifestyleType", A(p).get("apartmentLifestyleType")) for p in apt).most_common())
print("health-care subtypes:", collections.Counter(
    enum("PropertySubtype", p.get("propertySubtype")) for p in props
    if "Health" in str(enum("PropertyType", p.get("propertyType")))).most_common())
print("stories histogram:", sorted(collections.Counter(p.get("numStoriesAboveGrade") for p in props).items(),
                                   key=lambda kv: (kv[0] is None, kv[0] or 0))[:40])
print("contact roles:", collections.Counter(
    enum("ContactRole", c.get("contactRole")) for p in props for c in (p.get("contacts") or [])).most_common(12))

seniors = [p for p in apt if A(p).get("apartmentLifestyleType") == 2]
print("\nsenior communities (sample):")
for p in seniors[:8]:
    a = p["primaryAddress"]
    print(f"  {p['id']} {p.get('buildingName')!r} {a.get('streetNumber')} {a.get('streetName')} {a.get('city')} "
          f"units={A(p).get('totalNumUnits')} stories={p.get('numStoriesAboveGrade')} "
          f"material={enum('BuildingConstructionMaterialType', p.get('buildingConstructionMaterial'))} "
          f"phone={A(p).get('sitePhoneNumber')}")
