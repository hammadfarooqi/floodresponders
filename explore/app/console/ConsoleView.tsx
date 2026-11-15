"use client";
// /console: "your screen with Roll Call". The AI makes the calls and proposes truck-to-building pairings; the
// dispatcher monitors every call and every pairing change and can approve, reject, or edit each one, and add input.
// Layout follows a CAD dispatch screen (research: explore/research/DISPATCH_TODAY.md): unit status board, pending
// queue, AVL map, running log; plus the AI parts (proposals with reasons, call transcripts).
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { BUILDING_COLORS, style } from "../3d/mapStyle";
import { Simulation, mins, type Proposal, type SimBuilding, type Truck } from "../../lib/sim/engine";
import { DECLINE, STUCK, driverDeclines, followUps, seedHidden, tenantStuck, type Line } from "../../lib/sim/script";
import { COLORS, SimRenderer, TRUCK_CSS, fmtT, frameSim, loadSimLayers, n0, setHills, type Loaded } from "../sim/simMap";

const DURATION = 180;
const VIEW = { center: [-118.327, 34.0965] as [number, number], zoom: 13.55, pitch: 35, bearing: 0 };
const SPEEDS = [{ x: 0.25, label: "15×" }, { x: 0.5, label: "30×" }, { x: 1, label: "60×" }];  // sim min per wall second
type Mode = "auto" | "ask";
const REVIEW_SECONDS = 20;  // auto mode: an applied change stays on screen this long for OK / Undo / Edit

interface Pending extends Proposal { id: number; wall: number; t: number; applied: boolean }
type FeedItem =
  | { k: "log"; t: number; kind: string; text: string; speaker?: string; truck?: string; building?: string }
  | { k: "call"; t: number; title: string; lines: Line[] }
  | { k: "disp"; t: number; text: string };

let nextId = 1;
/** Routine call = the AI telling a driver about a new assignment. Inbound and agent-moment calls are not routine. */
const routine = (f: FeedItem) => f.k === "call" && f.title.startsWith("Roll Call →");

export default function ConsoleView() {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const data = useRef<Loaded | null>(null);
  const renderer = useRef<SimRenderer | null>(null);
  const sim = useRef<Simulation | null>(null);
  const pending = useRef<Pending[]>([]);
  const feed = useRef<FeedItem[]>([]);
  const logSeen = useRef(0);
  const callAt = useRef<number | null>(null);
  const moments = useRef<{ t: number; title: string; fn: (s: Simulation) => Line[]; done: boolean }[]>([]);
  const clock = useRef(0);
  const mode = useRef<Mode>("auto");
  const stats = useRef({ approved: 0, rejected: 0, edited: 0, auto: 0 });

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0.5);
  const [modeUi, setModeUi] = useState<Mode>("auto");
  const [, setFrame] = useState(0);
  const [selUnit, setSelUnit] = useState<string | null>(null);
  const [selBld, setSelBld] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "calls" | "pairings" | "dispatcher">("all");
  const [cmd, setCmd] = useState("");
  const [cmdMsg, setCmdMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [hills, setHillsUi] = useState(false);
  const refresh = () => setFrame(f => f + 1);
  const followRef = useRef(true);

  // ---------- setup ----------
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = new maplibregl.Map({ container: el.current, style: style("satellite"), ...VIEW, maxPitch: 80,
                                   canvasContextAttributes: { antialias: true }, attributionControl: { compact: true } });
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.current = m;
    (window as unknown as { __map?: maplibregl.Map }).__map = m;
    Object.defineProperty(window, "__sim", { configurable: true, get: () => sim.current });
    Object.defineProperty(window, "__renderer", { configurable: true, get: () => renderer.current });
    m.once("load", () => setHills(m, false));
    // follow camera: keeps all 8 trucks and the buildings in view until the user moves the map (then "follow" turns off)
    const stop = (e: { originalEvent?: unknown }) => { if (e.originalEvent) followRef.current = false; };
    m.on("dragstart", stop); m.on("zoomstart", stop); m.on("rotatestart", stop); m.on("pitchstart", stop);
    loadSimLayers(m).then(d => {
      data.current = d;
      renderer.current = new SimRenderer(m, d);
      renderer.current.onTruckClick = id => setSelUnit(id);
      m.on("click", "buildings", e => { const id = e.features?.[0]?.properties?.id as string | undefined; if (id && sim.current?.byId.has(id)) setSelBld(id); });
      m.on("mouseenter", "buildings", () => { m.getCanvas().style.cursor = "pointer"; });
      m.on("mouseleave", "buildings", () => { m.getCanvas().style.cursor = ""; });
      start();
      setReady(true);
    }).catch(err => console.error(err));
    return () => { m.remove(); map.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = () => {
    const d = data.current;
    if (!d) return;
    const s = new Simulation({ g: d.g, buildings: d.buildings, stations: d.stations }, "ours");
    seedHidden(s);
    // Every pairing change reaches the dispatcher. "auto": the AI applies it at once and the dispatcher reviews it
    // (OK / Undo / Edit). "ask": nothing moves until the dispatcher approves.
    s.approve = proposals => {
      const out: Proposal[] = [];
      for (const p of proposals) {
        if (p.prev === p.building) continue;
        if (mode.current === "auto") {
          out.push(p);
          pending.current = pending.current.filter(x => x.truck !== p.truck);
          pending.current.push({ ...p, id: nextId++, wall: performance.now(), t: s.t, applied: true });
          stats.current.auto++;
          notifyDriver(s, p);
        } else {
          const cur = pending.current.find(x => x.truck === p.truck && !x.applied);
          if (cur) { if (cur.building === p.building) { cur.eta_min = p.eta_min; cur.reason = p.reason; } continue; } // keep the card the dispatcher is reading
          pending.current.push({ ...p, id: nextId++, wall: performance.now(), t: s.t, applied: false });
        }
      }
      return out;
    };
    s.approvalRequired = mode.current === "ask";
    sim.current = s;
    pending.current = []; feed.current = []; logSeen.current = 0; callAt.current = null; clock.current = 0;
    stats.current = { approved: 0, rejected: 0, edited: 0, auto: 0 };
    moments.current = [
      { t: DECLINE.call_min, title: "Driver declines", fn: driverDeclines, done: false },
      { t: STUCK.call_min, title: "Supervisor: tenants stuck", fn: s2 => { callAt.current = s2.t; return tenantStuck(s2); }, done: false },
    ];
    renderer.current?.reset(s);
    const m = map.current;
    if (m && followRef.current) requestAnimationFrame(() => frameSim(m, s, 0));
    setPlaying(false); setSelBld(null); setSelUnit(null);
    s.advanceTo(0.1);   // first match: proposals appear at once
    syncFeed(); draw(); refresh();
  };

  // force = redraw everything now (after a user action); the play loop passes false (moving layers ~20/s)
  const draw = (force = true) => { const s = sim.current; if (s) renderer.current?.draw(s, pending.current.filter(p => !p.applied), force); };
  const notifyDriver = (s: Simulation, p: Proposal) => {
    const tr = s.trucks.find(x => x.id === p.truck)!, b = s.byId.get(p.building)!;
    feed.current.push({ k: "call", t: s.t, title: `Roll Call → ${tr.name}`, lines: [
      { t: s.t, speaker: "Roll Call", to: tr.name, text: `${tr.name}, new assignment: ${b.label}. About ${Math.round(b.needKnown)} people need help. Fire expected in ${mins(b.fire - s.t)}. ETA ${mins(p.eta_min)}.` },
      { t: s.t, speaker: "Driver", to: "Roll Call", text: `Copy, ${tr.name} en route to ${b.label}.` }] });
  };

  // copy new engine log entries into the feed (calls are added separately with their transcript)
  const syncFeed = () => {
    const s = sim.current!;
    for (const e of s.log.slice(logSeen.current)) {
      if (e.kind === "call") continue;
      feed.current.push({ k: "log", t: e.t, kind: e.kind, text: e.text, speaker: e.speaker, truck: e.truck, building: e.building });
    }
    if (callAt.current !== null) {
      const fu = followUps(s, logSeen.current, callAt.current);
      if (fu.length) { feed.current.push({ k: "call", t: s.t, title: "Callback to supervisor", lines: fu }); callAt.current = null; }
    }
    logSeen.current = s.log.length;
  };
  const disp = (text: string) => feed.current.push({ k: "disp", t: sim.current?.t ?? 0, text });

  // ---------- proposal actions ----------
  const drop = (id: number) => { pending.current = pending.current.filter(p => p.id !== id); };
  /** Approve a waiting proposal, or say OK to an applied one. */
  const approve = (p: Pending) => {
    const s = sim.current!;
    drop(p.id);
    stats.current.approved++;
    const tr = s.trucks.find(x => x.id === p.truck)!, b = s.byId.get(p.building)!;
    if (p.applied) { disp(`OK: ${tr.name} → ${b.label}`); return; }
    const ok = s.applyProposal(p);
    disp(ok ? `Approved: ${tr.name} → ${b.label}` : `Could not apply ${tr.name} → ${b.label} (truck or building no longer available).`);
    if (ok) notifyDriver(s, p);
    syncFeed();
  };
  /** Reject a waiting proposal, or undo an applied one. Either way the AI will not pair these two for 10 min. */
  const reject = (p: Pending) => {
    const s = sim.current!;
    drop(p.id); s.veto(p.truck, p.building); stats.current.rejected++;
    const tr = s.trucks.find(x => x.id === p.truck)!, b = s.byId.get(p.building)!;
    if (p.applied && tr.building === p.building) {
      s.release(tr.id);
      feed.current.push({ k: "call", t: s.t, title: `Roll Call → ${tr.name}`, lines: [
        { t: s.t, speaker: "Roll Call", to: tr.name, text: `${tr.name}, disregard ${b.label}. Stand by for a new assignment.` }] });
    }
    disp(`${p.applied ? "Undone" : "Rejected"}: ${tr.name} → ${b.label}. The AI will not pair them again for 10 min.`);
    if (tr.status === "idle") s.rematch(false);
    syncFeed();
  };
  const editTo = (p: Pending, truckId: string) => {
    const s = sim.current!;
    drop(p.id);
    pending.current = pending.current.filter(x => x.truck !== truckId || x.applied);
    const tr = s.trucks.find(x => x.id === truckId)!, b = s.byId.get(p.building)!;
    if (p.applied) { s.veto(p.truck, p.building); s.release(p.truck); }
    const ok = s.applyProposal({ truck: truckId, building: p.building, reason: `Dispatcher edit: ${b.label}.` });
    stats.current.edited++;
    disp(ok ? `Edited: ${tr.name} (not ${p.truck}) → ${b.label}` : `Edit failed: ${tr.name} cannot reach ${b.label}.`);
    if (ok) notifyDriver(s, { truck: truckId, building: p.building, eta_min: tr.eta_min ?? 0, reason: "", prev: null });
    s.rematch(false);
    setEditing(null); syncFeed();
  };

  // ---------- dispatcher input ----------
  const unitFrom = (tok: string) => {
    const n = tok.replace(/^(e|engine)/i, "");
    return sim.current?.trucks.find(t => String(t.station) === n) ?? null;
  };
  const bldFrom = (q: string): SimBuilding | null => {
    const s = sim.current!; const k = q.trim().toLowerCase();
    if (!k) return null;
    return s.buildings.find(b => b.id === k) ?? s.buildings.find(b => b.label.toLowerCase() === k)
      ?? s.buildings.find(b => b.label.toLowerCase().includes(k)) ?? null;
  };
  const run = (text: string) => {
    const s = sim.current;
    if (!s) return;
    const t = text.trim(); let m: RegExpMatchArray | null;
    const say = (ok: boolean, msg: string) => { setCmdMsg({ ok, text: msg }); if (ok) { disp(msg); setCmd(""); } syncFeed(); refresh(); };
    if ((m = t.match(/^(e?\d+)\s+(out|oos|out of service)(?:\s+(\d+))?(.*)$/i))) {
      const u = unitFrom(m[1]); if (!u) return say(false, `No unit ${m[1]}.`);
      const minutes = m[3] ? Number(m[3]) : 999;
      s.outOfService(u.id, minutes, m[4]?.trim() || "dispatcher input");
      pending.current = pending.current.filter(p => p.truck !== u.id);
      return say(true, `${u.name} out of service${minutes < 999 ? ` for ${minutes} min` : ""}. AI re-matches without it.`);
    }
    if ((m = t.match(/^(e?\d+)\s+(back|in service|available)$/i))) {
      const u = unitFrom(m[1]); if (!u) return say(false, `No unit ${m[1]}.`);
      s.backInService(u.id); return say(true, `${u.name} back in service.`);
    }
    if ((m = t.match(/^hold\s+(e?\d+)$/i))) {
      const u = unitFrom(m[1]); if (!u) return say(false, `No unit ${m[1]}.`);
      s.locks.set(u.id, u.building); pending.current = pending.current.filter(p => p.truck !== u.id);
      return say(true, `Hold on ${u.name}: the AI will not move it.`);
    }
    if ((m = t.match(/^release\s+(e?\d+)$/i))) {
      const u = unitFrom(m[1]); if (!u) return say(false, `No unit ${m[1]}.`);
      s.locks.delete(u.id); return say(true, `${u.name} released to the AI.`);
    }
    if ((m = t.match(/^send\s+(e?\d+)\s+to\s+(.+)$/i))) {
      const u = unitFrom(m[1]); if (!u) return say(false, `No unit ${m[1]}.`);
      const b = bldFrom(m[2]); if (!b) return say(false, `No building matches "${m[2]}".`);
      pending.current = pending.current.filter(p => p.truck !== u.id);
      const ok = s.applyProposal({ truck: u.id, building: b.id, reason: "Dispatcher order." });
      if (ok) s.locks.set(u.id, b.id);
      return ok ? say(true, `${u.name} sent to ${b.label} and held there.`) : say(false, `${u.name} cannot reach ${b.label}.`);
    }
    if ((m = t.match(/^stuck\s+(\d+)\s+(?:at\s+)?(.+)$/i))) {
      const b = bldFrom(m[2]); if (!b) return say(false, `No building matches "${m[2]}".`);
      b.need += Number(m[1]); b.stuck += Number(m[1]);
      s.applyEvent({ type: "tenant_stuck", building_id: b.id, count: Number(m[1]), note: "dispatcher input" });
      s.rematch(true);
      return say(true, `${m[1]} people who cannot get out reported at ${b.label}. AI re-matched.`);
    }
    return say(false, `Not understood. Try: "E27 out 20", "E27 back", "hold E35", "release E35", "send E41 to Lanewood", "stuck 2 at Franklin Plaza".`);
  };

  // ---------- playback ----------
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now(), lastUi = 0, lastCam = 0;
    const loop = (now: number) => {
      const s = sim.current!;
      // update at most 30 times a second: the map redraws on every change, and a busy laptop cannot keep up with 120
      if (now - last < 30) { raf = requestAnimationFrame(loop); return; }
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      clock.current = Math.max(clock.current, s.t);
      const target = Math.min(DURATION, clock.current + dt * speed);
      for (const mo of moments.current) if (!mo.done && mo.t <= target) {
        s.advanceTo(mo.t); mo.done = true;
        syncFeed();
        const lines = mo.fn(s);
        if (lines.length) feed.current.push({ k: "call", t: s.t, title: mo.title, lines });
        syncFeed();
      }
      s.advanceTo(target);
      clock.current = target;
      // drop review cards that are old or no longer true, and proposals that no longer make sense
      pending.current = pending.current.filter(p => {
        const b = s.byId.get(p.building), tr = s.trucks.find(x => x.id === p.truck);
        if (p.applied) return (now - p.wall) / 1000 < REVIEW_SECONDS && tr?.building === p.building;
        return b && !b.burned && b.needKnown > 0.5 && tr && tr.status !== "unavailable" && tr.building !== p.building; });
      syncFeed(); draw(s.done);
      if (followRef.current && map.current && now - lastCam > 2000) { lastCam = now; frameSim(map.current, s, 1500); }
      if (now - lastUi > 120 || s.done) { lastUi = now; refresh(); }
      if (s.done) { setPlaying(false); return; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed]); // eslint-disable-line react-hooks/exhaustive-deps

  // keyboard: A approve top proposal, R reject top, space play/pause
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      const top = pending.current[0];
      if (e.key === "a" && top) { approve(top); draw(); refresh(); }
      if (e.key === "r" && top) { reject(top); draw(); refresh(); }
      if (e.key === " ") { e.preventDefault(); setPlaying(p => !p); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // selection highlight + camera
  useEffect(() => {
    const m = map.current, s = sim.current;
    if (!m || !s || !selBld) return;
    const b = s.byId.get(selBld);
    if (!b) return;
    renderer.current?.select(s, b.id);
    m.easeTo({ center: [b.lng, b.lat], duration: 800 });
    return () => { renderer.current?.select(null, null); };
  }, [selBld]);
  useEffect(() => {
    const m = map.current, tr = sim.current?.trucks.find(x => x.id === selUnit);
    if (m && tr) m.easeTo({ center: [tr.lng, tr.lat], duration: 800 });
  }, [selUnit]);

  // ---------- render ----------
  const s = sim.current;
  const c = s?.counts;
  const t = s?.t ?? 0;
  const queue = s ? s.buildings.filter(b => !b.burned && b.needKnown > 0.5).sort((a, b) => s.priority(b) - s.priority(a)).slice(0, 40) : [];
  const assignedTo = (bid: string) => s?.trucks.filter(x => x.building === bid) ?? [];
  const pendingFor = (bid: string) => pending.current.filter(p => p.building === bid && !p.applied);
  const feedShown = [...feed.current].reverse().filter(f =>
    filter === "all" ? true : filter === "calls" ? f.k === "call" && !routine(f) : filter === "dispatcher" ? f.k === "disp" :
    (f.k === "call" && routine(f)) || (f.k === "log" && ["assign", "reassign", "unassign", "withdraw"].includes(f.kind))).slice(0, 300);
  const sb = selBld && s ? s.byId.get(selBld) : null;
  const statusLabel = (tr: Truck) => tr.status === "en_route" ? "ENRT" : tr.status === "on_scene" ? "ONSC" : tr.status === "idle" ? "AVAIL" : "OOS";

  return (
    <div className="cad">
      <style>{CSS + TRUCK_CSS}</style>

      {/* top bar */}
      <header>
        <div className="brand"><b>ROLL CALL</b> CAD</div>
        <div className="inc"><span className="pill red">INCIDENT</span> Sunset Fire what-if · Hollywood Hills · evacuation order 0:00</div>
        <div className="clock">
          <button className="ico" onClick={() => setPlaying(p => !p)} disabled={!ready || !!s?.done} title="Space">{playing ? "❚❚" : "▶"}</button>
          <span className="big">{fmtT(t)}</span><span className="dim">/ 3:00</span>
          {SPEEDS.map(sp => <button key={sp.x} className={`seg ${speed === sp.x ? "on" : ""}`} onClick={() => setSpeed(sp.x)}>{sp.label}</button>)}
          <button className="seg" onClick={start} disabled={!ready}>reset</button>
          <button className={`seg ${hills ? "on" : ""}`} title="Real hill heights. Prettier, but slower while playing."
            onClick={() => { const v = !hills; setHillsUi(v); if (map.current) setHills(map.current, v); }}>3D hills</button>
          <button className="seg" title="Keep all 8 trucks and the buildings in view (moving the map turns this off)."
            onClick={() => { followRef.current = true; if (map.current && sim.current) frameSim(map.current, sim.current, 800); }}>follow trucks</button>
        </div>
        <div className="mode">
          AI pairings:
          <button className={`seg ${modeUi === "auto" ? "on" : ""}`} onClick={() => { mode.current = "auto"; setModeUi("auto"); if (sim.current) sim.current.approvalRequired = false; }}
            title="The AI applies each pairing at once; you review it (OK / Undo / Edit)">AI applies, I review</button>
          <button className={`seg ${modeUi === "ask" ? "on" : ""}`} onClick={() => { mode.current = "ask"; setModeUi("ask"); if (sim.current) sim.current.approvalRequired = true; }}
            title="Nothing changes until you approve">I approve each</button>
        </div>
        {c && <div className="kpis">
          <div><b className="g">{n0(c.evacuated)}</b>evacuated</div>
          <div><b className="p">{n0(c.need)}</b>need help inside</div>
          <div><b className="r">{n0(c.trapped)}</b>trapped</div>
        </div>}
      </header>

      {/* left: unit status board */}
      <section className="units">
        <h2>Units <span className="dim">{s?.trucks.filter(x => x.status === "idle").length ?? 0} avail</span></h2>
        <table><thead><tr><th>Unit</th><th>Stat</th><th>Assignment</th><th>ETA</th></tr></thead><tbody>
          {s?.trucks.map(tr => {
            const b = tr.building ? s.byId.get(tr.building) : null;
            const pend = pending.current.find(p => p.truck === tr.id && !p.applied);
            return (
              <tr key={tr.id} className={selUnit === tr.id ? "sel" : ""} onClick={() => setSelUnit(tr.id)}>
                <td className="mono">E{tr.station}{s.locks.has(tr.id) && <span className="hold" title="Held by dispatcher">H</span>}</td>
                <td><span className={`st ${tr.status}`}>{statusLabel(tr)}</span></td>
                <td className="asg">{b ? b.label : tr.status === "unavailable" ? `back ${fmtT(tr.unavailable_until)}` : "—"}
                  {pend && <div className="prop">→ {s.byId.get(pend.building)?.label} <i>(proposed)</i></div>}</td>
                <td className="mono">{tr.status === "en_route" && tr.eta_min !== null ? Math.max(0, Math.round((tr.cum[tr.cum.length - 1] - tr.pos_m) / 500)) + "m" : ""}</td>
              </tr>);
          })}
        </tbody></table>
        {selUnit && s && (() => {
          const tr = s.trucks.find(x => x.id === selUnit)!;
          return (
            <div className="unitbox">
              <div><b>{tr.name}</b> · LAFD Station {tr.station} · {n0(tr.served)} people brought out</div>
              <div className="btns">
                {tr.status !== "unavailable"
                  ? <button onClick={() => run(`E${tr.station} out 20`)}>Out of service 20 min</button>
                  : <button onClick={() => run(`E${tr.station} back`)}>Back in service</button>}
                {s.locks.has(tr.id)
                  ? <button onClick={() => run(`release E${tr.station}`)}>Release to AI</button>
                  : <button onClick={() => run(`hold E${tr.station}`)}>Hold (AI won’t move)</button>}
              </div>
            </div>);
        })()}
        <div className="legend">
          <div><i className="sq" style={{ background: BUILDING_COLORS.occupied }} />people inside</div>
          <div><i className="sq" style={{ background: BUILDING_COLORS.empty }} />everyone out</div>
          <div><i className="sq" style={{ background: BUILDING_COLORS.burnedEmpty }} />burned, empty</div>
          <div><i className="sq" style={{ background: BUILDING_COLORS.burnedTrapped }} />burned, people in</div>
          <div><i style={{ background: COLORS.able }} />walking out (fast)</div>
          <div><i style={{ background: COLORS.need }} />helped out (slow)</div>
          <div><i className="ln" style={{ borderColor: "#fff7ed" }} />pairing</div>
          <div><i className="ln" style={{ borderColor: COLORS.proposal }} />proposed</div>
        </div>
      </section>

      {/* center: map */}
      <section className="mapwrap">
        <div ref={el} className="map" />
        {!ready && <div className="loading">Loading fire, roads, buildings…</div>}
        {sb && s && (
          <div className="bcard">
            <button className="x" onClick={() => setSelBld(null)}>×</button>
            <b>{sb.label}</b>{sb.costar && <span className="pill">CoStar · manager phone</span>}
            <div className="grid">
              <span>Fire arrives</span><b>{fmtT(sb.fire)} ({sb.fire > t ? `in ${mins(sb.fire - t)}` : "burned"})</b>
              <span>Inside</span><b>{n0(sb.able + sb.need)}</b>
              <span>Need help (known)</span><b>{n0(sb.needKnown)}{sb.need - sb.needKnown >= 0.5 ? " (+ unreported)" : ""}</b>
              <span>Evacuated</span><b>{n0(sb.evacuated)}</b>
              <span>Trapped</span><b>{n0(sb.trapped)}</b>
              <span>Unit</span><b>{assignedTo(sb.id).map(x => x.name).join(", ") || "—"}</b>
            </div>
            <div className="dim small">People estimate: units × 2.4 × 0.95; need help 10% (BUILDING_MODEL.md). A call to the manager replaces the estimate.</div>
          </div>)}
      </section>

      {/* right: proposals + live feed */}
      <section className="side">
        <h2>AI proposals <span className="count">{pending.current.length}</span>
          <span className="dim">{modeUi === "auto" ? `applied · review ${REVIEW_SECONDS}s` : "waiting for you"} · A ok · R {modeUi === "auto" ? "undo" : "reject"}</span></h2>
        <div className="props">
          {pending.current.length === 0 && <div className="dim small pad">No pairing changes waiting.</div>}
          {pending.current.slice(0, 6).map((p, i) => {
            const tr = s!.trucks.find(x => x.id === p.truck)!, b = s!.byId.get(p.building)!, pb = p.prev ? s!.byId.get(p.prev) : null;
            const age = (performance.now() - p.wall) / 1000;
            const others = s!.trucks.filter(x => x.id !== p.truck && x.status !== "unavailable");
            return (
              <div key={p.id} className={`pcard ${i === 0 ? "top" : ""} ${p.applied ? "applied" : ""}`} onClick={() => setSelBld(p.building)}>
                <div className="pt">{p.applied ? <span className="pill green">APPLIED</span> : <span className="pill blue">PROPOSED</span>}<span className="mono">E{tr.station}</span> {pb ? <><s>{pb.label}</s> → </> : "→ "}<b>{b.label}</b></div>
                <div className="why">{p.reason} Fire in {mins(b.fire - t)}. ETA {mins(p.eta_min)}.{pb ? ` Re-match: higher priority than ${pb.label}.` : ""}</div>
                {p.applied && <div className="timer"><div style={{ width: `${Math.max(0, 100 - (age / REVIEW_SECONDS) * 100)}%` }} /></div>}
                {editing === p.id ? (
                  <div className="btns">
                    <span className="dim small">Send instead:</span>
                    {others.map(o => <button key={o.id} onClick={() => { editTo(p, o.id); draw(); refresh(); }}>E{o.station}</button>)}
                    <button onClick={() => setEditing(null)}>cancel</button>
                  </div>
                ) : (
                  <div className="btns">
                    <button className="ok" onClick={() => { approve(p); draw(); refresh(); }}>{p.applied ? "OK" : "Approve"}</button>
                    <button className="no" onClick={() => { reject(p); draw(); refresh(); }}>{p.applied ? "Undo" : "Reject"}</button>
                    <button onClick={() => setEditing(p.id)}>Edit unit…</button>
                  </div>)}
              </div>);
          })}
          {pending.current.length > 6 && <div className="dim small pad">+{pending.current.length - 6} more</div>}
        </div>
        <h2>Live feed
          {(["all", "calls", "pairings", "dispatcher"] as const).map(f => <button key={f} className={`seg ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>{f}</button>)}
        </h2>
        <div className="feed">
          {feedShown.map((f, i) => f.k === "call" ? (
            <details key={i} className={`call ${routine(f) ? "" : "inbound"}`} open={i < 2 || !routine(f)}>
              <summary><span className="tm">{fmtT(f.t)}</span><span className="pill blue">CALL</span> {f.title}</summary>
              {f.lines.map((l, j) => <div key={j} className={`tl ${l.speaker.replace(" ", "")}`}><b>{l.speaker}{l.to ? ` → ${l.to}` : ""}:</b> {l.text}</div>)}
              {f.title.startsWith("Roll Call →") || f.title.startsWith("Callback") ? null : <div className="dim small">Scripted demo words; the effect on the simulation is real.</div>}
            </details>
          ) : f.k === "disp" ? (
            <div key={i} className="ev disp"><span className="tm">{fmtT(f.t)}</span><span className="pill amber">YOU</span> {f.text}</div>
          ) : (
            <div key={i} className={`ev ${f.kind}`} onClick={() => f.building && setSelBld(f.building)}><span className="tm">{fmtT(f.t)}</span>{f.text}</div>
          ))}
        </div>
      </section>

      {/* bottom: priority queue + command line */}
      <section className="queue">
        <h2>Priority queue <span className="dim">dynamic risk = people who need help × fire threat (rises as the fire comes near) · {queue.length >= 40 ? "top 40" : queue.length} buildings</span></h2>
        <div className="qscroll">
          <table><thead><tr><th>#</th><th>Building</th><th>Risk now</th><th>Static</th><th>Threat</th><th>Need help</th><th>Inside</th><th>Fire in</th><th>Unit</th><th>Source</th></tr></thead><tbody>
            {queue.map((b, i) => {
              const us = assignedTo(b.id), pp = pendingFor(b.id);
              const left = b.fire - t, r = s!.riskOf(b);
              return (
                <tr key={b.id} className={selBld === b.id ? "sel" : ""} onClick={() => setSelBld(b.id)}>
                  <td className="mono dim">{i + 1}</td>
                  <td>{b.label}</td>
                  <td className="mono"><b>{r.risk.toFixed(1)}</b></td>
                  <td className="mono dim" title="Rasul's static risk_score (Supabase), no fire">{b.riskStatic != null ? b.riskStatic.toFixed(1) : "–"}</td>
                  <td className="mono" title="1 = fire far; rises as the fire comes near">×{r.threat.toFixed(1)}</td>
                  <td className="mono p" title={`ranking uses ${r.people.toFixed(1)} (${r.source})`}>{n0(b.needKnown)}</td>
                  <td className="mono">{n0(b.able + b.need)}</td>
                  <td className={`mono ${left < 15 ? "r" : left < 40 ? "a" : ""}`}>{mins(left)}</td>
                  <td>{us.map(x => <span key={x.id} className={`st ${x.status}`}>E{x.station}</span>)}{pp.map(p => <span key={p.id} className="st prop">E{p.truck.slice(1)}?</span>)}{!us.length && !pp.length && <span className="dim">unassigned</span>}</td>
                  <td className="dim small">{r.source}</td>
                </tr>);
            })}
          </tbody></table>
        </div>
      </section>
      <section className="cmd">
        <h2>Dispatcher input</h2>
        <form onSubmit={e => { e.preventDefault(); run(cmd); draw(); }}>
          <input value={cmd} onChange={e => setCmd(e.target.value)} placeholder='e.g. "E27 out 20 flat tire", "hold E35", "send E41 to Lanewood", "stuck 2 at Franklin Plaza"' />
        </form>
        {cmdMsg && <div className={`msg ${cmdMsg.ok ? "ok" : "bad"}`}>{cmdMsg.text}</div>}
        <div className="btns small">
          {["E27 out 20", "hold E35", "send E41 to Lanewood", "stuck 2 at Franklin Plaza"].map(x => <button key={x} onClick={() => { run(x); draw(); }}>{x}</button>)}
        </div>
        <div className="stats dim small">
          AI applied {stats.current.auto} · you approved/OK {stats.current.approved} · rejected/undone {stats.current.rejected} · edited {stats.current.edited}
          <br />Simulation with labeled assumptions (see /sim); calls are scripted. Not a count of real lives.
        </div>
      </section>
    </div>
  );
}

const CSS = `
.cad{--bg:#0a101c;--panel:#0f1828;--line:#1e2a3f;--text:#d6deeb;--dim:#7d8aa3;--amber:#f59e0b;--blue:#38bdf8;--green:#22c55e;--red:#ef4444;--purple:#c084fc;
  position:fixed;inset:0;display:grid;grid-template-columns:300px 1fr 400px;grid-template-rows:46px 1fr 220px;
  grid-template-areas:"top top top" "units map side" "queue queue cmd";background:var(--bg);color:var(--text);
  font:12.5px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.cad header{grid-area:top;display:flex;align-items:center;gap:18px;padding:0 12px;border-bottom:1px solid var(--line);background:#0c1424}
.brand{font-size:13px;letter-spacing:.08em;color:var(--dim)}.brand b{color:var(--amber)}
.inc{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.clock,.mode{display:flex;align-items:center;gap:6px;white-space:nowrap}
.mode{color:var(--dim)}
.big{font:700 20px/1 ui-monospace,Menlo,monospace;color:#fff}
.kpis{display:flex;gap:14px}.kpis div{color:var(--dim);font-size:11px;text-align:right}
.kpis b{display:block;font:700 16px/1.1 ui-monospace,Menlo,monospace}
.g{color:var(--green)}.p{color:var(--purple)}.r{color:var(--red)}.a{color:var(--amber)}
.dim{color:var(--dim);font-weight:400}.small{font-size:11px}.pad{padding:8px}
.mono{font-family:ui-monospace,Menlo,monospace}
.cad h2{font-size:11px;letter-spacing:.06em;text-transform:uppercase;margin:0;padding:8px 10px;display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--line);color:#aab6cc}
.cad section{background:var(--panel);min-height:0;display:flex;flex-direction:column;overflow:hidden}
.units{grid-area:units;border-right:1px solid var(--line)}
.side{grid-area:side;border-left:1px solid var(--line)}
.queue{grid-area:queue;border-top:1px solid var(--line)}
.cmd{grid-area:cmd;border-top:1px solid var(--line);border-left:1px solid var(--line)}
.mapwrap{grid-area:map;position:relative}
.map{position:absolute;inset:0}
.loading{position:absolute;top:45%;left:50%;transform:translateX(-50%);background:#000a;padding:10px 14px;border-radius:6px}
.cad table{width:100%;border-collapse:collapse}
.cad th{font-size:10px;text-transform:uppercase;color:var(--dim);text-align:left;padding:4px 6px;font-weight:600;position:sticky;top:0;background:var(--panel)}
.cad td{text-align:left;padding:5px 6px;border-top:1px solid var(--line);vertical-align:top}
.cad tbody tr{cursor:pointer}.cad tbody tr:hover{background:#15213a}.cad tr.sel{background:#1b2b4a}
.st{display:inline-block;font:700 10px/1 ui-monospace,Menlo,monospace;padding:3px 5px;border-radius:3px;margin-right:3px;background:#334155;color:#e2e8f0}
.st.en_route{background:#9a3412;color:#ffedd5}.st.on_scene{background:#166534;color:#dcfce7}.st.idle{background:#334155}.st.unavailable{background:#3f3f46;color:#a1a1aa;text-decoration:line-through}
.st.prop{background:transparent;border:1px dashed var(--blue);color:var(--blue)}
.asg{max-width:130px}
.prop{color:var(--blue);font-size:11px}.prop i{color:var(--dim)}
.hold{margin-left:3px;font-size:9px;background:var(--blue);color:#000;border-radius:2px;padding:0 2px}
.unitbox{margin:8px;padding:8px;border:1px solid var(--line);border-radius:6px;background:#0c1424}
.btns{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;align-items:center}
.cad button{font:inherit;font-size:11.5px;color:var(--text);background:#1a263b;border:1px solid #2a3a57;border-radius:4px;padding:3px 8px;cursor:pointer}
.cad button:hover{background:#22314d}.cad button:disabled{opacity:.4}
.cad button.ok{background:#14532d;border-color:#166534}.cad button.no{background:#4c1d1d;border-color:#7f1d1d}
.seg.on{background:var(--text)!important;color:#0a101c!important}
.ico{width:28px;height:28px;border-radius:50%!important;padding:0!important}
.legend{margin-top:auto;padding:8px 10px;display:grid;grid-template-columns:1fr 1fr;gap:3px;color:var(--dim);font-size:11px;border-top:1px solid var(--line)}
.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:-1px}
.legend i.sq{border-radius:2px}
.legend i.ln{width:14px;height:0;border-radius:0;border-top:2px dashed;vertical-align:3px}
.count{background:var(--blue);color:#000;border-radius:8px;padding:0 6px;font-weight:700}
.props{max-height:46%;overflow:auto;padding:6px;display:flex;flex-direction:column;gap:6px;border-bottom:1px solid var(--line)}
.pcard{border:1px solid #1f3b57;border-left:3px solid var(--blue);border-radius:5px;padding:6px 8px;background:#0c1626}
.pcard.top{box-shadow:0 0 0 1px var(--blue) inset}
.pcard.applied{border-color:#14532d;border-left-color:var(--green)}.pcard.applied.top{box-shadow:0 0 0 1px var(--green) inset}
.pill.green{background:#14532d;color:#bbf7d0}
.pcard s{color:var(--dim)}.why{color:#aab6cc;font-size:11.5px;margin-top:2px}
.timer{height:2px;background:#1e2a3f;margin-top:5px}.timer div{height:100%;background:var(--green)}
.feed{flex:1;overflow:auto;padding:4px 8px}
.ev{padding:3px 0;border-bottom:1px solid #ffffff08;color:#b9c4d8;cursor:pointer}
.ev.reassign{color:#fde68a}.ev.withdraw,.ev.unassign{color:#fca5a5}.ev.arrive{color:#86efac}.ev.event{color:#c4b5fd}
.tm{font-family:ui-monospace,Menlo,monospace;color:var(--dim);margin-right:6px;font-size:11px}
.pill{display:inline-block;font-size:9.5px;font-weight:700;letter-spacing:.04em;padding:1px 5px;border-radius:3px;background:#334155;margin:0 4px}
.pill.red{background:#7f1d1d;color:#fecaca}.pill.blue{background:#0c4a6e;color:#bae6fd}.pill.amber{background:#78350f;color:#fde68a}
.call{border:1px solid var(--line);border-radius:5px;margin:4px 0;padding:4px 6px;background:#0c1424}
.call summary{cursor:pointer}
.call.inbound{border-color:#5b21b6;background:#140f2a}
.tl{margin:4px 0 0 8px;padding-left:6px;border-left:2px solid var(--amber)}
.tl.Driver{border-left-color:#60a5fa}.tl.Supervisor{border-left-color:var(--purple)}.tl.System{border-left-color:#71717a}
.ev.disp{color:#fde68a}
.qscroll{overflow:auto;flex:1}
.cmd form{padding:8px 10px 0}
.cmd input{width:100%;box-sizing:border-box;background:#060b14;border:1px solid #2a3a57;border-radius:4px;color:#fff;padding:8px;font:13px ui-monospace,Menlo,monospace}
.cmd .btns{padding:0 10px}.msg{padding:4px 10px;font-size:11.5px}.msg.ok{color:#86efac}.msg.bad{color:#fca5a5}
.stats{padding:8px 10px;margin-top:auto}
.bcard{position:absolute;left:10px;top:10px;width:290px;background:#0c1424ee;border:1px solid var(--line);border-radius:6px;padding:10px}
.bcard .grid{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:6px 0;font-size:12px}.bcard .grid span{color:var(--dim)}
.bcard .x{position:absolute;right:6px;top:4px;border:0!important;background:none!important;font-size:16px}
.maplibregl-ctrl-attrib{font-size:10px}
`;
