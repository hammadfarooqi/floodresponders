// Matching and routing tests on small made-up road graphs (no demo data needed).
// Run: node --test explore/lib/sim/engine.test.ts   (Node 23.6+ runs .ts files directly)
import { test } from "node:test";
import assert from "node:assert/strict";
import { RoadGraph, type RoadsJson } from "./graph.ts";
import { Simulation, type DemoBuildingLite, type StationLite } from "./engine.ts";

const M_PER_DEG = 111320; // meters per degree of longitude at lat 0
// Nodes on one straight street (lat 0), x in meters. Edge lengths match the coordinates.
function line(xs: number[], fire: (number | null)[] = []): RoadsJson {
  const edges: RoadsJson["edges"] = [];
  for (let i = 0; i + 1 < xs.length; i++) edges.push([i, i + 1, Math.abs(xs[i + 1] - xs[i]), fire[i] ?? null]);
  return { nodes: xs.map(x => [x / M_PER_DEG, 0]), edges, building_node: {} };
}
function bld(id: string, node: number, roads: RoadsJson, need: number, fire: number): DemoBuildingLite {
  roads.building_node[id] = node;
  const [lng, lat] = roads.nodes[node];
  return { id, lat, lng, people_est: need, people_need_help_est: need, fire_arrival_min: fire };
}
const station = (number: number, node: number): StationLite => ({ id: `s${number}`, name: `S${number}`, number, lat: 0, lng: 0, node });
// 60 km/h = 1000 m per minute; people who can leave alone do not matter here.
// These tests check the CONTRACTS phase 4 rules, which match_rule "fleet" implements. The demo default is "rate".
const CFG = { truck_speed_kmh: 60, need_alone_rate_per_min: 0, match_rule: "fleet" as const };

test("a street that closes before the truck gets there is not used", () => {
  // 0 -1000- 1 -1000- 2, and a detour 0 -1500- 3 -1500- 2. Edge 1-2 closes at minute 1.5.
  // The truck reaches edge 1-2 at minute 1 and would finish it at minute 2: too late, so it takes the detour.
  const r: RoadsJson = {
    nodes: [[0, 0], [0, 0], [0, 0], [0, 0]],
    edges: [[0, 1, 1000, null], [1, 2, 1000, 1.5], [0, 3, 1500, null], [3, 2, 1500, null]],
    building_node: {},
  };
  const g = new RoadGraph(r);
  const dist = new Float64Array(g.n), prev = new Int32Array(g.n);
  g.dijkstra(0, 0, dist, prev, Infinity, 1000);
  assert.equal(dist[2], 3000);
  assert.deepEqual(g.path(prev, dist, 2), [0, 3, 2]);
  // Without a speed (old behavior) only streets already closed at the start are skipped.
  g.dijkstra(0, 0, dist, prev);
  assert.equal(dist[2], 2000);
});

test("whole fleet: two buildings get a truck where greedy serves only one", () => {
  // Street: station B (x=-4000) - B1 (x=0) - station A (x=2000) - B2 (x=5000).
  // B1 has the higher priority. Truck A is closest to B1, but it is also the only truck that reaches B2 in time.
  const r = line([-4000, 0, 2000, 5000]);
  const buildings = [bld("B1", 1, r, 20, 30), bld("B2", 3, r, 10, 11)];
  const s = new Simulation({ roads: r, buildings, stations: [station(1, 2), station(2, 0)] }, "ours", CFG);
  s.advanceTo(0.1);
  const at = Object.fromEntries(s.trucks.map(t => [t.id, t.building]));
  assert.deepEqual(at, { E1: "B2", E2: "B1" });
});

test("a building reported cleared frees its truck for the next building at once", () => {
  // Station (x=0) - B1 (x=3000) - B2 (x=6000). B1 first; while the truck drives there, B1 reports everyone out.
  const r = line([0, 3000, 6000]);
  const buildings = [bld("B1", 1, r, 20, 60), bld("B2", 2, r, 5, 90)];
  const s = new Simulation({ roads: r, buildings, stations: [station(1, 0)] }, "ours", CFG);
  s.advanceTo(1);
  assert.equal(s.trucks[0].building, "B1");
  assert.equal(s.trucks[0].status, "en_route");
  s.applyEvent({ type: "building_cleared", building_id: "B1", people_remaining: 0, note: "" });
  s.advanceTo(1.2);
  assert.equal(s.trucks[0].building, "B2");
  assert.equal(s.byId.get("B1")!.needKnown, 0);
});

test("a partial clearance report sets how many people still need help", () => {
  const r = line([0, 3000]);
  const s = new Simulation({ roads: r, buildings: [bld("B1", 1, r, 20, 60)], stations: [station(1, 0)] }, "ours", CFG);
  s.advanceTo(0.5);
  s.applyEvent({ type: "building_cleared", building_id: "B1", people_remaining: 4, note: "" });
  assert.equal(s.byId.get("B1")!.needKnown, 4);
  s.advanceTo(0.7);
  assert.equal(s.trucks[0].building, "B1");
});

test("a big building can get a second truck", () => {
  // 60 people need help: one crew (1.5 people/min) cannot bring them all out before the fire at minute 30.
  const r = line([0, 1000, 2000]);
  const buildings = [bld("BIG", 1, r, 60, 30)];
  const s = new Simulation({ roads: r, buildings, stations: [station(1, 0), station(2, 2)] }, "ours", CFG);
  s.advanceTo(0.1);
  assert.deepEqual(s.trucks.map(t => t.building), ["BIG", "BIG"]);
});

test("no truck can arrive in time: an idle truck still goes to check, and it is logged as a check", () => {
  // The fire reaches the building at minute 4; the truck needs 5 minutes. The road itself never burns.
  const r = line([0, 5000]);
  const s = new Simulation({ roads: r, buildings: [bld("LATE", 1, r, 10, 4)], stations: [station(1, 0)] }, "ours", CFG);
  s.advanceTo(0.1);
  assert.equal(s.trucks[0].building, "LATE");
  assert.match(s.trucks[0].reason, /check/i);
});

test("a truck that can save someone is not spent on a check", () => {
  // One truck. LATE cannot be reached in time; OK can. The truck goes to OK.
  const r = line([0, 5000, 6000]);
  const buildings = [bld("LATE", 1, r, 50, 4), bld("OK", 2, r, 5, 60)];
  const s = new Simulation({ roads: r, buildings, stations: [station(1, 0)] }, "ours", CFG);
  s.advanceTo(0.1);
  assert.equal(s.trucks[0].building, "OK");
});

test("assignMax finds the best total on random small tables (checked by brute force)", async () => {
  const { assignMax } = await import("./engine.ts");
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const best = (val: number[][], m: number, r = 0, used = new Set<number>()): number => {
    if (r === val.length) return 0;
    let b = best(val, m, r + 1, used);                       // row r stays idle
    for (let c = 0; c < m; c++) if (!used.has(c)) {
      used.add(c); b = Math.max(b, val[r][c] + best(val, m, r + 1, used)); used.delete(c);
    }
    return b;
  };
  for (let k = 0; k < 200; k++) {
    const n = 1 + Math.floor(rnd() * 4), m = Math.floor(rnd() * 5);
    const val = Array.from({ length: n }, () => Array.from({ length: m }, () => (rnd() < 0.3 ? 0 : Math.round(rnd() * 20))));
    const pick = assignMax(val, m);
    const cols = pick.filter(c => c >= 0);
    assert.equal(new Set(cols).size, cols.length, "a column is used twice");
    const total = pick.reduce((s, c, r) => s + (c >= 0 ? val[r][c] : 0), 0);
    assert.equal(total, best(val, m));
  }
});

// ---------- policy "calls" (today's 911 dispatch, the baseline) ----------
// Every building with people who need help calls (call_share 1), exactly 10 min before the fire; 1 call-taker, 2.5 min
// a call. People who need help do not leave alone, so only trucks change anything.
const CALLS = { truck_speed_kmh: 60, need_alone_rate_per_min: 0, call_share: 1, call_lead_min: [10, 10] as [number, number], call_after_start_min: null,
                call_takers: 1, call_handle_min: 2.5 };

test("calls: the oldest answered call gets the truck, and a newer, closer call does not take it away", () => {
  // Station (x=0) - NEAR (x=1000) - FAR (x=8000). Calls come 20 min before the fire.
  // FAR calls first (fire 50 -> call 30, answered 32.5, truck there at 40.5); NEAR calls later (fire 55 -> call 35,
  // answered 37.5) while the truck still drives to FAR. Today the truck keeps going to FAR.
  const r = line([0, 1000, 8000]);
  const buildings = [bld("NEAR", 1, r, 5, 55), bld("FAR", 2, r, 5, 50)];
  const s = new Simulation({ roads: r, buildings, stations: [station(1, 0)] }, "calls", { ...CALLS, call_lead_min: [20, 20] });
  s.advanceTo(33);
  assert.equal(s.trucks[0].building, "FAR");
  s.advanceTo(38);
  assert.equal(s.trucks[0].building, "FAR");
  assert.equal(s.trucks[0].status, "en_route");
  assert.equal(s.ringing().map(c => c.building).join(), "NEAR");
});

test("calls: the closest free truck by road goes, not the first in the list", () => {
  // Station 1 (x=0, listed first) - B (x=6000) - station 2 (x=8000).
  const r = line([0, 6000, 8000]);
  const buildings = [bld("B", 1, r, 5, 40)];
  const s = new Simulation({ roads: r, buildings, stations: [station(1, 0), station(2, 2)] }, "calls", CALLS);
  s.advanceTo(33);   // call at 30, answered at 32.5
  assert.equal(s.trucks.find(t => t.station === 2)!.building, "B");
  assert.equal(s.trucks.find(t => t.station === 1)!.status, "idle");
});

test("calls: a building that never calls gets no truck (Roll Call sends one)", () => {
  const r = line([0, 2000]);
  const buildings = [bld("B", 1, r, 5, 40)];
  const quiet = new Simulation({ roads: r, buildings, stations: [station(1, 0)] }, "calls", { ...CALLS, call_share: 0 });
  quiet.advanceTo(45);
  assert.equal(quiet.trucks[0].building, null);
  assert.equal(quiet.trucks[0].status, "idle");
  assert.ok(quiet.counts.trapped >= 4.5, "the 5 people who need help are trapped");
  const ours = new Simulation({ roads: r, buildings: [bld("B", 1, line([0, 2000]), 5, 40)], stations: [station(1, 0)] },
                             "ours", { ...CALLS, call_share: 0 });
  ours.advanceTo(45);
  assert.ok(ours.counts.trapped < 0.5, "Roll Call does not wait for a call");
});

test("calls: calls wait in line for the call-taker", () => {
  // Two buildings call at the same minute (both fires at 40 -> calls at 30); 1 call-taker takes 2.5 min per call.
  const r = line([0, 1000, 2000]);
  const buildings = [bld("A", 1, r, 5, 40), bld("B", 2, r, 5, 40)];
  const s = new Simulation({ roads: r, buildings, stations: [station(1, 0), station(2, 0)] }, "calls", CALLS);
  s.advanceTo(1);
  assert.deepEqual(s.calls.map(c => c.t_answer).sort((a, b) => a - b), [32.5, 35]);
});
