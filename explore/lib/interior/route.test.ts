// Route tests on small made-up apartments (no scan data needed).
// Run: node --test explore/lib/interior/route.test.ts   (Node 23.6+ runs .ts files directly)
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickEntry, routeIn3d, searchRoute, shortestPath, toViewer, type Layout, type Opening, type Position, type Room } from "./route.ts";

const room = (...labels: string[]): Room => ({ labels, polygon: [], center: null });
const door = (x: number, y: number, width: number, label: string | null, exterior = true): Opening =>
  ({ type: "doorway", label, a: [x - width / 2, y], b: [x + width / 2, y], exterior });
/** Positions as [x, y, room index or null]. Links are pairs of position indexes, in both directions. */
function layout(rooms: Room[], pts: [number, number, number | null][], links: [number, number][], openings: Opening[] = []): Layout {
  const positions: Position[] = pts.map(([x, y, r], i) => ({ id: `p${i}`, x, y, z: 0, floor: 0, room: r, next: [] }));
  for (const [a, b] of links) { positions[a].next.push(b); positions[b].next.push(a); }
  return { id: "made-up", name: "Made-up", url: "", floors: [{ label: "Floor 1", rooms, walls: [], openings }], positions };
}

// Rooms: 0 living room, 1 near bedroom, 2 far bedroom, 3 bathroom.
// Positions on one line: 0 (x=0, living) - 1 (x=2, living) - 2 (x=4, near bedroom) and 1 - 3 (x=2, y=6, far bedroom).
const FLAT = () => layout(
  [room("Kitchen", "Living Room"), room("Bedroom"), room("Bedroom"), room("Bathroom")],
  [[0, 0, 0], [2, 0, 0], [4, 0, 1], [2, 6, 2]],
  [[0, 1], [1, 2], [1, 3]]);

test("shortestPath takes the shorter of two ways and gives its length in meters", () => {
  // 0 -> 3 directly along the bottom is 3 + 4 = 7 m; over the top it is 5 + 5 = 10 m.
  const l = layout([room("Living Room")], [[0, 0, 0], [3, 0, 0], [3, 4, 0], [0, 4, 0], [7, 0, 0]], [[0, 1], [1, 4], [0, 2], [2, 4]]);
  const r = shortestPath(l, 0, 4);
  assert.deepEqual(r?.path, [0, 1, 4]);
  assert.equal(r?.meters, 7);
});

test("shortestPath returns null when there is no way", () => {
  const l = layout([room("Living Room")], [[0, 0, 0], [1, 0, 0], [9, 9, 0]], [[0, 1]]);
  assert.equal(shortestPath(l, 0, 2), null);
});

test("the route goes to the nearest bedroom first, then on from there", () => {
  const r = searchRoute(FLAT(), 0);
  assert.deepEqual(r.stops.map(s => s.room), [1, 2]);
  assert.deepEqual(r.stops[0].path, [0, 1, 2]);       // entry -> near bedroom
  assert.equal(r.stops[0].meters, 4);
  assert.deepEqual(r.stops[1].path, [2, 1, 3]);       // starts where the first leg ended
  assert.equal(r.stops[1].meters, 8);
  assert.equal(r.meters, 12);
  assert.deepEqual(r.unreachable, []);
});

test("only bedrooms are stops", () => {
  const r = searchRoute(FLAT(), 0);
  assert.ok(r.stops.every(s => s.label === "Bedroom"));
});

test("a bedroom with no way to it is reported, not dropped", () => {
  const l = FLAT();
  l.positions[1].next = [0, 2];                        // cut the link to the far bedroom
  l.positions[3].next = [];
  const r = searchRoute(l, 0);
  assert.deepEqual(r.stops.map(s => s.room), [1]);
  assert.deepEqual(r.unreachable, [{ floor: 0, room: 2 }]);
});

test("a bedroom with no position in it is reported too", () => {
  const l = FLAT();
  l.floors[0].rooms.push(room("Bedroom"));             // room 4 has no positions
  assert.deepEqual(searchRoute(l, 0).unreachable, [{ floor: 0, room: 4 }]);
});

test("when the entry is inside a bedroom, that bedroom is the first stop at 0 m", () => {
  const r = searchRoute(FLAT(), 2);
  assert.equal(r.stops[0].room, 1);
  assert.equal(r.stops[0].meters, 0);
  assert.deepEqual(r.stops[0].path, [2]);
});

test("entry: a room labelled Entrance wins", () => {
  const l = layout([room("Living Room"), room("Entrance"), room("Bedroom")], [[0, 0, 0], [5, 0, 1], [9, 0, 2]], [[0, 1], [1, 2]],
    [door(0, -1, 0.9, "door-pivot")]);
  assert.deepEqual(pickEntry(l), { position: 1, why: "entrance room" });
});

test("entry: else the position at a hinged outside door of normal width, not at the wide balcony door", () => {
  // Position 0 is in the living room next to a 1.8 m wide door (balcony). Position 1 is in the hallway next to a
  // 0.9 m hinged door. Position 2 is in a bedroom next to an inside door, which does not count.
  const l = layout([room("Living Room"), room("Hallway"), room("Bedroom")], [[0, 0, 0], [5, 0, 1], [9, 0, 2]], [[0, 1], [1, 2]],
    [door(0, -1, 1.8, null), door(5, -1, 0.9, "door-pivot"), door(9, -1, 0.9, "door-pivot", false)]);
  assert.deepEqual(pickEntry(l), { position: 1, why: "outside door" });
});

test("entry: an outside door in a bedroom loses to one in a shared room", () => {
  const l = layout([room("Bedroom"), room("Kitchen")], [[0, 0, 0], [5, 0, 1]], [[0, 1]],
    [door(0, -1, 0.9, "door-pivot"), door(5, -1, 0.9, "door-pivot")]);
  assert.equal(pickEntry(l).position, 1);
});

test("entry: an outside door with no position near it is ignored; the first position is the fallback", () => {
  const l = layout([room("Living Room"), room("Bedroom")], [[0, 0, 0], [4, 0, 1]], [[0, 1]], [door(40, 40, 0.9, "door-pivot")]);
  assert.deepEqual(pickEntry(l), { position: 0, why: "first position" });
});

// ---- the same route inside the 3D tour ----
// The tour has y up, and its z is the plan's y reversed (Matterport "Showcase" coordinates).
test("toViewer: plan x, y and floor height z become tour x, up, and reversed y", () => {
  assert.deepEqual(toViewer({ x: 1, y: 2, z: 3 }), { x: 1, y: 3, z: -2 });
});

test("routeIn3d gives one line for each stop, a marker at each stop, and where to stand and look at the start", () => {
  // Entry (1, 1) -> (1, 5) in the living room -> (4, 5) in the bedroom, which is one floor up (floor height 3 m).
  const l = layout([room("Living Room"), room("Bedroom")], [[1, 1, 0], [1, 5, 0], [4, 5, 1]], [[0, 1], [1, 2]]);
  l.positions[2].z = 3;
  const r = routeIn3d(l, searchRoute(l, 0));
  assert.deepEqual(r.legs, [[{ x: 1, y: 0, z: -1 }, { x: 1, y: 0, z: -5 }, { x: 4, y: 3, z: -5 }]]);
  assert.deepEqual(r.stops, [{ x: 4, y: 3, z: -5 }]);
  assert.equal(r.start.sweep, "p0");
  // The first step goes toward tour -z. A camera with yaw 0 looks toward -z, so the yaw is 0.
  assert.equal(r.start.yawDeg, 0);
});

test("routeIn3d: the start looks along the first step of the route", () => {
  // First step toward plan +x = tour +x. Turning the camera to the right is a negative yaw: -90.
  const l = layout([room("Living Room"), room("Bedroom")], [[1, 1, 0], [6, 1, 1]], [[0, 1]]);
  assert.equal(routeIn3d(l, searchRoute(l, 0)).start.yawDeg, -90);
});

test("routeIn3d: a stop reached with no step (the entry is in the bedroom) has a marker and no line", () => {
  const l = layout([room("Bedroom")], [[1, 1, 0]], []);
  const r = routeIn3d(l, searchRoute(l, 0));
  assert.deepEqual(r.legs, []);
  assert.equal(r.stops.length, 1);
  assert.equal(r.start.yawDeg, null);
});
