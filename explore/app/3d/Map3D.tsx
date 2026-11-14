"use client";
import maplibregl from "maplibre-gl";
import { BASES, VIEWS, style } from "./mapStyle";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";

export default function Map3D() {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [base, setBase] = useState<keyof typeof BASES>("satellite");
  const [costar, setCostar] = useState(false);
  const [terrain, setTerrain] = useState(true);
  const [loading, setLoading] = useState(true);
  // Evacuation areas: "whatif" = wind-shaped areas from our fire model (default), "real" = LAFD Jan 2025
  const [evac, setEvac] = useState<"whatif" | "real" | "hidden">("whatif");
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      for (const [src, on] of [["evac", evac === "real"], ["evac_whatif", evac === "whatif"]] as const)
        for (const k of ["fill", "line"]) if (m.getLayer(`${src}-${k}`)) m.setLayoutProperty(`${src}-${k}`, "visibility", on ? "visible" : "none");
    };
    if (m.isStyleLoaded()) apply(); else m.once("idle", apply);
  }, [evac]);
  const [tMin, setTMin] = useState(0);
  const [playing, setPlaying] = useState(false);
  const DURATION = 180, RUN_SECONDS = 25;

  // play: the whole fire in RUN_SECONDS
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      setTMin(t => { const n = Math.min(DURATION, t + dt * DURATION / RUN_SECONDS); if (n >= DURATION) setPlaying(false); return n; });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // Fire data in time order: cells (index = generated feature id) and buildings reached.
  const cells = useRef<{ id: number; t: number }[]>([]);
  const arrivals = useRef<[string, number][]>([]);
  const ptr = useRef({ burn: 0, cool: 0, bld: 0, t: -1 });
  const FRONT_MIN = 10;
  useEffect(() => {
    fetch("/api/demo/fire_cells.geojson").then(r => r.json()).then(fc => {
      cells.current = (fc.features as { properties: { t: number } }[]).map((f, id) => ({ id, t: f.properties.t }))
        .sort((a, b) => a.t - b.t);
    });
    fetch("/api/demo/building_arrivals.json").then(r => r.json()).then(a => { arrivals.current = a; });
  }, []);

  // Apply the clock: only cells/buildings that changed since the last frame get a state update.
  useEffect(() => {
    const m = map.current;
    if (!m || !m.getSource("fire") || !m.getSource("buildings")) return;
    const p = ptr.current;
    if (tMin < p.t) {  // went back in time (replay or slider): clear and re-apply
      m.removeFeatureState({ source: "fire" });
      m.removeFeatureState({ source: "buildings" });
      Object.assign(p, { burn: 0, cool: 0, bld: 0 });
    }
    const c = cells.current, a = arrivals.current;
    while (p.burn < c.length && c[p.burn].t <= tMin) { m.setFeatureState({ source: "fire", id: c[p.burn].id }, { burned: true, front: true }); p.burn++; }
    while (p.cool < p.burn && c[p.cool].t <= tMin - FRONT_MIN) { m.setFeatureState({ source: "fire", id: c[p.cool].id }, { front: false }); p.cool++; }
    while (p.bld < a.length && a[p.bld][1] <= tMin) { m.setFeatureState({ source: "buildings", id: a[p.bld][0] }, { burned: true }); p.bld++; }
    p.t = tMin;
  }, [tMin]);

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = new maplibregl.Map({ container: el.current, style: style("satellite"), ...VIEWS.overview, maxPitch: 80,
                                   canvasContextAttributes: { antialias: true } });
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    m.on("sourcedata", e => { if (e.sourceId === "buildings" && e.isSourceLoaded) setLoading(false); });
    m.on("click", "buildings", e => {
      const p = e.features?.[0]?.properties as Record<string, unknown> | undefined;
      if (!p) return;
      const row = (k: string, v: unknown) => v === null || v === undefined || v === "null" ? "" : `<tr><td style="color:#8a8984;padding-right:8px">${k}</td><td>${v}</td></tr>`;
      new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(e.lngLat).setHTML(
        `<b>${p.name && p.name !== "null" ? p.name : "Building"}</b><table style="font-size:12px">` +
        row("use", p.use) + row("stories", p.stories) + row("height", `${p.h} m`) + row("units", p.units) +
        row("people (est.)", p.people) + row("need help (est.)", p.need) + row("CoStar", Number(p.costar) ? "yes" : "no") +
        `</table>`).addTo(m);
    });
    m.on("mouseenter", "buildings", () => { m.getCanvas().style.cursor = "pointer"; });
    m.on("mouseleave", "buildings", () => { m.getCanvas().style.cursor = ""; });
    // LAFD stations (#46): HTML markers, so no glyph server is needed for labels
    fetch("/api/demo/stations.json").then(r => r.json()).then((d: { stations: { name: string; number: number; lat: number; lng: number }[] }) => {
      for (const st of d.stations) {
        const el = document.createElement("div");
        el.title = st.name;
        el.textContent = String(st.number);
        Object.assign(el.style, { background: "#c2261d", color: "#fff", font: "600 11px/1 -apple-system, sans-serif",
          padding: "4px 5px", borderRadius: "4px", border: "2px solid #fff", boxShadow: "0 1px 4px #0006" });
        new maplibregl.Marker({ element: el }).setLngLat([st.lng, st.lat]).setPopup(new maplibregl.Popup().setText(st.name)).addTo(m);
      }
    });
    map.current = m;
    (window as unknown as { __map?: maplibregl.Map }).__map = m;  // debugging handle (local prototype only)
    return () => { m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      if (m.getLayer("buildings-costar")) m.setLayoutProperty("buildings-costar", "visibility", costar ? "visible" : "none");
      if (m.getLayer("buildings")) m.setPaintProperty("buildings", "fill-extrusion-opacity", costar ? 0.55 : 0.92);
      m.setTerrain(terrain ? { source: "dem", exaggeration: 1.4 } : null);
    };
    if (m.isStyleLoaded()) apply(); else m.once("idle", apply);
  }, [costar, terrain]);

  const switchBase = (b: keyof typeof BASES) => {
    setBase(b);
    map.current?.setStyle(style(b));
    map.current?.once("styledata", () => {
      const m = map.current!;
      m.setLayoutProperty("buildings-costar", "visibility", costar ? "visible" : "none");
      m.setTerrain(terrain ? { source: "dem", exaggeration: 1.4 } : null);
      ptr.current = { burn: 0, cool: 0, bld: 0, t: -1 };
      m.once("idle", () => setTMin(t => t + 1e-6));
    });
  };
  const fly = (v: keyof typeof VIEWS) => map.current?.flyTo({ ...VIEWS[v], duration: 2500, essential: true });

  const btn = (on: boolean): React.CSSProperties => ({ border: "1px solid #e4e3df", background: on ? "#1d1d1b" : "#fcfcfbee",
    color: on ? "#fcfcfb" : "#1d1d1b", borderRadius: 6, padding: "6px 10px", font: "inherit", fontSize: 13, cursor: "pointer" });

  return (
    <div style={{ position: "relative", height: "100vh", width: "100vw" }}>
      <div ref={el} style={{ position: "absolute", inset: 0 }} />
      <div style={{ position: "absolute", top: 12, left: 12, background: "#fcfcfbee", borderRadius: 10, padding: "10px 12px",
                    boxShadow: "0 2px 12px #0002", maxWidth: 330 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>Roll Call: Hollywood 3D (prototype, #47)</div>
        <div style={{ fontSize: 12, color: "#5c5b57", margin: "2px 0 8px" }}>
          42,557 real buildings (Vexcel outlines, heights from CoStar or Assessor) on free terrain tiles. Dashed: evacuation areas (red = order, orange = warning).
          {loading && <b> Loading buildings…</b>}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(Object.keys(VIEWS) as (keyof typeof VIEWS)[]).map(v => <button key={v} style={btn(false)} onClick={() => fly(v)}>{v}</button>)}
          <button style={btn(base === "satellite")} onClick={() => switchBase(base === "satellite" ? "light" : "satellite")}>
            {base === "satellite" ? "satellite" : "light"} base</button>
          <button style={btn(terrain)} onClick={() => setTerrain(t => !t)}>hills {terrain ? "on" : "off"}</button>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8, fontSize: 12, color: "#5c5b57" }}>
          Evacuation areas:
          {(["whatif", "real", "hidden"] as const).map(v => (
            <button key={v} style={btn(evac === v)} onClick={() => setEvac(v)}>
              {v === "whatif" ? "what-if (wind)" : v === "real" ? "real (Jan 2025)" : "hidden"}</button>))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <button style={btn(playing)} onClick={() => { if (tMin >= DURATION) setTMin(0); setPlaying(p => !p); }}>
            {playing ? "pause" : tMin >= DURATION ? "replay" : "play fire"}</button>
          <input type="range" min={0} max={DURATION} step={1} value={tMin} style={{ flex: 1 }}
            onChange={e => { setPlaying(false); setTMin(Number(e.target.value)); }} />
          <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 13, width: 70 }}>
            {Math.floor(tMin / 60)}h {String(Math.floor(tMin % 60)).padStart(2, "0")}m</span>
        </div>
      </div>
      <button onClick={() => setCostar(c => !c)} style={{ ...btn(costar), position: "absolute", left: 64, bottom: 28,
        background: costar ? "#f2c200" : "#fcfcfbee", color: "#1d1d1b", fontWeight: 600 }}>
        {costar ? "Showing CoStar buildings (314)" : "Highlight CoStar buildings"}
      </button>
    </div>
  );
}
