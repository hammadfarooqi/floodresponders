"use client";
// "See interior layout": the floor plan of one scanned apartment, with a green search route from the entrance to
// each bedroom. The scans are Matterport leasing tours of sample apartments, so this is a typical apartment of the
// building, not a known unit. Route logic: lib/interior/route.ts. Data: data/pipeline/interior_layouts.py.
import { useEffect, useMemo, useState } from "react";
import { TARGET_LABEL, pickEntry, searchRoute, type Layout } from "../../lib/interior/route";
import { loadLayouts, type ScanSummary } from "./interiorData";

const GREEN = "#22c55e";
const WHY = {
  "entrance room": "a room that the scan labels \"Entrance\"",
  "outside door": "a door in an outside wall (best guess)",
  "first position": "the first position of the scan (no outside door found)",
  picked: "the position you picked",
};
const m1 = (m: number) => `${m.toFixed(1)} m`;

export default function InteriorPanel({ title, scans, onClose }: { title: string; scans: ScanSummary[]; onClose?: () => void }) {
  const [layouts, setLayouts] = useState<Record<string, Layout> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanId, setScanId] = useState(scans[0]?.id);
  const [floor, setFloor] = useState<number | null>(null);   // null = the floor of the start
  const [picked, setPicked] = useState<number | null>(null);
  const [tour, setTour] = useState(false);

  useEffect(() => { loadLayouts().then(setLayouts).catch(e => setError(String(e))); }, []);
  useEffect(() => { setScanId(scans[0]?.id); }, [scans]);
  const layout = scanId && layouts ? layouts[scanId] : undefined;
  const plan = useMemo(() => {
    if (!layout) return null;
    const guess = pickEntry(layout);
    const entry = picked !== null && picked < layout.positions.length ? picked : guess.position;
    return { route: searchRoute(layout, entry), why: picked !== null ? WHY.picked : WHY[guess.why] };
  }, [layout, picked]);
  const choose = (id: string) => { setScanId(id); setPicked(null); setFloor(null); setTour(false); };
  const shown = layout && plan ? Math.min(floor ?? layout.positions[plan.route.entry].floor, layout.floors.length - 1) : 0;

  return (
    <div className="il" role="dialog" aria-label="Interior layout">
      <style>{CSS}</style>
      <header>
        <div><b>{title}</b><span className="il-dim"> · interior layout · sample apartment from the leasing scan</span></div>
        <div className="il-row">
          {layout && <button className={tour ? "" : "on"} onClick={() => setTour(false)}>Floor plan</button>}
          {layout && <button className={tour ? "on" : ""} onClick={() => setTour(true)}>3D tour</button>}
          {onClose && <button onClick={onClose} aria-label="Close">Close ×</button>}
        </div>
      </header>
      <div className="il-body">
        <aside>
          <h3>Scanned apartments <span className="il-dim">{scans.length}</span></h3>
          <div className="il-scans">
            {scans.map(s => (
              <button key={s.id} className={s.id === scanId ? "on" : ""} onClick={() => choose(s.id)}>
                <b>{s.name || "Apartment"}</b>
                <span className="il-dim">{s.bedrooms} labelled bedroom{s.bedrooms === 1 ? "" : "s"}{s.floors > 1 ? ` · ${s.floors} floors` : ""}</span>
              </button>))}
          </div>
          {plan && layout && <>
            <h3>Search route <span className="il-dim">{m1(plan.route.meters)} in total</span></h3>
            <ol className="il-stops">
              <li><i className="il-in">IN</i><span>Start: {plan.why}</span></li>
              {plan.route.stops.map((s, i) => (
                <li key={i} onClick={() => { setFloor(s.floor); setTour(false); }}>
                  <i>{i + 1}</i><span><b>{s.label}</b>{layout.floors.length > 1 ? ` · ${layout.floors[s.floor].label}` : ""}
                    <span className="il-dim"> · {m1(s.meters)} from {i === 0 ? "the start" : `stop ${i}`}</span></span>
                </li>))}
            </ol>
            {plan.route.unreachable.length > 0 &&
              <div className="il-warn">{plan.route.unreachable.length} bedroom{plan.route.unreachable.length === 1 ? " has" : "s have"} no walkable link in the scan. Check {plan.route.unreachable.length === 1 ? "it" : "them"} by hand.</div>}
            <p className="il-dim">Wrong start? Click any dot on the plan to start there.</p>
          </>}
          <p className="il-note">Other apartments of this type have this plan, possibly mirrored. The scan does not cover the building's
            hallway or stairs. The route visits the rooms that the scan labels "Bedroom"; a bedroom with no label is not on it.
            The line follows the spots where the scan camera stood.</p>
        </aside>
        <main>
          {error && <div className="il-msg">Could not load the layouts: {error}</div>}
          {!error && !layouts && <div className="il-msg">Loading layouts…</div>}
          {layouts && !layout && <div className="il-msg">No layout for this scan. Run data/pipeline/interior_layouts.py again.</div>}
          {layout && plan && (tour
            ? <iframe src={`${layout.url}&play=1&qs=1&brand=0`} title="Matterport 3D tour" allow="fullscreen; xr-spatial-tracking" allowFullScreen />
            : <>
              {layout.floors.length > 1 && <div className="il-floors">{layout.floors.map((f, i) =>
                <button key={i} className={i === shown ? "on" : ""} onClick={() => setFloor(i)}>{f.label}</button>)}</div>}
              <Plan layout={layout} floor={shown} route={plan.route} onPick={setPicked} />
              <div className="il-legend">
                <span><i style={{ background: GREEN }} />search route</span>
                <span><i style={{ background: "#16a34a55", outline: `1px solid ${GREEN}` }} />bedroom</span>
                <span><i style={{ background: "#fbbf24" }} />door</span>
                <span><i style={{ background: "#38bdf8" }} />window</span>
                <span><i style={{ background: "#64748b", borderRadius: "50%" }} />scan position</span>
              </div>
            </>)}
        </main>
      </div>
    </div>
  );
}

type Route = ReturnType<typeof searchRoute>;

/** One floor as SVG. Units are meters; the y axis is flipped, because the scan has y up and SVG has y down. */
function Plan({ layout, floor, route, onPick }: { layout: Layout; floor: number; route: Route; onPick: (position: number) => void }) {
  const f = layout.floors[floor];
  const here = layout.positions.map((p, i) => ({ ...p, i })).filter(p => p.floor === floor);
  const xs = [...f.walls.flatMap(w => [w[0], w[2]]), ...here.map(p => p.x)];
  const ys = [...f.walls.flatMap(w => [w[1], w[3]]), ...here.map(p => p.y)];
  if (!xs.length) return <div className="il-msg">This floor has no walls or positions in the scan.</div>;
  const pad = 0.8, x0 = Math.min(...xs) - pad, y1 = Math.max(...ys) + pad;
  const w = Math.max(...xs) + pad - x0, h = y1 - (Math.min(...ys) - pad);
  const X = (x: number) => x - x0, Y = (y: number) => y1 - y;
  const pts = (ids: number[]) => ids.map(i => layout.positions[i]).filter(p => p.floor === floor).map(p => `${X(p.x)},${Y(p.y)}`).join(" ");
  const u = Math.max(w, h) / 60;   // one drawing unit: keeps lines and text readable for small and large apartments
  const entry = layout.positions[route.entry];
  // Where the route leaves this floor: the last position on it, and the floor it goes to.
  const exits = route.stops.flatMap(s => s.path.slice(0, -1).map((id, k) => [layout.positions[id], layout.positions[s.path[k + 1]]] as const))
    .filter(([a, b]) => a.floor === floor && b.floor !== floor);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Floor plan, ${f.label}`}>
      {f.rooms.map((r, i) => r.polygon.length > 0 &&
        <polygon key={i} points={r.polygon.map(([x, y]) => `${X(x)},${Y(y)}`).join(" ")}
          fill={r.labels.includes(TARGET_LABEL) ? "#16a34a40" : "#172033"} />)}
      {f.walls.map((s, i) => <line key={i} x1={X(s[0])} y1={Y(s[1])} x2={X(s[2])} y2={Y(s[3])} stroke="#cbd5e1" strokeWidth={u * 0.45} strokeLinecap="round" />)}
      {f.openings.map((o, i) => <g key={i}>
        <line x1={X(o.a[0])} y1={Y(o.a[1])} x2={X(o.b[0])} y2={Y(o.b[1])} stroke="#0a101c" strokeWidth={u * 0.6} />
        <line x1={X(o.a[0])} y1={Y(o.a[1])} x2={X(o.b[0])} y2={Y(o.b[1])} stroke={o.type === "window" ? "#38bdf8" : "#fbbf24"} strokeWidth={u * 0.28} />
      </g>)}
      {f.rooms.map((r, i) => r.center && r.labels.length > 0 &&
        <text key={i} x={X(r.center[0])} y={Y(r.center[1]) - u * 1.1} fontSize={u * 1.25} textAnchor="middle"
          fill={r.labels.includes(TARGET_LABEL) ? "#86efac" : "#94a3b8"} fontWeight={r.labels.includes(TARGET_LABEL) ? 700 : 400}>{r.labels.join(" / ")}</text>)}
      {route.stops.map((s, i) => <polyline key={i} className="il-route" points={pts(s.path)} fill="none" stroke={GREEN}
        strokeWidth={u * 0.5} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={`${u * 1.2} ${u * 0.9}`}
        style={{ "--il-dash": -u * 2.1 } as React.CSSProperties} />)}
      {here.map(p => <g key={p.i} className="il-pos" onClick={() => onPick(p.i)}>
        <circle cx={X(p.x)} cy={Y(p.y)} r={u * 1.3} fill="transparent" />
        <circle cx={X(p.x)} cy={Y(p.y)} r={u * 0.3} fill="#64748b" />
        <title>Start the route here</title>
      </g>)}
      {exits.map(([a, b], i) => <g key={i} pointerEvents="none">
        <circle cx={X(a.x)} cy={Y(a.y)} r={u * 0.7} fill="#0a101c" stroke={GREEN} strokeWidth={u * 0.22} />
        <text x={X(a.x) + u * 1.1} y={Y(a.y) + u * 0.4} fontSize={u * 1.15} fill="#86efac" fontWeight={700}>to {layout.floors[b.floor].label}</text>
      </g>)}
      {entry.floor === floor && <g pointerEvents="none">
        <circle cx={X(entry.x)} cy={Y(entry.y)} r={u * 1.15} fill="#0a101c" stroke="#fff" strokeWidth={u * 0.22} />
        <text x={X(entry.x)} y={Y(entry.y) + u * 0.4} fontSize={u * 1.05} textAnchor="middle" fill="#fff" fontWeight={700}>IN</text>
      </g>}
      {route.stops.map((s, i) => { const p = layout.positions[s.position]; return p.floor === floor &&
        <g key={i} pointerEvents="none">
          <circle cx={X(p.x)} cy={Y(p.y)} r={u * 1.15} fill={GREEN} stroke="#052e16" strokeWidth={u * 0.15} />
          <text x={X(p.x)} y={Y(p.y) + u * 0.45} fontSize={u * 1.3} textAnchor="middle" fill="#052e16" fontWeight={800}>{i + 1}</text>
        </g>; })}
    </svg>
  );
}

const CSS = `
.il{position:fixed;inset:3vh 3vw;z-index:50;display:flex;flex-direction:column;background:#0a101c;color:#e2e8f0;border:1px solid #334155;
  border-radius:8px;box-shadow:0 20px 60px #000c;font:13px/1.45 system-ui,sans-serif;overflow:hidden}
.il header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 12px;border-bottom:1px solid #1e293b;font-size:14px}
.il-row{display:flex;gap:6px}
.il button{font:inherit;color:#e2e8f0;background:#172033;border:1px solid #334155;border-radius:5px;padding:4px 10px;cursor:pointer}
.il button:hover{background:#22314d}
.il button.on{background:#e2e8f0;color:#0a101c;border-color:#e2e8f0}
.il-dim{color:#94a3b8;font-weight:400}
.il-body{flex:1;display:flex;min-height:0}
.il aside{width:300px;flex:none;padding:10px 12px;border-right:1px solid #1e293b;overflow:auto}
.il h3{margin:10px 0 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#cbd5e1}
.il h3:first-child{margin-top:0}
.il-scans{display:flex;flex-direction:column;gap:4px;max-height:34vh;overflow:auto}
.il-scans button{display:flex;flex-direction:column;align-items:flex-start;text-align:left;padding:6px 8px}
.il-scans button.on .il-dim{color:#334155}
.il-stops{list-style:none;margin:0 0 8px;padding:0;display:flex;flex-direction:column;gap:6px}
.il-stops li{display:flex;gap:8px;align-items:flex-start;cursor:default}
.il-stops i{flex:none;width:22px;height:22px;border-radius:50%;background:${GREEN};color:#052e16;font-style:normal;font-weight:800;
  display:grid;place-items:center;font-size:12px}
.il-stops i.il-in{background:#0a101c;color:#fff;border:2px solid #fff;font-size:9px}
.il-warn{background:#78350f;color:#fde68a;border-radius:5px;padding:6px 8px;margin-bottom:8px}
.il-note{color:#94a3b8;font-size:12px;border-top:1px solid #1e293b;padding-top:8px;margin-top:10px}
.il main{flex:1;min-width:0;position:relative;display:flex;flex-direction:column;padding:10px}
.il main svg{flex:1;min-height:0;width:100%}
.il main iframe{flex:1;width:100%;border:0;border-radius:6px;background:#000}
.il-floors{display:flex;gap:6px;margin-bottom:6px}
.il-legend{display:flex;flex-wrap:wrap;gap:4px 16px;color:#94a3b8;font-size:12px;padding-top:6px}
.il-legend i{display:inline-block;width:14px;height:6px;margin-right:6px;vertical-align:1px}
.il-msg{margin:auto;color:#94a3b8}
.il-pos{cursor:pointer}.il-pos:hover circle:last-of-type{fill:#fff}
.il-route{animation:il-march 1.2s linear infinite}
@keyframes il-march{to{stroke-dashoffset:var(--il-dash)}}
@media (prefers-reduced-motion:reduce){.il-route{animation:none}}
@media (max-width:800px){.il-body{flex-direction:column}.il aside{width:auto;border-right:0;border-bottom:1px solid #1e293b;max-height:40%}}
`;
