"use client";
// /sim: the old way (nearest building, never re-plan) vs Roll Call AI dispatch, on the same fire, people and trucks.
import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { style } from "../3d/mapStyle";
import { RoadGraph, type RoadsJson } from "../../lib/sim/graph";
import { DEFAULT_CONFIG, Simulation, type DemoBuildingLite, type LogEntry, type Policy, type StationLite } from "../../lib/sim/engine";
import { DECLINE, STUCK, driverDeclines, followUps, seedHidden, tenantStuck, type Line } from "../../lib/sim/script";

const DURATION = 180, RUN_SECONDS = 25, FRONT_MIN = 10;
const VIEW = { center: [-118.338, 34.094] as [number, number], zoom: 13.75, pitch: 45, bearing: 0 };
const ABLE_PER_DOT = 25;
const COLORS = { able: "#22c55e", need: "#c084fc", trapped: "#ef4444", truck: "#f97316", onscene: "#16a34a" };
const RUNS: Record<Policy, { n: number; title: string; sub: string }> = {
  nearest: { n: 1, title: "Old way", sub: "Each free truck goes to the nearest building that needs help. It never re-plans." },
  ours: { n: 2, title: "Roll Call AI", sub: "Ranks buildings by people needing help × urgency, sends a truck only if it can arrive before the fire, re-matches every 5 min and after every call." },
};

type Counts = Simulation["counts"];
interface Walker { lng: number; lat: number; dx: number; dy: number; t0: number; life: number; kind: "able" | "need" }
interface Loaded { g: RoadGraph; buildings: DemoBuildingLite[]; stations: StationLite[]; origin: [number, number];
                   cells: { id: number; t: number }[]; arrivals: [string, number][] }

const fmtT = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const n0 = (x: number) => Math.round(x).toLocaleString("en-US");

export default function SimView() {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const data = useRef<Loaded | null>(null);
  const sim = useRef<Simulation | null>(null);
  const markers = useRef<Map<string, { m: maplibregl.Marker; el: HTMLDivElement }>>(new Map());
  const walkers = useRef<Walker[]>([]);
  const spawned = useRef<Float64Array>(new Float64Array(0));     // able people already shown as dots, per building
  const spawnedNeed = useRef<Float64Array>(new Float64Array(0));
  const shown = useRef<Int32Array>(new Int32Array(0));            // last people-dot bucket, per building
  const firePtr = useRef({ burn: 0, cool: 0, bld: 0 });
  const moments = useRef<{ t: number; fn: (s: Simulation) => Line[]; done: boolean }[]>([]);
  const logSeen = useRef(0);
  const callAt = useRef<number | null>(null);
  const clock = useRef(0);   // playback clock (sim minutes); the sim advances in fixed ticks up to it

  const [ready, setReady] = useState(false);
  const [policy, setPolicy] = useState<Policy>("nearest");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [pauseOnCalls, setPauseOnCalls] = useState(true);
  const [, setFrame] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [results, setResults] = useState<Partial<Record<Policy, Counts>>>({});
  const [showAssumptions, setShowAssumptions] = useState(false);

  // ---------- load data + map ----------
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = new maplibregl.Map({ container: el.current, style: style("satellite"), ...VIEW, maxPitch: 80,
                                   canvasContextAttributes: { antialias: true } });
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.current = m;
    (window as unknown as { __map?: maplibregl.Map }).__map = m;
    const fetchJson = (u: string) => fetch(u).then(r => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); });
    const loadedMap = new Promise<void>(res => m.once("load", () => res()));
    Promise.all([fetchJson("/api/sim"), fetchJson("/api/demo/roads.json"), fetchJson("/api/demo/fire_cells.geojson"),
                 fetchJson("/api/demo/building_arrivals.json"), fetchJson("/api/demo/fire_timeline.json"), loadedMap])
      .then(([simData, roads, cells, arrivals, timeline]) => {
        const d: Loaded = {
          g: new RoadGraph(roads as RoadsJson), buildings: simData.buildings, stations: simData.stations,
          origin: timeline.origin,
          cells: (cells.features as { properties: { t: number } }[]).map((f, id) => ({ id, t: f.properties.t })).sort((a, b) => a.t - b.t),
          arrivals,
        };
        data.current = d;
        m.addSource("people", { type: "geojson", promoteId: "id", data: { type: "FeatureCollection",
          features: d.buildings.map(b => ({ type: "Feature", properties: { id: b.id }, geometry: { type: "Point", coordinates: [b.lng, b.lat] } })) } });
        m.addSource("walkers", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        m.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        m.addSource("links", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        m.addLayer({ id: "routes", type: "line", source: "routes", layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#fde68a", "line-width": 2.5, "line-opacity": 0.55 } });
        m.addLayer({ id: "links", type: "line", source: "links",
          paint: { "line-color": "#fff7ed", "line-width": 2, "line-dasharray": [2, 2] } });
        m.addLayer({ id: "targets", type: "circle", source: "links", filter: ["==", ["get", "end"], 1],
          paint: { "circle-radius": 11, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#fff7ed", "circle-stroke-width": 2.5,
                   "circle-pitch-alignment": "map" } });
        m.addLayer({ id: "people", type: "circle", source: "people",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["coalesce", ["feature-state", "n"], 0], 0, 0, 1, 2, 10, 3, 100, 5.5, 400, 9],
            "circle-color": ["case", ["boolean", ["feature-state", "trapped"], false], COLORS.trapped,
                             ["boolean", ["feature-state", "need"], false], COLORS.need, COLORS.able],
            "circle-stroke-color": "#111", "circle-stroke-width": 0.6,
            "circle-opacity": ["case", ["any", ["boolean", ["feature-state", "trapped"], false], [">", ["coalesce", ["feature-state", "n"], 0], 0]], 0.92, 0],
            "circle-stroke-opacity": ["case", ["any", ["boolean", ["feature-state", "trapped"], false], [">", ["coalesce", ["feature-state", "n"], 0], 0]], 0.9, 0],
          } });
        m.addLayer({ id: "walkers", type: "circle", source: "walkers",
          paint: { "circle-radius": ["match", ["get", "k"], "need", 3.2, 2.2],
                   "circle-color": ["match", ["get", "k"], "need", COLORS.need, COLORS.able], "circle-opacity": ["get", "o"] } });
        m.on("click", "people", e => {
          const id = e.features?.[0]?.properties?.id as string | undefined;
          const b = id ? sim.current?.byId.get(id) : undefined;
          if (!b) return;
          new maplibregl.Popup({ maxWidth: "280px" }).setLngLat(e.lngLat).setHTML(
            `<b>${b.label}</b><div style="font-size:12px;line-height:1.5">Fire arrives at ${fmtT(b.fire)}<br>` +
            `Inside: ${n0(b.able + b.need)} (need help: ${n0(b.need)})<br>Evacuated: ${n0(b.evacuated)}<br>Trapped: ${n0(b.trapped)}` +
            `${b.costar ? "<br>CoStar: manager phone on file" : ""}</div>`).addTo(m);
        });
        m.on("mouseenter", "people", () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", "people", () => { m.getCanvas().style.cursor = ""; });
        setReady(true);
      })
      .catch(err => { console.error(err); alertBox(String(err)); });
    return () => { m.remove(); map.current = null; };
  }, []);

  // ---------- (re)start a run ----------
  const start = useCallback((p: Policy) => {
    const d = data.current, m = map.current;
    if (!d || !m) return;
    const s = new Simulation({ g: d.g, buildings: d.buildings, stations: d.stations }, p);
    seedHidden(s);
    sim.current = s;
    moments.current = p === "ours" ? [
      { t: DECLINE.call_min, fn: driverDeclines, done: false },
      { t: STUCK.call_min, fn: s2 => { callAt.current = s2.t; return tenantStuck(s2); }, done: false },
    ] : [];
    callAt.current = null; logSeen.current = 0; clock.current = 0;
    // map state
    m.removeFeatureState({ source: "fire" }); m.removeFeatureState({ source: "buildings" }); m.removeFeatureState({ source: "people" });
    firePtr.current = { burn: 0, cool: 0, bld: 0 };
    shown.current = new Int32Array(s.buildings.length).fill(-1);
    spawned.current = new Float64Array(s.buildings.length);
    spawnedNeed.current = new Float64Array(s.buildings.length);
    walkers.current = [];
    for (const b of s.buildings) s.dirty.add(b.idx);
    for (const { el: e, m: mk } of markers.current.values()) { mk.remove(); void e; }
    markers.current.clear();
    for (const tr of s.trucks) {
      const e = document.createElement("div");
      e.className = "truck";
      e.textContent = String(tr.station);
      const mk = new maplibregl.Marker({ element: e }).setLngLat([tr.lng, tr.lat]).addTo(m);
      markers.current.set(tr.id, { m: mk, el: e });
    }
    setLines([]); setPolicy(p); setPlaying(false);
    draw();
    setFrame(f => f + 1);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (ready) start("nearest"); }, [ready, start]);

  // ---------- draw the current sim state on the map ----------
  const draw = () => {
    const m = map.current, s = sim.current, d = data.current;
    if (!m || !s || !d) return;
    const t = s.t;
    // fire cells and burned buildings (feature-state, once per entity)
    const p = firePtr.current, c = d.cells, a = d.arrivals;
    while (p.burn < c.length && c[p.burn].t <= t) { m.setFeatureState({ source: "fire", id: c[p.burn].id }, { burned: true, front: true }); p.burn++; }
    while (p.cool < p.burn && c[p.cool].t <= t - FRONT_MIN) { m.setFeatureState({ source: "fire", id: c[p.cool].id }, { front: false }); p.cool++; }
    while (p.bld < a.length && a[p.bld][1] <= t) { m.setFeatureState({ source: "buildings", id: a[p.bld][0] }, { burned: true }); p.bld++; }
    // people dots: update only when the visible bucket changes
    const ox = d.origin[0], oy = d.origin[1];
    for (const idx of s.dirty) {
      const b = s.buildings[idx];
      const inside = b.able + b.need;
      const q = b.trapped >= 0.5 ? 10000 + Math.round(b.trapped) : inside < 0.5 ? 0 : Math.max(1, Math.round(Math.sqrt(inside) * 3)) * 2 + (b.need >= 0.5 ? 1 : 0);
      if (q !== shown.current[idx]) {
        shown.current[idx] = q;
        m.setFeatureState({ source: "people", id: b.id },
          b.trapped >= 0.5 ? { n: Math.max(1, b.trapped), trapped: true, need: true } : { n: inside < 0.5 ? 0 : inside, need: b.need >= 0.5, trapped: false });
      }
      // walkers: people leaving, moving away from the fire origin
      let dx = b.lng - ox, dy = b.lat - oy; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const ableOut = b.evacuated - b.evacuatedNeed;
      while (ableOut - spawned.current[idx] >= ABLE_PER_DOT && walkers.current.length < 1500) {
        spawned.current[idx] += ABLE_PER_DOT;
        const j = ((idx * 7919 + spawned.current[idx]) % 100) / 100 - 0.5;
        walkers.current.push({ lng: b.lng, lat: b.lat, dx: dx + j * 0.8, dy: dy - j * 0.8, t0: t, life: 6, kind: "able" });
      }
      while (b.evacuatedNeed - spawnedNeed.current[idx] >= 1 && walkers.current.length < 1500) {
        spawnedNeed.current[idx] += 1;
        const j = ((idx * 104729 + spawnedNeed.current[idx] * 31) % 100) / 100 - 0.5;
        walkers.current.push({ lng: b.lng, lat: b.lat, dx: dx + j, dy: dy - j, t0: t, life: 8, kind: "need" });
      }
    }
    s.dirty.clear();
    walkers.current = walkers.current.filter(w => t - w.t0 < w.life);
    const DEG_PER_M = 1 / 111000;
    (m.getSource("walkers") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: walkers.current.map(w => {
      const age = t - w.t0, dist = (w.kind === "need" ? 60 : 80) * age * DEG_PER_M;
      return { type: "Feature", properties: { k: w.kind, o: Math.max(0, 1 - age / w.life) },
               geometry: { type: "Point", coordinates: [w.lng + w.dx * dist / Math.cos(w.lat * Math.PI / 180), w.lat + w.dy * dist] } };
    }) });
    // trucks, their remaining route, and the dashed link to the assigned building
    const routes: GeoJSON.Feature[] = [], links: GeoJSON.Feature[] = [];
    for (const tr of s.trucks) {
      const mk = markers.current.get(tr.id);
      if (mk) {
        mk.m.setLngLat([tr.lng, tr.lat]);
        mk.el.dataset.status = tr.status;
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
    (m.getSource("routes") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: routes });
    (m.getSource("links") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: links });
  };

  // ---------- playback ----------
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now(), lastUi = 0;
    const loop = (now: number) => {
      const s = sim.current;
      if (!s) return;
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      clock.current = Math.max(clock.current, s.t);
      let target = Math.min(DURATION, clock.current + dt * speed * DURATION / RUN_SECONDS);
      let pause = false;
      for (const mo of moments.current) if (!mo.done && mo.t <= target) {
        s.advanceTo(mo.t); mo.done = true;
        const ls = mo.fn(s);
        setLines(prev => [...prev, ...ls]);
        if (pauseOnCalls) { pause = true; target = s.t; }
        break;
      }
      s.advanceTo(target);
      clock.current = target;
      if (callAt.current !== null) {
        const fu = followUps(s, logSeen.current, callAt.current);
        if (fu.length) { setLines(prev => [...prev, ...fu]); callAt.current = null; }
      }
      logSeen.current = s.log.length;
      draw();
      if (now - lastUi > 100 || pause || s.done) { lastUi = now; setFrame(f => f + 1); }
      if (s.done) { setResults(r => ({ ...r, [s.policy]: s.counts })); setPlaying(false); return; }
      if (pause) { setPlaying(false); return; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, pauseOnCalls]); // eslint-disable-line react-hooks/exhaustive-deps

  const skipToEnd = () => {
    const s = sim.current;
    if (!s) return;
    setPlaying(false);
    for (const mo of moments.current) if (!mo.done) {
      s.advanceTo(mo.t); mo.done = true;
      const ls = mo.fn(s); setLines(prev => [...prev, ...ls]);
    }
    s.advanceTo(DURATION);
    if (callAt.current !== null) { const fu = followUps(s, 0, callAt.current); if (fu.length) setLines(prev => [...prev, ...fu]); }
    draw();
    setResults(r => ({ ...r, [s.policy]: s.counts }));
    setFrame(f => f + 1);
  };

  const s = sim.current;
  const c = s?.counts;
  const t = s?.t ?? 0;
  const feed: LogEntry[] = s ? s.log.slice(-60).reverse() : [];
  const run = RUNS[policy];
  const cfg = DEFAULT_CONFIG;

  return (
    <div className="sim-root">
      <style>{CSS}</style>
      <div ref={el} className="sim-map" />
      {!ready && <div className="loading">Loading fire, roads and buildings…</div>}

      {/* left: run, clock, counters */}
      <div className="card left">
        <div className="eyebrow">Roll Call · dispatch simulation · Sunset Fire what-if</div>
        <div className="runs">
          {(["nearest", "ours"] as Policy[]).map(p => (
            <button key={p} className={`run ${policy === p ? "on" : ""}`} onClick={() => start(p)} disabled={!ready}>
              <span className="num">{RUNS[p].n}</span>{RUNS[p].title}
              {results[p] && <span className="done">✓</span>}
            </button>))}
        </div>
        <div className="sub">{run.sub}</div>
        <div className="clock">
          <button className="play" disabled={!ready || !!s?.done} onClick={() => setPlaying(p => !p)}>{playing ? "❚❚" : "▶"}</button>
          <div className="time">{fmtT(t)}<span> / 3:00 sim time</span></div>
          <div className="bar"><div style={{ width: `${(t / DURATION) * 100}%` }} /></div>
        </div>
        <div className="row">
          {[1, 2, 4].map(x => <button key={x} className={`chip ${speed === x ? "on" : ""}`} onClick={() => setSpeed(x)}>{x}×</button>)}
          <button className="chip" onClick={() => start(policy)} disabled={!ready}>restart</button>
          <button className="chip" onClick={skipToEnd} disabled={!ready || !!s?.done}>skip to end</button>
          <label className="chk"><input type="checkbox" checked={pauseOnCalls} onChange={e => setPauseOnCalls(e.target.checked)} /> pause on calls</label>
        </div>
        {c && (
          <div className="counts">
            <div><b style={{ color: COLORS.able }}>{n0(c.evacuated)}</b><span>evacuated</span></div>
            <div><b>{n0(c.inside)}</b><span>still inside<br /><i style={{ color: COLORS.need }}>{n0(c.need)} need help</i></span></div>
            <div><b style={{ color: COLORS.trapped }}>{n0(c.trapped)}</b><span>trapped<br /><i>{n0(c.trappedNeed)} needed help</i></span></div>
          </div>)}
        <div className="small">People in the {s ? s.buildings.length.toLocaleString() : "…"} buildings the fire reaches ({c ? n0(c.total) : "…"} people, estimated).
          Simulation with labeled assumptions, not a prediction. <a onClick={() => setShowAssumptions(v => !v)}>{showAssumptions ? "hide" : "show"} assumptions</a></div>
        {showAssumptions && (
          <table className="assume"><tbody>
            <tr><td>Evacuation order</td><td>at 0:00 for everyone the fire will reach</td></tr>
            <tr><td>Can leave alone</td><td>{Math.round(cfg.self_evac_rate_per_min * 100)}% of those still inside leave each minute</td></tr>
            <tr><td>Need help, alone</td><td>{Math.round(cfg.need_alone_rate_per_min * 100)}% per minute get out without a truck (results depend strongly on this)</td></tr>
            <tr><td>Truck crew</td><td>brings out {cfg.assisted_people_per_min} people per minute</td></tr>
            <tr><td>Truck speed</td><td>{cfg.truck_speed_kmh} km/h on OSM streets, no traffic, one-way rules ignored; burned streets closed</td></tr>
            <tr><td>Crews pull out</td><td>{cfg.withdraw_before_fire_min} min before the fire reaches a building (both runs)</td></tr>
            <tr><td>AI re-match</td><td>every {cfg.rematch_every_min} min and after every call; urgency = 1 / (1 + minutes left / {cfg.urgency_tau_min})</td></tr>
            <tr><td>People per building</td><td>units × 2.4 × 0.95; need help = 10% (estimate, BUILDING_MODEL.md)</td></tr>
            <tr><td>Fire</td><td>Sunset Fire origin, stronger wind toward Hollywood (138°); stops near Sunset Blvd at 3:00</td></tr>
            <tr><td>Calls</td><td>scripted demo words; effects are simulated. {STUCK.count} stuck tenants exist in both runs; only the AI run gets the call</td></tr>
            <tr><td>Trucks</td><td>8 engines from LAFD stations south of the hills; same start in both runs</td></tr>
          </tbody></table>)}
      </div>

      {/* right: agent calls + dispatch feed */}
      <div className="card right">
        {policy === "ours" && (
          <>
            <div className="h">Agent calls <span className="tag">scripted demo transcript</span></div>
            {lines.length === 0 && <div className="empty">Calls appear here: a driver declines at {fmtT(DECLINE.call_min)}, a building supervisor reports stuck tenants at {fmtT(STUCK.call_min)}.</div>}
            <div className="transcript">
              {lines.map((l, i) => (
                <div key={i} className={`ln ${l.speaker.replace(" ", "")}`}>
                  <div className="who">{fmtT(l.t)} · {l.speaker}{l.to ? ` → ${l.to}` : ""}</div>
                  <div>{l.text}</div>
                </div>))}
            </div>
          </>)}
        <div className="h">Dispatch feed <span className="tag">{s?.log.length ?? 0} events</span></div>
        <div className="feed">
          {feed.map((e, i) => (
            <div key={i} className={`ev ${e.kind}`}><span className="tm">{fmtT(e.t)}</span>{e.text}</div>))}
        </div>
      </div>

      {/* legend */}
      <div className="card legend">
        <div><i className="dot" style={{ background: COLORS.able }} />people who can leave alone (moving dot ≈ {ABLE_PER_DOT})</div>
        <div><i className="dot" style={{ background: COLORS.need }} />people who need help (moving dot = 1)</div>
        <div><i className="dot" style={{ background: COLORS.trapped }} />trapped when the fire arrived</div>
        <div><i className="truckkey">27</i>engine · dashed line = assigned building · yellow = route</div>
      </div>

      {/* comparison */}
      {(results.nearest || results.ours) && s?.done && (
        <div className="card result">
          <div className="h">Same fire, same people, same 8 trucks</div>
          <table><thead><tr><th /><th>1 · Old way</th><th>2 · Roll Call AI</th></tr></thead><tbody>
            <tr><td>Trapped</td><td>{results.nearest ? n0(results.nearest.trapped) : "–"}</td><td>{results.ours ? n0(results.ours.trapped) : "–"}</td></tr>
            <tr><td>…who needed help</td><td>{results.nearest ? n0(results.nearest.trappedNeed) : "–"}</td><td>{results.ours ? n0(results.ours.trappedNeed) : "–"}</td></tr>
            <tr><td>Evacuated</td><td>{results.nearest ? n0(results.nearest.evacuated) : "–"}</td><td>{results.ours ? n0(results.ours.evacuated) : "–"}</td></tr>
          </tbody></table>
          {results.nearest && results.ours ? (
            <div className="small">In this simulation the AI strategy leaves {n0(results.nearest.trapped - results.ours.trapped)} fewer people trapped
              ({Math.round((1 - results.ours.trapped / results.nearest.trapped) * 100)}% fewer). Simulated, with the assumptions on the left; not a count of real lives.</div>
          ) : policy === "nearest" ? (
            <button className="run on next" onClick={() => start("ours")}>Run 2: Roll Call AI →</button>
          ) : (
            <button className="run next" onClick={() => start("nearest")}>Run 1: Old way →</button>
          )}
        </div>)}
    </div>
  );
}

function alertBox(msg: string) {
  const d = document.createElement("div");
  d.textContent = `Could not load the demo data: ${msg}. Generate data/demo/ (data/README.md).`;
  Object.assign(d.style, { position: "fixed", top: "40%", left: "30%", right: "30%", background: "#7f1d1d", color: "#fff", padding: "16px", borderRadius: "8px", zIndex: "9" });
  document.body.appendChild(d);
}

const CSS = `
.sim-root{position:relative;height:100vh;width:100vw;overflow:hidden;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f4f4f5}
.sim-map{position:absolute;inset:0}
.loading{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#18181bdd;padding:12px 18px;border-radius:8px}
.card{position:absolute;background:rgba(17,17,20,.86);backdrop-filter:blur(6px);border:1px solid #ffffff1a;border-radius:10px;box-shadow:0 4px 24px #0006}
.left{top:12px;left:12px;width:360px;padding:12px 14px}
.eyebrow{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#a1a1aa}
.runs{display:flex;gap:6px;margin:8px 0 6px}
.run{flex:1;display:flex;align-items:center;gap:6px;border:1px solid #3f3f46;background:#27272a;color:#e4e4e7;border-radius:7px;padding:7px 8px;font:inherit;font-weight:600;cursor:pointer}
.run.on{background:#f97316;border-color:#f97316;color:#111}
.run .num{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;background:#0003;font-size:11px}
.run .done{margin-left:auto}
.sub{font-size:12px;color:#d4d4d8;min-height:34px}
.clock{display:flex;align-items:center;gap:10px;margin:10px 0 6px}
.play{width:38px;height:38px;border-radius:50%;border:0;background:#f4f4f5;color:#111;font-size:14px;cursor:pointer}
.play:disabled{opacity:.4}
.time{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.time span{font-size:11px;font-weight:400;color:#a1a1aa}
.bar{flex:1;height:4px;background:#3f3f46;border-radius:2px;overflow:hidden}
.bar div{height:100%;background:#f97316}
.row{display:flex;gap:5px;align-items:center;flex-wrap:wrap}
.chip{border:1px solid #3f3f46;background:#27272a;color:#e4e4e7;border-radius:6px;padding:3px 8px;font:inherit;font-size:12px;cursor:pointer}
.chip.on{background:#e4e4e7;color:#111}
.chip:disabled{opacity:.4}
.chk{font-size:12px;color:#d4d4d8;display:flex;gap:4px;align-items:center}
.counts{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin:12px 0 8px}
.counts div{background:#27272a;border-radius:8px;padding:8px}
.counts b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.counts span{font-size:11px;color:#a1a1aa}
.counts i{font-style:normal}
.small{font-size:11px;color:#a1a1aa}
.small a{color:#fdba74;cursor:pointer;text-decoration:underline}
.assume{margin-top:6px;font-size:11px;border-collapse:collapse}
.assume td{padding:3px 4px;border-top:1px solid #ffffff12;vertical-align:top}
.assume td:first-child{color:#a1a1aa;white-space:nowrap}
.right{top:12px;right:56px;width:380px;bottom:12px;padding:12px 14px;display:flex;flex-direction:column;gap:6px}
.h{font-weight:700;font-size:13px;display:flex;align-items:center;gap:8px}
.tag{font-weight:400;font-size:10px;color:#a1a1aa;border:1px solid #3f3f46;border-radius:10px;padding:1px 6px}
.empty{font-size:12px;color:#a1a1aa}
.transcript{max-height:46%;overflow:auto;display:flex;flex-direction:column;gap:6px;margin-bottom:6px}
.ln{background:#27272a;border-radius:8px;padding:6px 8px;font-size:12px;border-left:3px solid #f97316}
.ln.Driver{border-left-color:#60a5fa}.ln.Supervisor{border-left-color:#c084fc}.ln.System{border-left-color:#71717a}
.ln .who{font-size:10px;color:#a1a1aa;margin-bottom:2px}
.feed{flex:1;overflow:auto;font-size:11.5px}
.ev{padding:3px 0;border-bottom:1px solid #ffffff0d;color:#d4d4d8}
.ev .tm{color:#71717a;font-variant-numeric:tabular-nums;margin-right:6px}
.ev.reassign{color:#fde68a}.ev.withdraw,.ev.unassign{color:#fca5a5}.ev.call{color:#c4b5fd}.ev.arrive{color:#86efac}
.legend{left:64px;bottom:12px;padding:8px 10px;font-size:11.5px;display:flex;flex-direction:column;gap:3px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:-1px}
.truckkey{display:inline-block;font-style:normal;background:#f97316;color:#111;font-weight:700;font-size:10px;border-radius:3px;padding:0 3px;margin-right:6px}
.result{left:50%;transform:translateX(-50%);bottom:16px;width:420px;padding:12px 14px}
.result table{width:100%;border-collapse:collapse;margin:6px 0}
.result th{font-size:11px;color:#a1a1aa;text-align:right;font-weight:600}
.result td{padding:3px 0;text-align:right;font-variant-numeric:tabular-nums;font-size:15px}
.result td:first-child{text-align:left;font-size:12px;color:#d4d4d8}
.next{width:100%;justify-content:center;margin-top:4px}
.truck{background:#f97316;color:#111;font:700 11px/1 -apple-system,sans-serif;padding:3px 4px;border-radius:4px;border:2px solid #fff;box-shadow:0 1px 6px #000a;transition:background .3s}
.truck[data-status=on_scene]{background:#22c55e}
.truck[data-status=idle]{background:#d4d4d8}
.truck[data-status=unavailable]{background:#52525b;color:#fff;border-style:dashed}
@media (max-width:900px){.right{display:none}.left{width:calc(100vw - 24px)}}
`;
