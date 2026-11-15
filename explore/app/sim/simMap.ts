// Shared map layers for /sim and /console: fire, burned buildings, people dots, walkers, trucks, routes, pairings.
// Rule from the 3D prototype: never change data-driven paint per frame on the 42k-building layer; use feature-state
// set once per entity. Small moving layers (walkers, 8 trucks, routes) use setData per frame.
import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import { RoadGraph, type RoadsJson } from "../../lib/sim/graph";
import type { DemoBuildingLite, Simulation, StationLite } from "../../lib/sim/engine";

export const FRONT_MIN = 10;
export const ABLE_PER_DOT = 20;   // one green dot = 20 people who left on their own
export const NEED_PER_DOT = 1;    // one purple dot = 1 person who needed help
export const WALK_M_PER_MIN = { able: 80, need: 30 };  // walking speed along the streets (assumption)
export const COLORS = { able: "#22c55e", need: "#c084fc", trapped: "#ef4444", truck: "#f97316", onscene: "#16a34a", proposal: "#38bdf8" };

export interface Loaded {
  g: RoadGraph; buildings: DemoBuildingLite[]; stations: StationLite[]; origin: [number, number];
  cells: { id: number; t: number }[]; arrivals: [string, number][];
}
interface Walker { route: Route; t0: number; kind: "able" | "need"; side: number }
interface Route { xs: Float64Array; ys: Float64Array; cum: Float64Array }   // street path to safety, cumulative meters
export interface PendingLine { truck: string; building: string }

/** A red bubble with a white phone, drawn once on a canvas (no sprite server needed). */
function phoneIcon(): ImageData {
  const S = 48, c = document.createElement("canvas"); c.width = c.height = S;
  const x = c.getContext("2d")!;
  x.fillStyle = "#dc2626"; x.strokeStyle = "#ffffff"; x.lineWidth = 3;
  x.beginPath(); x.arc(S / 2, S / 2 - 3, 18, 0, Math.PI * 2); x.fill(); x.stroke();
  x.beginPath(); x.moveTo(S / 2 - 6, S / 2 + 13); x.lineTo(S / 2, S - 2); x.lineTo(S / 2 + 6, S / 2 + 13); x.closePath();
  x.fillStyle = "#dc2626"; x.fill();
  x.font = "22px -apple-system, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
  x.fillText("📞", S / 2, S / 2 - 2);
  return x.getImageData(0, 0, S, S);
}

/** 3D terrain makes every map update redraw the ground texture: 76 fps without it vs 20 fps with it while the
 *  simulation plays (measured). The simulation pages start flat (hills still shaded) and offer a "3D hills" toggle. */
export function setHills(m: maplibregl.Map, on: boolean) {
  m.setTerrain(on ? { source: "dem", exaggeration: 1.4 } : null);
}

/** Last free area measured (px from each side of the map); the truck spread stays inside it. */
let lastFree = { top: 0, bottom: 0, left: 0, right: 0 };

/** Free part of the screen: the map minus the cards that float over it (.card elements that are shown). */
export function freePadding(m: maplibregl.Map): maplibregl.PaddingOptions {
  const box = m.getContainer().getBoundingClientRect(), W = box.width, H = box.height;
  // (a raised ladder reaches ~25 px above the icon, so rows of the spread are 46 px apart)
  // room for the truck icon itself (58 x 36 px, anchored at its bottom centre, + label above) and the zoom buttons
  const pad = { top: 70, bottom: 20, left: 40, right: 70 };
  for (const c of document.querySelectorAll<HTMLElement>(".card")) {
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height || c.classList.contains("result")) continue;
    // a card on the left or right side covers that side; a wide low card covers the bottom
    if (r.height > H * 0.4 && r.left < W * 0.3) pad.left = Math.max(pad.left, r.right - box.left + 40);
    else if (r.height > H * 0.4 && r.right > W * 0.7) pad.right = Math.max(pad.right, box.right - r.left + 40);
    else if (r.top > H * 0.5) pad.bottom = Math.max(pad.bottom, box.bottom - r.top + 16);
  }
  // keep at least 240 x 200 px of map; shrink the side padding if the screen is too small
  const over = pad.left + pad.right + 240 - W;
  if (over > 0) { pad.left = Math.max(10, pad.left - over / 2); pad.right = Math.max(10, pad.right - over / 2); }
  if (pad.top + pad.bottom + 200 > H) pad.bottom = Math.max(10, H - pad.top - 200);
  lastFree = { top: 0, bottom: Math.max(0, pad.bottom - 20), left: Math.max(0, pad.left - 40), right: Math.max(0, pad.right - 40) };
  return pad;
}

/** Camera that keeps every truck and every building the fire reaches inside the free part of the screen. */
export function frameSim(m: maplibregl.Map, s: Simulation, duration: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
  for (const b of s.buildings) add(b.lng, b.lat);
  for (const tr of s.trucks) add(tr.lng, tr.lat);
  if (!isFinite(x0)) return;
  const cam = m.cameraForBounds([[x0, y0], [x1, y1]], { padding: freePadding(m), pitch: m.getPitch(), bearing: m.getBearing() });
  if (!cam) return;
  const c = m.getCenter(), z = m.getZoom(), tc = maplibregl.LngLat.convert(cam.center!);
  // do not move for tiny changes (each camera move redraws the whole map)
  const moved = m.project(tc).dist(m.project(c));
  if (duration > 0 && moved < 25 && Math.abs((cam.zoom ?? z) - z) < 0.08) return;
  m.easeTo({ ...cam, pitch: m.getPitch(), bearing: m.getBearing(), duration, essential: true });
}

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
  m.addSource("sel", { type: "geojson", data: empty });
  m.addSource("calls", { type: "geojson", data: empty });
  m.addSource("calls_coming", { type: "geojson", data: empty });
  if (!m.hasImage("phone")) m.addImage("phone", phoneIcon(), { pixelRatio: 2 });
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
  m.addLayer({ id: "walkers", type: "circle", source: "walkers",
    paint: { "circle-radius": ["match", ["get", "k"], "need", 3.6, 3],
             "circle-color": ["match", ["get", "k"], "need", COLORS.need, COLORS.able], "circle-opacity": ["get", "o"],
             "circle-stroke-color": "#0b0b0b", "circle-stroke-width": 0.6, "circle-stroke-opacity": ["get", "o"] } });
  m.addLayer({ id: "calls_coming", type: "symbol", source: "calls_coming",
    layout: { "icon-image": "phone", "icon-size": 1.3, "icon-anchor": "bottom", "icon-offset": [0, -6],
              "icon-allow-overlap": true, "icon-ignore-placement": true },
    paint: { "icon-opacity": 0.85 } });
  m.addLayer({ id: "calls", type: "symbol", source: "calls",
    layout: { "icon-image": "phone", "icon-size": 1.3, "icon-anchor": "bottom", "icon-offset": [0, -6],
              "icon-allow-overlap": true, "icon-ignore-placement": true },
    paint: { "icon-translate": [0, 0] } });
  m.addLayer({ id: "sel", type: "circle", source: "sel",
    paint: { "circle-radius": 16, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#ffffff", "circle-stroke-width": 3,
             "circle-pitch-alignment": "map" } });
  return d;
}

/** Draws one Simulation on the map. Call reset() when a new Simulation starts, draw() every frame. */
export class SimRenderer {
  private markers = new Map<string, { m: maplibregl.Marker; el: HTMLDivElement; lng: number; lift: number }>();
  private walkers: Walker[] = [];
  private spawned = new Float64Array(0);
  private spawnedNeed = new Float64Array(0);
  private shown = new Int8Array(0);          // last building state sent to the map, per sim building
  private escape: Int32Array;                // next road node toward safety, per node (-1 = already safe)
  private routes = new Map<number, Route>(); // per sim building idx
  private fire = { burn: 0, cool: 0, bld: 0 };
  private lastPush = -1e9;
  private ringKey = "";   // wall time of the last setData on the moving layers
  private size = { w: 0, h: 0 };          // map size in px (read on resize, not every frame)
  onTruckClick?: (id: string) => void;

  constructor(private m: maplibregl.Map, private d: Loaded) {
    // the same street routes to safety the engine uses to decide who can still get out (RoadGraph.escape)
    this.escape = d.g.escape();
    const measure = () => { const c = m.getContainer(); this.size = { w: c.clientWidth, h: c.clientHeight }; };
    measure(); m.on("resize", measure);
  }

  private route(s: Simulation, idx: number): Route {
    let r = this.routes.get(idx);
    if (r) return r;
    const b = s.buildings[idx], g = this.d.g;
    const xs = [b.lng], ys = [b.lat];
    for (let v = b.node, n = 0; v >= 0 && n < 600; v = this.escape[v], n++) { xs.push(g.lng[v]); ys.push(g.lat[v]); }
    const cum = new Float64Array(xs.length);
    for (let i = 1; i < xs.length; i++) {
      const kx = 111320 * Math.cos((ys[i] * Math.PI) / 180);
      cum[i] = cum[i - 1] + Math.hypot((xs[i] - xs[i - 1]) * kx, (ys[i] - ys[i - 1]) * 110540);
    }
    r = { xs: Float64Array.from(xs), ys: Float64Array.from(ys), cum };
    this.routes.set(idx, r);
    return r;
  }

  /** White ring around the selected building (console), or none. */
  select(s: Simulation | null, id: string | null) {
    const b = id && s ? s.byId.get(id) : null;
    (this.m.getSource("sel") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection",
      features: b ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [b.lng, b.lat] } }] : [] });
  }

  reset(s: Simulation) {
    const m = this.m;
    m.removeFeatureState({ source: "fire" }); m.removeFeatureState({ source: "buildings" });
    this.fire = { burn: 0, cool: 0, bld: 0 };
    this.shown = new Int8Array(s.buildings.length).fill(-1);
    this.spawned = new Float64Array(s.buildings.length);
    this.spawnedNeed = new Float64Array(s.buildings.length);
    this.walkers = [];
    for (const b of s.buildings) s.dirty.add(b.idx);
    for (const { m: mk } of this.markers.values()) mk.remove();
    this.markers.clear();
    for (const tr of s.trucks) {
      const e = document.createElement("div");
      e.className = "truck";
      e.innerHTML = TRUCK_SVG + `<span class="num">${tr.station}</span><span class="say"></span>`;
      e.dataset.status = tr.status;
      e.addEventListener("click", ev => { ev.stopPropagation(); this.onTruckClick?.(tr.id); });
      const mk = new maplibregl.Marker({ element: e, anchor: "bottom" }).setLngLat([tr.lng, tr.lat]).addTo(m);
      this.markers.set(tr.id, { m: mk, el: e, lng: tr.lng, lift: 0 });
    }
  }

  /** Move the truck icons (every frame); a truck faces the way it drives (the icon is drawn facing right). */
  private moveMarkers(s: Simulation) {
    // Trucks near each other on screen are spread out (up, then left/right) with a stem to the real point, so no truck
    // hides another. Zoomed out to show all buildings, 58 px is about 300 m, so trucks at near buildings touch.
    const placed: { x0: number; x1: number; y: number }[] = [];
    const { w: W, h: H } = this.size;
    for (const tr of s.trucks) {
      const mk = this.markers.get(tr.id);
      if (!mk) continue;
      const dx = tr.lng - mk.lng;
      if (Math.abs(dx) > 2e-6) { mk.el.dataset.dir = dx < 0 ? "left" : "right"; mk.lng = tr.lng; }
      mk.m.setLngLat([tr.lng, tr.lat]);
      // status, ladder and label follow the truck in the same frame
      if (mk.el.dataset.status !== tr.status) mk.el.dataset.status = tr.status;
      const held = s.locks.has(tr.id) ? "1" : "";
      if (mk.el.dataset.held !== held) mk.el.dataset.held = held;
      const tb = tr.building ? s.byId.get(tr.building) : undefined;
      const say = tr.status === "on_scene" && tb ? (tb.need >= 0.5 ? `bringing out ${Math.ceil(tb.need - 0.01)}` : "all out ✓") : "";
      const sayEl = mk.el.lastElementChild as HTMLElement;
      if (sayEl.textContent !== say) sayEl.textContent = say;
      // screen box of the icon (+ its label on the side it faces)
      const p = this.m.project([tr.lng, tr.lat]);
      const lab = say ? 7 * say.length + 18 : 0, left = mk.el.dataset.dir === "left";
      let off: [number, number] = [0, 0], fewest = Infinity;
      for (const c of SPREAD) {
        const x = p.x + c[0], y = p.y + c[1];
        const x0 = x - 31 - (left ? lab : 0), x1 = x + 31 + (left ? 0 : lab);
        // never spread a truck (or its label) off screen or under a panel
        const f = lastFree;
        if (c[0] !== 0 || c[1] !== 0) if (x0 < f.left || x1 > W - f.right || y - 36 < f.top || y > H - f.bottom) continue;
        const n = placed.reduce((k, q) => k + (q.x0 < x1 && x0 < q.x1 && Math.abs(q.y - y) < 46 ? 1 : 0), 0);
        if (n < fewest) { fewest = n; off = c; }
        if (n === 0) break;
      }
      const x = p.x + off[0];
      placed.push({ x0: x - 31 - (left ? lab : 0), x1: x + 31 + (left ? 0 : lab), y: p.y + off[1] });
      const key = off[0] * 1000 + off[1];
      if (mk.lift !== key) {
        mk.lift = key;
        mk.m.setOffset(off);
        const len = Math.hypot(off[0], off[1]);
        mk.el.style.setProperty("--stem", `${len}px`);
        mk.el.style.setProperty("--stem-a", `${Math.atan2(-off[1], -off[0])}rad`);
        mk.el.dataset.lifted = len ? "1" : "";
      }
    }
  }

  draw(s: Simulation, pending: PendingLine[] = [], force = false) {
    const m = this.m, d = this.d, t = s.t;
    const p = this.fire, c = d.cells, a = d.arrivals;
    while (p.burn < c.length && c[p.burn].t <= t) { m.setFeatureState({ source: "fire", id: c[p.burn].id }, { burned: true, front: true }); p.burn++; }
    while (p.cool < p.burn && c[p.cool].t <= t - FRONT_MIN) { m.setFeatureState({ source: "fire", id: c[p.cool].id }, { front: false }); p.cool++; }
    while (p.bld < a.length && a[p.bld][1] <= t) { m.setFeatureState({ source: "buildings", id: a[p.bld][0] }, { burned: true }); p.bld++; }
    // building state (feature-state, only when it changes): 1 people inside, 2 empty, 3 burned empty, 4 burned with people
    for (const idx of s.dirty) {
      const b = s.buildings[idx];
      const st = b.burned ? (b.trapped >= 0.5 ? 4 : 3) : (b.able + b.need >= 0.5 ? 1 : 2);
      if (st !== this.shown[idx]) { this.shown[idx] = st; m.setFeatureState({ source: "buildings", id: b.id }, { st }); }
      // a dot appears only when people have left the building
      const ableOut = b.evacuated - b.evacuatedNeed;
      while (ableOut - this.spawned[idx] >= ABLE_PER_DOT && this.walkers.length < 1200) {
        this.spawned[idx] += ABLE_PER_DOT;
        this.walkers.push({ route: this.route(s, idx), t0: t, kind: "able", side: ((idx * 7 + this.spawned[idx]) % 5) - 2 });
      }
      while (b.evacuatedNeed - this.spawnedNeed[idx] >= NEED_PER_DOT && this.walkers.length < 1200) {
        this.spawnedNeed[idx] += NEED_PER_DOT;
        this.walkers.push({ route: this.route(s, idx), t0: t, kind: "need", side: ((idx * 3 + this.spawnedNeed[idx]) % 5) - 2 });
      }
    }
    s.dirty.clear();
    // The moving layers (walkers, routes, pairing lines) are re-sent to the map worker at most 20 times a second.
    // Sending them every frame (~120/s) made ~100 MB of garbage every 20 s and caused long frames.
    const now = performance.now();
    if (now - this.lastPush < 50 && !force) { this.moveMarkers(s); return; }
    this.lastPush = now;
    // walkers move along their street route; they fade out over 2 min once they reach a safe street
    const FADE = 2, feats: GeoJSON.Feature[] = [], keep: Walker[] = [];
    for (const w of this.walkers) {
      const r = w.route, total = r.cum[r.cum.length - 1];
      const dist = WALK_M_PER_MIN[w.kind] * Math.max(0, t - w.t0);
      const over = dist >= total ? (dist - total) / WALK_M_PER_MIN[w.kind] : 0;
      if (over > FADE || t < w.t0) continue;
      keep.push(w);
      let i = 1; while (i < r.cum.length - 1 && r.cum[i] < dist) i++;
      const seg = r.cum[i] - r.cum[i - 1], f = seg > 0 ? Math.min(1, (Math.min(dist, total) - r.cum[i - 1]) / seg) : 1;
      let x = r.xs[i - 1] + (r.xs[i] - r.xs[i - 1]) * f, y = r.ys[i - 1] + (r.ys[i] - r.ys[i - 1]) * f;
      // small sideways offset so dots on the same street do not sit on top of each other
      const dx = r.xs[i] - r.xs[i - 1], dy = r.ys[i] - r.ys[i - 1], L = Math.hypot(dx, dy) || 1;
      x += (-dy / L) * w.side * 0.000035; y += (dx / L) * w.side * 0.000035;
      feats.push({ type: "Feature", properties: { k: w.kind, o: 1 - over / FADE }, geometry: { type: "Point", coordinates: [x, y] } });
    }
    this.walkers = keep;
    (m.getSource("walkers") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: feats });
    const routes: GeoJSON.Feature[] = [], links: GeoJSON.Feature[] = [], props: GeoJSON.Feature[] = [];
    this.moveMarkers(s);
    for (const tr of s.trucks) {
      const mk = this.markers.get(tr.id);
      if (mk) {
        mk.el.title = `${tr.name}: ${tr.status.replace("_", " ")}${tr.building ? " → " + s.byId.get(tr.building)?.label : ""}`;
      }
      // only a dashed line from a truck that is driving to its building (no route line, no rings)
      if (!tr.building || tr.status !== "en_route") continue;
      const b = s.byId.get(tr.building)!;
      links.push({ type: "Feature", properties: { end: 0 }, geometry: { type: "LineString", coordinates: [[tr.lng, tr.lat], [b.lng, b.lat]] } });
    }
    for (const pl of pending) {
      const tr = s.trucks.find(x => x.id === pl.truck), b = s.byId.get(pl.building);
      if (!tr || !b) continue;
      props.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[tr.lng, tr.lat], [b.lng, b.lat]] } });
      links.push({ type: "Feature", properties: { end: 1, c: COLORS.proposal }, geometry: { type: "Point", coordinates: [b.lng, b.lat] } });
    }
    (m.getSource("routes") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: routes });
    // buildings that called 911 and still wait for a truck: a phone that shakes
    // shaking = waiting for a truck; still = a truck is on the way; gone = the truck arrived
    const ring = s.ringing(), coming = s.answeredWaiting();
    const key = ring.map(c => c.id).join(",") + "|" + coming.map(c => c.id).join(",");
    if (key !== this.ringKey) {
      this.ringKey = key;
      const pt = (id: string) => { const b = s.byId.get(id)!; return { type: "Point" as const, coordinates: [b.lng, b.lat] }; };
      (m.getSource("calls") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection",
        features: ring.map(c => ({ type: "Feature" as const, properties: {}, geometry: pt(c.building) })) });
      (m.getSource("calls_coming") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection",
        features: coming.map(c => ({ type: "Feature" as const, properties: {}, geometry: pt(c.building) })) });
    }
    const ph = Math.floor(now / 70) % 4;
    if (m.getLayer("calls")) m.setPaintProperty("calls", "icon-translate", [[-2, 0], [2, 0], [-1, 0], [1, 0]][ph] as [number, number]);
    (m.getSource("links") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: links });
    (m.getSource("proposals") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: props });
  }
}

/** Where a truck icon may go when its own place is taken (px from its real point): up, then the sides, then higher. */
const SPREAD: [number, number][] = (() => {
  const out: [number, number][] = [];
  for (let r = -1; r <= 6; r++) for (let c = -4; c <= 4; c++) out.push([c * 64 + (r & 1 ? 32 : 0), -r * 46]);
  // nearest first; a place above costs less than one below (the stem then points down to the building)
  const cost = ([x, y]: [number, number]) => Math.hypot(x, y * (y > 0 ? 2.5 : 1));
  return out.sort((a, b) => cost(a) - cost(b));
})();

/** Fire truck, side view, facing right. The ladder (.ladder) lies on the roof; on scene it swings up and extends. */
const TRUCK_SVG = `<svg viewBox="0 0 64 40" width="58" height="36" aria-hidden="true">
  <g class="body">
    <g class="ladder">
      <rect x="6" y="8" width="34" height="2" rx="1" fill="#e5e7eb"/>
      <rect x="6" y="12" width="34" height="2" rx="1" fill="#e5e7eb"/>
      <g fill="#cbd5e1"><rect x="9" y="8" width="1.6" height="6"/><rect x="15" y="8" width="1.6" height="6"/>
        <rect x="21" y="8" width="1.6" height="6"/><rect x="27" y="8" width="1.6" height="6"/><rect x="33" y="8" width="1.6" height="6"/></g>
    </g>
    <rect x="3" y="15" width="40" height="15" rx="2.5" fill="#dc2626" stroke="#7f1d1d" stroke-width="1"/>
    <path d="M43 17 h9 l7 7 v6 h-16 z" fill="#b91c1c" stroke="#7f1d1d" stroke-width="1"/>
    <path d="M46 19 h5 l4.5 4.5 h-9.5 z" fill="#bfdbfe"/>
    <rect x="3" y="24" width="56" height="2" fill="#fde68a"/>
    <rect class="light" x="45" y="14" width="7" height="3" rx="1" fill="#60a5fa"/>
    <g class="wheel"><circle cx="13" cy="31" r="4.6" fill="#111827"/><circle cx="13" cy="31" r="1.8" fill="#9ca3af"/></g>
    <g class="wheel"><circle cx="50" cy="31" r="4.6" fill="#111827"/><circle cx="50" cy="31" r="1.8" fill="#9ca3af"/></g>
  </g>
</svg>`;

export const TRUCK_CSS = `
/* position must stay absolute: MapLibre places markers with absolute + transform. "relative" stacked the 8 markers in
   page flow, so truck i was drawn i x 36 px below its real place (found 2026-11-14). */
.maplibregl-marker.truck{position:absolute}
.truck{width:58px;height:36px;cursor:pointer;filter:drop-shadow(0 2px 3px #000a);transition:filter .3s,opacity .3s}
.truck svg{display:block;overflow:visible;transition:transform .25s}
.truck[data-dir=left] svg{transform:scaleX(-1)}
.truck .num{position:absolute;left:50%;top:17px;transform:translateX(-50%);font:800 11px/1 -apple-system,sans-serif;color:#fff;
  text-shadow:0 1px 0 #7f1d1d;pointer-events:none}
.truck .say{position:absolute;left:100%;top:50%;margin-left:2px;transform:translateY(-50%);white-space:nowrap;
  font:700 11px/1 -apple-system,sans-serif;color:#111;background:#c084fc;border-radius:9px;padding:3px 7px;pointer-events:none;
  box-shadow:0 1px 4px #0008}
.truck .say:empty{display:none}
.truck[data-dir=left] .say{left:auto;right:100%;margin:0 2px 0 0}
.truck[data-lifted="1"]::after{content:"";position:absolute;left:50%;top:100%;width:var(--stem);height:2px;margin-top:-1px;
  transform-origin:0 50%;transform:rotate(var(--stem-a));background:#fff;opacity:.85;box-shadow:0 0 2px #000;pointer-events:none}
.truck .ladder{transform-box:fill-box;transform-origin:0% 100%;transition:transform .8s cubic-bezier(.4,1.4,.6,1)}
.truck[data-status=on_scene] .ladder{transform:translate(0,4px) rotate(-38deg) scaleX(1.55)}
.truck[data-status=en_route] .body{animation:truck-bump .28s ease-in-out infinite alternate}
.truck[data-status=en_route] .light{animation:truck-light .5s steps(2) infinite}
.truck[data-status=idle]{opacity:.9}
.truck[data-status=unavailable]{opacity:.55;filter:grayscale(1) drop-shadow(0 2px 3px #000a)}
.truck[data-held="1"]{filter:drop-shadow(0 0 4px #38bdf8) drop-shadow(0 2px 3px #000a)}
@keyframes truck-bump{from{transform:translateY(0)}to{transform:translateY(-1px)}}
@keyframes truck-light{0%{fill:#60a5fa}50%{fill:#ef4444}}
`;
