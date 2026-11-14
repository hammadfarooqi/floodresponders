"use client";
import L from "leaflet";
import { useCallback, useEffect, useRef, useState } from "react";

type LegendItem = { label: string; color: string; shape?: string; ring?: string };
type Spec = {
  id: string; title: string; group: string; file: string; count: number; version: number;
  pane: "regions" | "features"; defaultOn: boolean; kind?: "points";
  style?: L.PathOptions & { fill?: boolean };
  colorBy?: { field: string; colors: Record<string, string> };
  strokeBy?: { field: string; present: { color: string; weight: number } };
  radiusBy?: { field: string; min: number; max: number; sqrtDiv: number; base: number };
  ringWhen?: { field: string; value: unknown; color: string; weight: number };
  labelField?: string; labelFilter?: { field: string; min: number };
  legend?: LegendItem[]; popup?: string[];
};
type Manifest = { updated?: string; layers: Spec[]; panels: { title: string; columns: string[]; rows: (string | number)[][] }[]; error?: string };
type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, unknown>>;

const STORE = "explore.enabled.v1";
const loadEnabled = (): Record<string, boolean> => {
  try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch { return {}; }
};
const saveEnabled = (v: Record<string, boolean>) => { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch {} };

const fmt = (v: unknown) => v === null || v === undefined || v === "" ? "—" : typeof v === "boolean" ? (v ? "yes" : "no")
  : typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1)) : String(v);

function popupHtml(spec: Spec, p: Record<string, unknown>) {
  const keys = spec.popup ?? Object.keys(p);
  const rows = keys.filter(k => p[k] !== undefined && p[k] !== null && p[k] !== "")
    .map(k => `<tr><td class="k">${k.replace(/_/g, " ")}</td><td>${fmt(p[k])}</td></tr>`).join("");
  return `<div class="pop"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">${spec.title}</div><table>${rows}</table></div>`;
}

function buildLayer(spec: Spec, data: GeoJSON.FeatureCollection, renderers: Record<string, L.Renderer>) {
  const base = spec.style ?? {};
  const fillFor = (p: Record<string, unknown>) =>
    spec.colorBy ? spec.colorBy.colors[String(p[spec.colorBy.field])] ?? base.fillColor ?? "#999" : base.fillColor ?? base.color;
  const styleFor = (f?: Feature): L.PathOptions => {
    const p = (f?.properties ?? {}) as Record<string, unknown>;
    const s: L.PathOptions = { ...base, fillColor: fillFor(p), pane: spec.pane, renderer: renderers[spec.pane] };
    if (spec.strokeBy && p[spec.strokeBy.field]) Object.assign(s, spec.strokeBy.present);
    if (spec.ringWhen && p[spec.ringWhen.field] === spec.ringWhen.value) Object.assign(s, { color: spec.ringWhen.color, weight: spec.ringWhen.weight });
    return s;
  };
  const group = L.featureGroup();
  const gj = L.geoJSON(data, {
    pane: spec.pane,
    interactive: spec.pane === "features" || !!spec.popup,
    style: f => styleFor(f as Feature),
    pointToLayer: (f, latlng) => {
      const p = (f.properties ?? {}) as Record<string, unknown>;
      let r = 4;
      if (spec.radiusBy) {
        const v = Number(p[spec.radiusBy.field]) || 0;
        r = v ? Math.max(spec.radiusBy.min, Math.min(spec.radiusBy.max, spec.radiusBy.base + Math.sqrt(v) / spec.radiusBy.sqrtDiv)) : spec.radiusBy.min;
      }
      return L.circleMarker(latlng, { ...styleFor(f as Feature), radius: r });
    },
    onEachFeature: (f, layer) => {
      if (spec.pane === "features" || spec.popup) layer.bindPopup(() => popupHtml(spec, (f.properties ?? {}) as Record<string, unknown>), { maxWidth: 360 });
      const name = (f.properties as Record<string, unknown>)?.name;
      if (spec.pane === "features" && name) layer.bindTooltip(String(name), { direction: "top" });
    },
  });
  group.addLayer(gj);
  if (spec.labelField) {
    for (const f of data.features as Feature[]) {
      const p = f.properties ?? {};
      if (spec.labelFilter && Number(p[spec.labelFilter.field]) < spec.labelFilter.min) continue;
      const c = L.geoJSON(f).getBounds().getCenter();
      group.addLayer(L.tooltip({ permanent: true, direction: "center", className: "region-label", interactive: false, pane: "labels" })
        .setLatLng(c).setContent(String(p[spec.labelField] ?? "")));
    }
  }
  return group;
}

export default function MapApp() {
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const renderers = useRef<Record<string, L.Renderer>>({});
  const live = useRef<Record<string, { version: number; layer: L.FeatureGroup }>>({});
  const [manifest, setManifest] = useState<Manifest>({ layers: [], panels: [] });
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [flash, setFlash] = useState<Record<string, number>>({});
  const fitted = useRef(false);

  // map setup
  useEffect(() => {
    if (!mapEl.current || map.current) return;
    const m = L.map(mapEl.current, { preferCanvas: true }).setView([34.06, -118.3], 11);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors", maxNativeZoom: 16, maxZoom: 19 }).addTo(m);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
      { maxNativeZoom: 16, maxZoom: 19 }).addTo(m);
    m.createPane("regions").style.zIndex = "350";
    m.createPane("features").style.zIndex = "420";
    m.createPane("labels").style.zIndex = "440";
    m.getPane("labels")!.style.pointerEvents = "none";
    renderers.current = { regions: L.svg({ pane: "regions" }), features: L.canvas({ pane: "features" }) };
    map.current = m;
  }, []);

  const refreshManifest = useCallback(async () => {
    const mf: Manifest = await fetch("/api/manifest", { cache: "no-store" }).then(r => r.json());
    setManifest(mf);
    setEnabled(prev => {
      const saved = { ...loadEnabled(), ...prev };
      const next: Record<string, boolean> = {};
      for (const l of mf.layers) next[l.id] = saved[l.id] ?? l.defaultOn;
      return next;
    });
    return mf;
  }, []);

  // live updates
  useEffect(() => {
    refreshManifest();
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      es = new EventSource("/api/events");
      es.onopen = () => setConnected(true);
      es.onerror = () => { setConnected(false); es?.close(); retry = setTimeout(connect, 2000); };
      es.onmessage = async ev => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "change") {
          const mf = await refreshManifest();
          const changed = mf.layers.filter(l => live.current[l.id] && live.current[l.id].version !== l.version);
          const names = (changed.length ? changed.map(l => l.title) : msg.files).join(", ");
          setToast(`Updated: ${names}`);
          setFlash(Object.fromEntries(changed.map(l => [l.id, Date.now()])));
          setTimeout(() => setToast(null), 4000);
        }
      };
    };
    connect();
    return () => { es?.close(); clearTimeout(retry); };
  }, [refreshManifest]);

  // sync map layers with manifest + toggles (loads new versions as they arrive)
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const byId = Object.fromEntries(manifest.layers.map(l => [l.id, l]));
    for (const [id, cur] of Object.entries(live.current)) {
      if (!byId[id] || !enabled[id] || byId[id].version !== cur.version) { m.removeLayer(cur.layer); delete live.current[id]; }
    }
    // draw order: manifest order (regions first in the file, then buildings)
    manifest.layers.forEach(async spec => {
      if (!enabled[spec.id] || live.current[spec.id]) return;
      live.current[spec.id] = { version: spec.version, layer: L.featureGroup() };
      const data = await fetch(`/api/layer/${spec.id}?v=${spec.version}`, { cache: "no-store" }).then(r => r.json());
      if (live.current[spec.id]?.version !== spec.version) return;
      const layer = buildLayer(spec, data, renderers.current);
      live.current[spec.id] = { version: spec.version, layer };
      layer.addTo(m);
      if (!fitted.current && spec.id === "costar_la") { fitted.current = true; m.fitBounds(layer.getBounds(), { padding: [20, 20] }); }
    });
  }, [manifest, enabled]);

  const toggle = (id: string) => setEnabled(e => { const n = { ...e, [id]: !e[id] }; saveEnabled(n); return n; });
  const zoomTo = (id: string) => { const l = live.current[id]?.layer; if (l && map.current) map.current.fitBounds(l.getBounds(), { padding: [20, 20] }); };
  const groups = [...new Set(manifest.layers.map(l => l.group))];

  return (
    <div className="app">
      <aside className="side">
        <h1>Roll Call data explorer</h1>
        <p className="sub">Live view of <code>data/processed/layers</code>. New or changed layers appear here automatically.</p>
        <div className="status">
          <span className="dot" style={{ background: connected ? "var(--live)" : "var(--stale)" }} />
          {connected ? "Live" : "Reconnecting…"} · data updated {manifest.updated?.replace("T", " ") ?? "—"}
        </div>
        {manifest.error && <p className="sub" style={{ color: "var(--stale)" }}>{manifest.error}</p>}
        {groups.map(g => (
          <div key={g}>
            <h2>{g}</h2>
            {manifest.layers.filter(l => l.group === g).map(l => (
              <div key={l.id} className={`layer ${flash[l.id] ? "flash" : ""}`}>
                <div className="layer-head" onClick={() => toggle(l.id)}>
                  <input type="checkbox" checked={!!enabled[l.id]} readOnly />
                  <span>{l.title}</span>
                  <span className="count">{l.count.toLocaleString()}</span>
                  {enabled[l.id] && <button onClick={e => { e.stopPropagation(); zoomTo(l.id); }}>zoom</button>}
                </div>
                {enabled[l.id] && l.legend && (
                  <div className="legend">
                    {l.legend.map(it => (
                      <div key={it.label}>
                        <span className={`sw ${it.shape === "area" ? "area" : ""}`}
                          style={{ background: it.color, border: it.ring ? `3px solid ${it.ring}` : undefined }} />
                        {it.label}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        {manifest.panels.map(p => (
          <div key={p.title}>
            <h2>{p.title}</h2>
            <table>
              <thead><tr>{p.columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{p.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{typeof c === "number" ? c.toLocaleString() : c}</td>)}</tr>)}</tbody>
            </table>
          </div>
        ))}
        <p className="note">Sponsor data, local use only. Branch hammad_1. Add a layer: write it in data/pipeline/export_layers.py and run it.</p>
      </aside>
      <div ref={mapEl} className="map" />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
