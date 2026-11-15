"""Tests for interior_layouts.py on a made-up scan (no sponsor data, no network).

Run: python3 -m unittest data/pipeline/test_interior_layouts.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from interior_layouts import layout_from_model, summary


def vertex(vid, x, y):
    return {"id": vid, "position": {"x": x, "y": y}}


def edge(eid, a, b, openings=()):
    return {"id": eid, "type": "wall", "vertices": [{"id": a}, {"id": b}], "openings": list(openings)}


def room(rid, labels, edge_ids):
    return {"id": rid, "classifications": [{"label": x, "confidence": 1.0} for x in labels],
            "boundary": {"edges": [{"id": e} for e in edge_ids]}}


def model():
    """Two rooms side by side, 4 m x 4 m each. The wall "mid" (x = 4) is shared and has a door.

        d ---- e ---- f
        | bed  | live |
        a ---- b ---- c      "south" (a-b) has a window, "east" (c-f) has the front door
    """
    vertices = [vertex("a", 0, 0), vertex("b", 4, 0), vertex("c", 8, 0),
                vertex("d", 0, 4), vertex("e", 4, 4), vertex("f", 8, 4)]
    edges = [
        edge("south", "a", "b", [{"type": "window", "label": "window-unknown", "width": 1.0, "relativeCenter": 0.5}]),
        edge("west", "d", "a"),
        edge("north", "e", "d"),
        edge("mid", "b", "e", [{"type": "doorway", "label": "door-pivot", "width": 1.0, "relativeCenter": 0.25}]),
        edge("south2", "b", "c"),
        edge("east", "c", "f", [{"type": "doorway", "label": "door-pivot", "width": 0.8, "relativeCenter": 0.5}]),
        edge("north2", "f", "e"),
    ]
    rooms = [
        # Boundary edges are given out of order on purpose: the code must chain them by shared corners.
        room("r-bed", ["Bedroom"], ["north", "south", "mid", "west"]),
        room("r-live", ["Kitchen", "Living Room"], ["south2", "north2", "mid", "east"]),
        room("r-void", ["Void"], []),
    ]
    locations = [
        {"id": "p0", "position": {"x": 7, "y": 2}, "neighbors": ["p1"], "room": {"id": "r-live"}, "floor": {"id": "f1"}},
        {"id": "p1", "position": {"x": 5, "y": 1}, "neighbors": ["p0", "p2", "gone"], "room": {"id": "r-live"}, "floor": {"id": "f1"}},
        {"id": "p2", "position": {"x": 2, "y": 2, "z": 3.1}, "neighbors": ["p1"], "room": {"id": "r-bed"}, "floor": {"id": "f1"}},
    ]
    return {"name": "Made-up 1BR", "locations": locations,
            "floors": [{"id": "f1", "label": "Floor 1", "sequence": 0, "vertices": vertices, "edges": edges, "rooms": rooms}]}


class LayoutFromModel(unittest.TestCase):
    def setUp(self):
        self.layout = layout_from_model("scan1", model())
        self.floor = self.layout["floors"][0]

    def test_room_outline_is_chained_from_unordered_edges(self):
        bed = self.floor["rooms"][0]
        self.assertEqual(bed["labels"], ["Bedroom"])
        self.assertEqual(len(bed["polygon"]), 4)
        self.assertEqual({tuple(p) for p in bed["polygon"]}, {(0, 0), (4, 0), (4, 4), (0, 4)})
        self.assertEqual(bed["center"], [2, 2])

    def test_room_whose_walls_do_not_close_gets_its_centre_from_its_positions(self):
        m = model()
        m["floors"][0]["rooms"][0]["boundary"]["edges"].pop()      # the bedroom loses one wall
        bed = layout_from_model("scan1", m)["floors"][0]["rooms"][0]
        self.assertEqual(bed["polygon"], [])
        self.assertEqual(bed["center"], [2, 2])                    # the one position in the bedroom

    def test_void_rooms_are_dropped(self):
        self.assertEqual([r["labels"] for r in self.floor["rooms"]], [["Bedroom"], ["Kitchen", "Living Room"]])

    def test_walls_are_segments(self):
        self.assertEqual(len(self.floor["walls"]), 7)
        self.assertIn([0, 0, 4, 0], self.floor["walls"])

    def test_opening_is_placed_along_its_wall(self):
        window = next(o for o in self.floor["openings"] if o["type"] == "window")
        self.assertEqual(window["a"], [1.5, 0])      # centre (2, 0), half width 0.5
        self.assertEqual(window["b"], [2.5, 0])
        inner = next(o for o in self.floor["openings"] if o["type"] == "doorway" and not o["exterior"])
        self.assertEqual(inner["a"], [4, 0.5])       # wall b -> e, centre at 1/4 of 4 m = (4, 1)
        self.assertEqual(inner["b"], [4, 1.5])

    def test_exterior_means_the_wall_belongs_to_one_room(self):
        doors = [o for o in self.floor["openings"] if o["type"] == "doorway"]
        self.assertEqual(sorted(o["exterior"] for o in doors), [False, True])
        front = next(o for o in doors if o["exterior"])
        self.assertEqual(front["a"][0], 8)
        self.assertEqual(front["label"], "door-pivot")

    def test_positions_point_to_rooms_and_neighbours_by_index(self):
        p = self.layout["positions"]
        self.assertEqual([q["room"] for q in p], [1, 1, 0])
        self.assertEqual([q["floor"] for q in p], [0, 0, 0])
        self.assertEqual(p[1]["next"], [0, 2])       # the unknown neighbour "gone" is dropped
        self.assertEqual((p[2]["x"], p[2]["y"]), (2, 2))
        self.assertEqual([q["id"] for q in p], ["p0", "p1", "p2"])
        self.assertEqual([q["z"] for q in p], [0, 0, 3.1])      # floor height; 0 when the API gives none

    def test_summary_counts_bedrooms_that_can_be_reached(self):
        s = summary(self.layout)
        self.assertEqual(s["bedrooms"], 1)
        self.assertEqual(s["positions"], 3)
        self.assertTrue(s["usable"])


class NotUsable(unittest.TestCase):
    def test_scan_with_no_labelled_bedroom(self):
        m = model()
        m["floors"][0]["rooms"][0]["classifications"] = []
        s = summary(layout_from_model("scan1", m))
        self.assertEqual(s["bedrooms"], 0)
        self.assertFalse(s["usable"])

    def test_scan_with_no_links_between_positions(self):
        m = model()
        for loc in m["locations"]:
            loc["neighbors"] = []
        self.assertFalse(summary(layout_from_model("scan1", m))["usable"])

    def test_scan_with_no_floors(self):
        s = summary(layout_from_model("scan1", {"name": "Empty", "floors": [], "locations": []}))
        self.assertFalse(s["usable"])


if __name__ == "__main__":
    unittest.main()
