"use client";
// /sim: today's 911-call dispatch vs Roll Call AI dispatch, on the same fire, people, calls and trucks.
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { BUILDING_COLORS, style } from "../3d/mapStyle";
import { DEFAULT_CONFIG, Simulation, type LogEntry, type Policy } from "../../lib/sim/engine";
import { ABLE_PER_DOT, COLORS, NEED_PER_DOT, RISK_RAMP, SimRenderer, TRUCK_CSS, fmtT, frameSim, loadSimLayers, n0, setHills, type Loaded } from "./simMap";
import { DECLINE, STUCK, driverDeclines, followUps, seedHidden, tenantStuck, type Line } from "../../lib/sim/script";

const DURATION = 180, RUN_SECONDS = 25;
const VIEW = { center: [-118.338, 34.094] as [number, number], zoom: 13.75, pitch: 45, bearing: 0 };
const RUNS: Record<Policy, { n: number; title: string; sub: string }> = {
  calls: { n: 1, title: "Today: 911 calls", sub: "A truck goes only where someone got through on 911. Calls are answered in order; the oldest call gets the closest free truck. No re-planning." },
  nearest: { n: 1, title: "Nearest first", sub: "Each free truck goes to the nearest building that needs help. It never re-plans." },
  ours: { n: 2, title: "Roll Call AI", sub: "Ranks buildings by a risk score that rises as the fire comes near (people who cannot leave alone, from building records, × fire threat), and sends each truck where it helps the most per minute of driving and work. Only if the truck can arrive before the fire. Re-plans every 5 min and after every call." },
};

type Counts = Simulation["counts"];

export default function SimView() {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const data = useRef<Loaded | null>(null);
  const sim = useRef<Simulation | null>(null);
  const renderer = useRef<SimRenderer | null>(null);
  const moments = useRef<{ t: number; fn: (s: Simulation) => Line[]; done: boolean }[]>([]);
  const logSeen = useRef(0);
  const callAt = useRef<number | null>(null);
  const clock = useRef(0);   // playback clock (sim minutes); the sim advances in fixed ticks up to it

  const [ready, setReady] = useState(false);
  const [policy, setPolicy] = useState<Policy>("calls");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [pauseOnCalls, setPauseOnCalls] = useState(true);
  const [, setFrame] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [results, setResults] = useState<Partial<Record<Policy, Counts>>>({});
  const [showAssumptions, setShowAssumptions] = useState(false);
  const [hills, setHillsUi] = useState(false);
  const [riskView, setRiskView] = useState(false);
  // small screens: the feed and the legend start closed, so the trucks have room (a 1000 px wide window left 190 px)
  const [legendOpen, setLegendOpen] = useState(() => typeof window === "undefined" || window.innerHeight >= 900);
  const [feedOpen, setFeedOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 1400);
  // the camera follows the trucks (all 8 + the buildings stay in the free part of the screen) until the user moves the map
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  followRef.current = follow;

  // ---------- load data + map ----------
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = new maplibregl.Map({ container: el.current, style: style("satellite"), ...VIEW, maxPitch: 80,
                                   canvasContextAttributes: { antialias: true } });
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.current = m;
    (window as unknown as { __map?: maplibregl.Map }).__map = m;
    // debugging handles (local prototype only): current simulation and renderer, for timing in the console
    Object.defineProperty(window, "__sim", { configurable: true, get: () => sim.current });
    Object.defineProperty(window, "__renderer", { configurable: true, get: () => renderer.current });
    m.once("load", () => setHills(m, false));
    loadSimLayers(m).then(d => {
      data.current = d;
      renderer.current = new SimRenderer(m, d);
      m.on("click", "buildings", e => {
        const id = e.features?.[0]?.properties?.id as string | undefined;
        const b = id ? sim.current?.byId.get(id) : undefined;
        if (!b) return;   // only buildings the fire reaches have people in the simulation
        new maplibregl.Popup({ maxWidth: "280px" }).setLngLat(e.lngLat).setHTML(
          `<b>${b.label}</b><div style="font-size:12px;line-height:1.5">Fire arrives at ${fmtT(b.fire)}<br>` +
          `Inside: ${n0(b.able + b.need)} (need help: ${n0(b.need)})<br>Evacuated: ${n0(b.evacuated)}<br>Trapped: ${n0(b.trapped)}` +
          `${b.costar ? "<br>CoStar: manager phone on file" : ""}` + riskHtml(sim.current!, b) + `</div>`).addTo(m);
      });
      // a drag, wheel or pinch by the user stops the follow camera (events from easeTo have no originalEvent)
      const stop = (e: { originalEvent?: unknown }) => { if (e.originalEvent) setFollow(false); };
      m.on("dragstart", stop); m.on("zoomstart", stop); m.on("rotatestart", stop); m.on("pitchstart", stop);
      m.on("mouseenter", "buildings", () => { m.getCanvas().style.cursor = "pointer"; });
      m.on("mouseleave", "buildings", () => { m.getCanvas().style.cursor = ""; });
      setReady(true);
    }).catch(err => { console.error(err); alertBox(String(err)); });
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
    ] : p === "calls" ? [
      // the same supervisor calls 911 today: the call waits in the same queue as everyone else
      { t: STUCK.call_min, fn: s2 => { s2.addCall(STUCK.building_id); const b = s2.byId.get(STUCK.building_id)!;
        return [{ t: s2.t, speaker: "Supervisor" as const, to: "911", text: `This is the building manager at ${b.label}. A tenant in a wheelchair is stuck on the 4th floor with two neighbors.` },
                { t: s2.t, speaker: "System" as const, text: `The call joins the 911 queue: ${s2.ringing().length} buildings are waiting for help.` }]; }, done: false },
    ] : [];
    callAt.current = null; logSeen.current = 0; clock.current = 0;
    renderer.current?.reset(s);
    setLines([]); setPolicy(p); setPlaying(false);
    draw();
    if (followRef.current) requestAnimationFrame(() => frameSim(m, s, 0));
    setFrame(f => f + 1);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (ready) start("calls"); }, [ready, start]);
  // a call opens the feed (the transcript is part of the story); the free area changed, so frame again
  // (wide screens only: on a narrow screen the feed would cover the map, so the call shows in a small box instead)
  useEffect(() => { if (lines.length && window.innerWidth >= 1400) setFeedOpen(true); }, [lines.length]);
  useEffect(() => {
    const m = map.current, s0 = sim.current;
    if (m && s0 && followRef.current) requestAnimationFrame(() => frameSim(m, s0, 600));
  }, [feedOpen, legendOpen]);

  // force = redraw everything now (after a user action); the play loop passes false (moving layers ~20/s)
  const draw = (force = true) => { if (sim.current) renderer.current?.draw(sim.current, [], force); };

  // ---------- playback ----------
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now(), lastUi = 0, lastCam = 0;
    const loop = (now: number) => {
      const s = sim.current;
      if (!s) return;
      // update at most 30 times a second: the map redraws on every change, and a busy laptop cannot keep up with 120
      if (now - last < 30) { raf = requestAnimationFrame(loop); return; }
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
      draw(s.done);
      // camera: at most every 2 s, a 1.5 s ease (each move redraws the whole map, so not every frame)
      if (followRef.current && map.current && now - lastCam > 2000) { lastCam = now; frameSim(map.current, s, 1500); }
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
      <style>{CSS + TRUCK_CSS}</style>
      <div ref={el} className="sim-map" />
      {!ready && <div className="loading">Loading fire, roads and buildings…</div>}

      {/* left: run, clock, counters */}
      <div className="card left">
        <div className="eyebrow">Roll Call · dispatch simulation · Sunset Fire what-if</div>
        <div className="runs">
          {(["calls", "ours"] as Policy[]).map(p => (
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
          <button className={`chip ${hills ? "on" : ""}`} title="Real hill heights. Prettier, but slower while playing."
            onClick={() => { const v = !hills; setHillsUi(v); if (map.current) setHills(map.current, v); }}>3D hills</button>
          <button className={`chip ${riskView ? "on" : ""}`} title="Color buildings by the risk score now: it rises as the fire comes near"
            onClick={() => { const v = !riskView; setRiskView(v); renderer.current?.setRiskView(v, sim.current); }}>risk view</button>
          <button className={`chip ${follow ? "on" : ""}`} title="Keep all 8 trucks and the buildings in view"
            onClick={() => { setFollow(true); if (map.current && s) frameSim(map.current, s, 800); }}>follow trucks</button>
          <label className="chk"><input type="checkbox" checked={pauseOnCalls} onChange={e => setPauseOnCalls(e.target.checked)} /> pause on calls</label>
        </div>
        {c && (
          <div className="counts">
            <div><b style={{ color: COLORS.able }}>{n0(c.evacuated)}</b><span>evacuated</span></div>
            <div><b>{n0(c.inside)}</b><span>still inside<br /><i style={{ color: COLORS.need }}>{n0(c.need)} need help</i></span></div>
            <div><b style={{ color: COLORS.trapped }}>{n0(c.trapped)}</b><span>trapped<br /><i>{n0(c.trappedNeed)} needed help</i></span></div>
          </div>)}
        {s && <div className="small">📞 {s.ringing().length} buildings called and wait for help · {s.calls.filter(x => x.t_call <= t).length} calls so far</div>}
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
            <tr><td>Risk score</td><td>risk = people who need help × {cfg.risk_structure ? "structure factor × " : ""}threat. People: Rasul&apos;s people_at_risk from building records (CoStar / County Assessor, Supabase), until a call gives the real count. Threat = 1 + {cfg.threat_boost} × urgency, urgency = 1 / (1 + minutes until fire / {cfg.urgency_tau_min}): 1 when the fire is far, up to {cfg.threat_boost + 1} when it arrives. Structure factor (trees, neighbors, construction): {cfg.risk_structure ? "on" : "off"}. Ranking only: the simulated people are the same in both runs</td></tr>
            <tr><td>AI choice</td><td>pair value = risk ÷ (drive min + min on scene + 1); best pair first</td></tr>
            <tr><td>AI re-match</td><td>every {cfg.rematch_every_min} min and after every call</td></tr>
            <tr><td>People per building</td><td>units × 2.4 × 0.95; need help = 10% (estimate, BUILDING_MODEL.md)</td></tr>
            <tr><td>Fire</td><td>Sunset Fire origin, stronger wind toward Hollywood (about 130°); the front stops at Hollywood Blvd at 3:00 (crews hold the line)</td></tr>
            <tr><td>911 calls</td><td>{Math.round(cfg.call_share * 100)}% of buildings with people who need help call, {cfg.call_lead_min[0]}–{cfg.call_lead_min[1]} min before the fire reaches them; {cfg.call_takers} call-takers, {cfg.call_handle_min} min per call, answered in order (same calls in both runs)</td></tr>
            <tr><td>Today</td><td>oldest answered call → closest free truck by road (CAD + GPS); trucks do not re-plan; buildings that never call get no truck</td></tr>
            <tr><td>Agent calls</td><td>scripted demo words; effects are simulated. {STUCK.count} stuck tenants exist in both runs; in run 1 the supervisor calls 911</td></tr>
            <tr><td>Trucks</td><td>8 engines from LAFD stations south of the hills; same start in both runs</td></tr>
          </tbody></table>)}
      </div>

      {/* right: agent calls + dispatch feed */}
      {!feedOpen && lines.length > 0 && (
        <div className="card toast">
          {lines.slice(-2).map((l, i) => (
            <div key={i} className={`ln ${l.speaker.replace(" ", "")}`}>
              <div className="who">{fmtT(l.t)} · {l.speaker}{l.to ? ` → ${l.to}` : ""}</div><div>{l.text}</div>
            </div>))}
        </div>)}
      {!feedOpen && <button className="card feedbtn" onClick={() => setFeedOpen(true)}>{policy === "ours" ? "calls + " : ""}dispatch feed ◂</button>}
      {feedOpen && <div className="card right">
        <button className="lgt close" onClick={() => setFeedOpen(false)}>hide ▸</button>
        {(policy === "ours" || lines.length > 0) && (
          <>
            <div className="h">{policy === "ours" ? "Agent calls" : "Calls"} <span className="tag">scripted demo transcript</span></div>
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
      </div>}

      {/* legend */}
      <div className={`card legend ${legendOpen ? "" : "closed"}`}>
        <button className="lgt" onClick={() => setLegendOpen(v => !v)}>{legendOpen ? "hide legend ▾" : "legend ▴"}</button>
        <div className="lh">Buildings</div>
        {riskView ? (
          <div style={{ gridColumn: "1/-1" }}>risk now (people who need help × fire threat):{" "}
            <span className="ramp">{RISK_RAMP.map(c => <i key={c} style={{ background: c }} />)}</span> low → high</div>
        ) : <div><i className="sq" style={{ background: BUILDING_COLORS.occupied }} />people still inside</div>}
        <div><i className="sq" style={{ background: BUILDING_COLORS.empty }} />everyone out</div>
        <div><i className="sq" style={{ background: BUILDING_COLORS.burnedEmpty }} />burned, empty</div>
        <div><i className="sq" style={{ background: BUILDING_COLORS.burnedTrapped }} />burned, people inside</div>
        <div className="lh">People walking to safety on the streets</div>
        <div><i className="dot" style={{ background: COLORS.able }} />left on their own, fast (1 dot = {ABLE_PER_DOT})</div>
        <div><i className="dot" style={{ background: COLORS.need }} />needed help, slow (1 dot = {NEED_PER_DOT})</div>
        <div><span style={{ marginRight: 6 }}>🚒</span>fire truck (station number) · ladder up = working at a building</div>
        <div><span style={{ marginRight: 6, letterSpacing: 1 }}>- - -</span>truck driving to that building</div>
        <div><span style={{ marginRight: 6 }}>📞</span>called 911: shaking = waiting, still = truck on the way</div>
      </div>

      {/* comparison */}
      {(results.calls || results.ours) && s?.done && (
        <div className="card result">
          <div className="h">Same fire, same people, same 8 trucks</div>
          <table><thead><tr><th /><th>1 · Today</th><th>2 · Roll Call AI</th></tr></thead><tbody>
            <tr><td>Trapped</td><td>{results.calls ? n0(results.calls.trapped) : "–"}</td><td>{results.ours ? n0(results.ours.trapped) : "–"}</td></tr>
            <tr><td>…who needed help</td><td>{results.calls ? n0(results.calls.trappedNeed) : "–"}</td><td>{results.ours ? n0(results.ours.trappedNeed) : "–"}</td></tr>
            <tr><td>Evacuated</td><td>{results.calls ? n0(results.calls.evacuated) : "–"}</td><td>{results.ours ? n0(results.ours.evacuated) : "–"}</td></tr>
          </tbody></table>
          {results.calls && results.ours ? (
            <div className="small">In this simulation Roll Call leaves {n0(results.calls.trapped - results.ours.trapped)} fewer people trapped
              ({Math.round((1 - results.ours.trapped / results.calls.trapped) * 100)}% fewer). Simulated, with the assumptions on the left; not a count of real lives.</div>
          ) : policy === "calls" ? (
            <button className="run on next" onClick={() => start("ours")}>Run 2: Roll Call AI →</button>
          ) : (
            <button className="run next" onClick={() => start("calls")}>Run 1: Today (911 calls) →</button>
          )}
        </div>)}
    </div>
  );
}

/** Popup lines: the dynamic risk score now and what it is made of. */
function riskHtml(s: Simulation, b: Simulation["buildings"][number]): string {
  if (b.burned || b.needKnown <= 0.5) return "";
  const r = s.riskOf(b);
  return `<br><b>Risk now ${r.risk.toFixed(1)}</b> = ${r.people.toFixed(1)} people (${r.source})` +
    `${r.structure !== 1 ? ` × structure ${r.structure.toFixed(2)}` : ""} × threat ${r.threat.toFixed(2)}` +
    `${b.riskStatic != null ? `<br>Static score (Rasul): ${b.riskStatic.toFixed(1)}` : "<br>No static score (not in Supabase)"}`;
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
.toast{left:50%;transform:translateX(-50%);bottom:44px;width:min(440px,calc(100vw - 420px));padding:8px;display:flex;flex-direction:column;gap:6px}
.feedbtn{top:12px;right:56px;padding:6px 10px;color:#e4e4e7;font:inherit;font-size:12px;cursor:pointer}
.right .close{position:absolute;top:10px;right:12px}
.legend{left:64px;bottom:12px;padding:6px 10px 8px;font-size:11px;display:grid;grid-template-columns:auto auto;column-gap:16px;row-gap:2px;color:#f4f4f5;max-width:560px}
.legend .lh,.legend .lgt{grid-column:1/-1}
.legend.closed{display:block;padding:4px 8px}
.legend.closed>*:not(.lgt){display:none}
.lgt{justify-self:end;background:none;border:0;color:#a1a1aa;font:inherit;font-size:10.5px;cursor:pointer;padding:0}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:-1px}
.sq{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px;outline:1px solid #ffffff40}
.ramp{display:inline-flex;vertical-align:-1px;margin:0 4px}.ramp i{width:12px;height:10px;display:block}
.lh{font-weight:700;color:#a1a1aa;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;margin-top:2px}
.truckkey{display:inline-block;font-style:normal;background:#f97316;color:#111;font-weight:700;font-size:10px;border-radius:3px;padding:0 3px;margin-right:6px}
.result{left:50%;transform:translateX(-50%);bottom:16px;width:420px;padding:12px 14px}
.result table{width:100%;border-collapse:collapse;margin:6px 0}
.result th{font-size:11px;color:#a1a1aa;text-align:right;font-weight:600}
.result td{padding:3px 0;text-align:right;font-variant-numeric:tabular-nums;font-size:15px}
.result td:first-child{text-align:left;font-size:12px;color:#d4d4d8}
.next{width:100%;justify-content:center;margin-top:4px}
@media (max-width:900px){.right{display:none}.left{width:calc(100vw - 24px)}}
`;
