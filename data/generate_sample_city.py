"""Generate the fictional sample-city fixtures beside this script."""

import json
from pathlib import Path
from random import Random

SEED = 42
CENTER_LAT = 34.101
CENTER_LNG = -118.331
LAT_STEP = 0.001
LNG_STEP = 0.0012
PROPERTY_NAMES = {
    "residential": "Apartments",
    "senior_housing": "Senior Living",
    "commercial": "Office Center",
    "mixed": "Market Lofts",
}
STREETS = ("Juniper", "Sycamore", "Birch", "Pine", "Magnolia", "Cypress")


def generate_buildings(rng):
    buildings = []
    for row, street in enumerate(STREETS):
        for column in range(8):
            number = len(buildings) + 1
            property_type = tuple(PROPERTY_NAMES)[(row + column) % len(PROPERTY_NAMES)]
            lat = round(CENTER_LAT + (row - 2.5) * LAT_STEP, 6)
            lng = round(CENTER_LNG + (column - 3.5) * LNG_STEP, 6)
            south, north = round(lat - 0.00012, 6), round(lat + 0.00012, 6)
            west, east = round(lng - 0.00015, 6), round(lng + 0.00015, 6)
            floors = rng.randint(1, 10)
            units = floors * rng.randint(2, 8)
            buildings.append({
                "id": f"sample-building-{number:02}",
                "name": f"{street} {PROPERTY_NAMES[property_type]} {column + 1}",
                "address": f"{100 + column * 10} Fictional {street} Way",
                "lat": lat,
                "lng": lng,
                "footprint": [
                    [west, south], [east, south], [east, north], [west, north], [west, south],
                ],
                "height_m": round(floors * rng.uniform(3.0, 4.0), 1),
                "elevation_m": round(85 + 9 * row + rng.uniform(0, 7), 1),
                "roof_condition": rng.choice(("good", "fair", "poor")),
                "property_type": property_type,
                "units": units,
                "tenants": units * rng.randint(1, 5),
                "floors": floors,
                "elevators": rng.randint(0, 1) if floors <= 4 else rng.randint(1, 3),
                "construction_type": rng.choice(
                    ("wood_frame", "masonry", "steel", "reinforced_concrete")
                ),
                "manager": {
                    "name": f"Sample Manager {number:02}",
                    "phone": f"+132355501{number:02}",
                },
                "egress": {
                    "stairwells": rng.randint(1, 3),
                    "exits": rng.randint(1, 4),
                    "fire_escapes": rng.randint(0, 2),
                    "ladder_windows": rng.randint(0, 10),
                },
            })
    return buildings


def generate_responders(rng):
    responders = []
    for row in range(3):
        for column in range(4):
            number = len(responders) + 1
            responders.append({
                "id": f"sample-responder-{number:02}",
                "kind": ("fire", "police", "ambulance")[(row + column) % 3],
                "lat": round(CENTER_LAT + (row - 1) * 0.003 + rng.uniform(-0.0002, 0.0002), 6),
                "lng": round(CENTER_LNG + (column - 1.5) * 0.003 + rng.uniform(-0.0002, 0.0002), 6),
            })
    return responders


def main():
    rng = Random(SEED)
    directory = Path(__file__).resolve().parent
    for filename, records in (
        ("buildings.json", generate_buildings(rng)),
        ("responders.json", generate_responders(rng)),
    ):
        (directory / filename).write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
