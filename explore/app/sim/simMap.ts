// Shared map layers for /sim and /console: fire, burned buildings, people dots, walkers, trucks, routes, pairings.
// Rule from the 3D prototype: never change data-driven paint per frame on the 42k-building layer; use feature-state
// set once per entity. Small moving layers (walkers, 8 trucks, routes) use setData per frame.
import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import { RoadGraph, type RoadsJson } from "../../lib/sim/graph";
import type { DemoBuildingLite, Simulation, StationLite } from "../../lib/sim/engine";

export const FRONT_MIN = 10;
export const ABLE_PER_DOT = 25;
export const COLORS = { able: "#22c55e", need: "#c084fc", trapped: "#ef4444", truck: "#f97316", onscene: "#16a34a", proposal: "#38bdf8" };

export interface Loaded {
  g: RoadGraph; buildings: DemoBuildingLite[]; stations: StationLite[]; origin: [number, number];
  cells: { id: number; t: number }[]; arrivals: [string, number][];
}
interface Walker { lng: number; lat: number; dx: number; dy: number; t0: number; life: number; kind: "able" | "need" }
export interface PendingLine { truck: string; building: string }

export const fmtT = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
export const n0 = (x: number) => Math.round(x).toLocaleString("en-US");

const fetchJson = (u: string) => fetch(u).then(r => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); });

/** Fetch the demo data and add the simulation layers to a map whose style is loaded. */
export async function loadSimLayers(m: maplibregl.Map): Promise<Loaded> {
  const loaded = m.loaded() ? Promise.resolve() : new Promise<void>(res => m.once("load", () => res()));
  const [simData, roads, cells, arrivals, timeline] = await Promise.all([
    fetchJson("/api/sim"), fetchJson("/api/demo/roads.json"), fetchJson("/api/demo/fire_cells.geojson"),
    fetchJson("/api/demo/building_arrivals.json"), fetchJson("/api/demo/fire_timeline.json"), loaded]);
  const d: Loaded = {
    g: new RoadGraph(roads as RoadsJson), buildings: simData.buildings, stations: simData.stations, origin: timeline.origin,
    cells: (cells.features as { properties: { t: number } }[]).map((f, id) => ({ id, t: f.properties.t })).sort((a, b) => a.t - b.t),
    arrivals,
  };
  const empty = { type: "FeatureCollection" as const, features: [] };
  m.addSource("people", { type: "geojson", promoteId: "id", data: { type: "FeatureCollection",
    features: d.buildings.map(b => ({ type: "Feature", properties: { id: b.id }, geometry: { type: "Point", coordinates: [b.lng, b.lat] } })) } });
  m.addSource("walkers", { type: "geojson", data: empty });
  m.addSource("routes", { type: "geojson", data: empty });
  m.addSource("links", { type: "geojson", data: empty });
  m.addSource("proposals", { type: "geojson", data: empty });
  m.addLayer({ id: "routes", type: "line", source: "routes", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#fde68a", "line-width": 2.5, "line-opacity": 0.55 } });
  m.addLayer({ id: "links", type: "line", source: "links", filter: ["==", ["get", "end"], 0],
    paint: { "line-color": "#fff7ed", "line-width": 2, "line-dasharray": [2, 2] } });
  m.addLayer({ id: "proposals", type: "line", source: "proposals",
    paint: { "line-color": COLORS.proposal, "line-width": 3, "line-dasharray": [1, 1.5] } });
  m.addLayer({ id: "targets", type: "circle", source: "links", filter: ["==", ["get", "end"], 1],
    paint: { "circle-radius": 11, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ["coalesce", ["get", "c"], "#fff7ed"],
             "circle-stroke-width": 2.5, "circle-pitch-alignment": "map" } });
  const visible = ["any", ["boolean", ["feature-state", "trapped"], false], [">", ["coalesce", ["feature-state", "n"], 0], 0]];
  m.addLayer({ id: "people", type: "circle", source: "people",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["coalesce", ["feature-state", "n"], 0], 0, 0, 1, 2, 10, 3, 100, 5.5, 400, 9],
      "circle-color": ["case", ["boolean", ["feature-state", "trapped"], false], COLORS.trapped,
                       ["boolean", ["feature-state", "need"], false], COLORS.need, COLORS.able],
      "circle-stroke-color": ["case", ["boolean", ["feature-state", "sel"], false], "#ffffff", "#111"],
      "circle-stroke-width": ["case", ["boolean", ["feature-state", "sel"], false], 3, 0.6],
      "circle-opacity": ["case", visible, 0.92, 0] as never,
      "circle-stroke-opacity": ["case", visible, 0.9, 0] as never,
    } });
  m.addLayer({ id: "walkers", type: "circle", source: "walkers",
    paint: { "circle-radius": ["match", ["get", "k"], "need", 3.2, 2.2],
             "circle-color": ["match", ["get", "k"], "need", COLORS.need, COLORS.able], "circle-opacity": ["get", "o"] } });
  return d;
}

/** Draws one Simulation on the map. Call reset() when a new Simulation starts, draw() every frame. */
export class SimRenderer {
  private markers = new Map<string, { m: maplibregl.Marker; el: HTMLDivElement }>();
  private walkers: Walker[] = [];
  private spawned = new Float64Array(0);
  private spawnedNeed = new Float64Array(0);
  private shown = new Int32Array(0);
  private fire = { burn: 0, cool: 0, bld: 0 };
  onTruckClick?: (id: string) => void;

  constructor(private m: maplibregl.Map, private d: Loaded) {}

  reset(s: Simulation) {
    const m = this.m;
    m.removeFeatureState({ source: "fire" }); m.removeFeatureState({ source: "buildings" }); m.removeFeatureState({ source: "people" });
    this.fire = { burn: 0, cool: 0, bld: 0 };
    this.shown = new Int32Array(s.buildings.length).fill(-1);
    this.spawned = new Float64Array(s.buildings.length);
    this.spawnedNeed = new Float64Array(s.buildings.length);
    this.walkers = [];
    for (const b of s.buildings) s.dirty.add(b.idx);
    for (const { m: mk } of this.markers.values()) mk.remove();
    this.markers.clear();
    for (const tr of s.trucks) {
      const e = document.createElement("div");
      e.className = "truck";
      e.textContent = String(tr.station);
      e.addEventListener("click", ev => { ev.stopPropagation(); this.onTruckClick?.(tr.id); });
      const mk = new maplibregl.Marker({ element: e }).setLngLat([tr.lng, tr.lat]).addTo(m);
      this.markers.set(tr.id, { m: mk, el: e });
    }
  }

  draw(s: Simulation, pending: PendingLine[] = []) {
    const m = this.m, d = this.d, t = s.t;
    const p = this.fire, c = d.cells, a = d.arrivals;
    while (p.burn < c.length && c[p.burn].t <= t) { m.setFeatureState({ source: "fire", id: c[p.burn].id }, { burned: true, front: true }); p.burn++; }
    while (p.cool < p.burn && c[p.cool].t <= t - FRONT_MIN) { m.setFeatureState({ source: "fire", id: c[p.cool].id }, { front: false }); p.cool++; }
    while (p.bld < a.length && a[p.bld][1] <= t) { m.setFeatureState({ source: "buildings", id: a[p.bld][0] }, { burned: true }); p.bld++; }
    const [ox, oy] = d.origin;
    for (const idx of s.dirty) {
      const b = s.buildings[idx];
      const inside = b.able + b.need;
      const q = b.trapped >= 0.5 ? 10000 + Math.round(b.trapped) : inside < 0.5 ? 0 : Math.max(1, Math.round(Math.sqrt(inside) * 3)) * 2 + (b.need >= 0.5 ? 1 : 0);
      if (q !== this.shown[idx]) {
        this.shown[idx] = q;
        m.setFeatureState({ source: "people", id: b.id },
          b.trapped >= 0.5 ? { n: Math.max(1, b.trapped), trapped: true, need: true } : { n: inside < 0.5 ? 0 : inside, need: b.need >= 0.5, trapped: false });
      }
      let dx = b.lng - ox, dy = b.lat - oy; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const ableOut = b.evacuated - b.evacuatedNeed;
      while (ableOut - this.spawned[idx] >= ABLE_PER_DOT && this.walkers.length < 1500) {
        this.spawned[idx] += ABLE_PER_DOT;
        const j = ((idx * 7919 + this.spawned[idx]) % 100) / 100 - 0.5;
        this.walkers.push({ lng: b.lng, lat: b.lat, dx: dx + j * 0.8, dy: dy - j * 0.8, t0: t, life: 6, kind: "able" });
      }
      while (b.evacuatedNeed - this.spawnedNeed[idx] >= 1 && this.walkers.length < 1500) {
        this.spawnedNeed[idx] += 1;
        const j = ((idx * 104729 + this.spawnedNeed[idx] * 31) % 100) / 100 - 0.5;
        this.walkers.push({ lng: b.lng, lat: b.lat, dx: dx + j, dy: dy - j, t0: t, life: 8, kind: "need" });
      }
    }
    s.dirty.clear();
    this.walkers = this.walkers.filter(w => t - w.t0 < w.life);
    const DEG_PER_M = 1 / 111000;
    (m.getSource("walkers") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: this.walkers.map(w => {
      const age = t - w.t0, dist = (w.kind === "need" ? 60 : 80) * age * DEG_PER_M;
      return { type: "Feature", properties: { k: w.kind, o: Math.max(0, 1 - age / w.life) },
               geometry: { type: "Point", coordinates: [w.lng + w.dx * dist / Math.cos(w.lat * Math.PI / 180), w.lat + w.dy * dist] } };
    }) });
    const routes: GeoJSON.Feature[] = [], links: GeoJSON.Feature[] = [], props: GeoJSON.Feature[] = [];
    for (const tr of s.trucks) {
      const mk = this.markers.get(tr.id);
      if (mk) {
        mk.m.setLngLat([tr.lng, tr.lat]);
        mk.el.dataset.status = tr.status;
        mk.el.dataset.held = s.locks.has(tr.id) ? "1" : "";
        mk.el.title = `${tr.name}: ${tr.status.replace("_", " ")}${tr.building ? " → " + s.byId.get(tr.building)?.label : ""}`;
      }
      if (!tr.building) continue;
      const b = s.byId.get(tr.building)!;
      links.push({ type: "Feature", properties: { end: 0 }, geometry: { type: "LineString", coordinates: [[tr.lng, tr.lat], [b.lng, b.lat]] } });
      links.push({ type: "Feature", properties: { end: 1 }, geometry: { type: "Point", coordinates: [b.lng, b.lat] } });
      if (tr.status === "en_route" && tr.path.length > 1) {
        let i = 1; while (i < tr.cum.length - 1 && tr.cum[i] < tr.pos_m) i++;
        const coords: [number, number][] = [[tr.lng, tr.lat]];
        for (let k = i; k < tr.path.length; k++) { const n = tr.path[k]; if (n >= 0) coords.push([d.g.lng[n], d.g.lat[n]]); }
        coords.push([b.lng, b.lat]);
        routes.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } });
      }
    }
    for (const pl of pending) {
      const tr = s.trucks.find(x => x.id === pl.truck), b = s.byId.get(pl.building);
      if (!tr || !b) continue;
      props.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[tr.lng, tr.lat], [b.lng, b.lat]] } });
      links.push({ type: "Feature", properties: { end: 1, c: COLORS.proposal }, geometry: { type: "Point", coordinates: [b.lng, b.lat] } });
    }
    (m.getSource("routes") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: routes });
    (m.getSource("links") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: links });
    (m.getSource("proposals") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: props });
  }
}

export const TRUCK_CSS = `
.truck{background:#f97316;color:#111;font:700 11px/1 -apple-system,sans-serif;padding:3px 4px;border-radius:4px;border:2px solid #fff;box-shadow:0 1px 6px #000a;transition:background .3s;cursor:pointer}
.truck[data-status=on_scene]{background:#22c55e}
.truck[data-status=idle]{background:#d4d4d8}
.truck[data-status=unavailable]{background:#52525b;color:#fff;border-style:dashed}
.truck[data-held="1"]{outline:2px solid #38bdf8;outline-offset:1px}
`;
