// Headless run of both strategies on the demo data: node scripts/run_sim.ts [key=value ...]
import { readFileSync } from "node:fs";
import { Simulation, type SimConfig } from "../lib/sim/engine.ts";
import { RoadGraph } from "../lib/sim/graph.ts";
import { seedHidden, driverDeclines, tenantStuck, STUCK, DECLINE } from "../lib/sim/script.ts";

const D = "../data/demo/";
const roads = JSON.parse(readFileSync(D + "roads.json", "utf8"));
const bj = JSON.parse(readFileSync(D + "buildings.json", "utf8"));
const buildings = (Array.isArray(bj) ? bj : bj.buildings).filter((b: any) => b.fire_arrival_min !== null);
const stations = JSON.parse(readFileSync(D + "stations.json", "utf8")).stations;
const cfg: Partial<SimConfig> = {};
for (const a of process.argv.slice(2)) { const [k, v] = a.split("="); (cfg as any)[k] = Number(v); }
const g = new RoadGraph(roads);
for (const policy of ["nearest", "ours"] as const) {
  const t0 = performance.now();
  const s = new Simulation({ g, buildings, stations }, policy, cfg);
  seedHidden(s);
  if (policy === "ours") {
    s.advanceTo(DECLINE.call_min); const a = driverDeclines(s);
    s.advanceTo(STUCK.call_min); const b = tenantStuck(s);
    if (process.env.SHOW) for (const l of [...a, ...b]) console.log(`  [${l.t.toFixed(1)}] ${l.speaker}${l.to ? " → " + l.to : ""}: ${l.text}`);
  }
  s.advanceTo(180);
  const sb = s.byId.get(STUCK.building_id)!;
  console.log(`  stuck building: trapped ${sb.trapped.toFixed(2)} of which needed help ${sb.trappedNeed.toFixed(2)}`);
  const c = s.counts;
  const kinds: Record<string, number> = {};
  for (const l of s.log) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1;
  console.log(policy.padEnd(8), `total ${c.total.toFixed(0)} evac ${c.evacuated.toFixed(0)} trapped ${c.trapped.toFixed(1)} (needed help ${c.trappedNeed.toFixed(1)}, alone ${(c.trapped - c.trappedNeed).toFixed(1)})`,
    `served ${s.trucks.map(t => t.served.toFixed(0)).join(",")}`, JSON.stringify(kinds), `${((performance.now() - t0) / 1000).toFixed(1)}s`);
}
