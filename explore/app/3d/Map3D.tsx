"use client";
import maplibregl, { type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";

// Free tiles, no account: AWS Terrain Tiles (terrarium DEM) for hills, Esri imagery / light gray for the base.
const TERRAIN = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const BASES = {
  satellite: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  light: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
};
const VIEWS = {
  overview: { center: [-118.338, 34.098] as [number, number], zoom: 13.4, pitch: 62, bearing: 20 },
  hills: { center: [-118.352, 34.108] as [number, number], zoom: 15.2, pitch: 72, bearing: 160 },
  flats: { center: [-118.332, 34.0985] as [number, number], zoom: 16.2, pitch: 64, bearing: 15 },
};
const USE_COLORS = ["match", ["get", "use"], "residential", "#e9e4d8", "commercial", "#b8c4d6", "none", "#8d8a83", "#cfcac0"];

function style(base: keyof typeof BASES): StyleSpecification {
  return {
    version: 8,
    sources: {
      base: { type: "raster", tiles: [BASES[base]], tileSize: 256, maxzoom: 19, attribution: "Tiles © Esri" },
      dem: { type: "raster-dem", tiles: [TERRAIN], encoding: "terrarium", tileSize: 256, maxzoom: 15,
             attribution: "Terrain: Mapzen / AWS Open Data" },
      dem_shade: { type: "raster-dem", tiles: [TERRAIN], encoding: "terrarium", tileSize: 256, maxzoom: 15 },
      buildings: { type: "geojson", data: "/api/demo/buildings_map.geojson" },
      evac: { type: "geojson", data: "/api/demo/sunset_fire_2025_evacuation.geojson" },
    },
    layers: [
      { id: "base", type: "raster", source: "base" },
      { id: "hillshade", type: "hillshade", source: "dem_shade",
        paint: { "hillshade-exaggeration": 0.35, "hillshade-shadow-color": "#3a2f25" } },
      { id: "evac-fill", type: "fill", source: "evac",
        paint: { "fill-color": ["case", ["==", ["slice", ["get", "name"], 0, 9], "Mandatory"], "#c2261d", "#eb6834"],
                 "fill-opacity": 0.12 } },
      { id: "evac-line", type: "line", source: "evac",
        paint: { "line-color": ["case", ["==", ["slice", ["get", "name"], 0, 9], "Mandatory"], "#c2261d", "#eb6834"],
                 "line-width": 3, "line-dasharray": [2, 1.5] } },
      { id: "buildings", type: "fill-extrusion", source: "buildings",
        paint: { "fill-extrusion-color": USE_COLORS as never, "fill-extrusion-height": ["get", "h"],
                 "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.92 } },
      { id: "buildings-costar", type: "fill-extrusion", source: "buildings", filter: ["==", ["get", "costar"], 1],
        layout: { visibility: "none" },
        paint: { "fill-extrusion-color": "#f2c200", "fill-extrusion-height": ["+", ["get", "h"], 0.3],
                 "fill-extrusion-base": 0, "fill-extrusion-opacity": 1 } },
    ],
    terrain: { source: "dem", exaggeration: 1.4 },
    sky: { "sky-color": "#bcd6ee", "horizon-color": "#f2ece2", "fog-color": "#f2ece2", "sky-horizon-blend": 0.6 },
  };
}

export default function Map3D() {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [base, setBase] = useState<keyof typeof BASES>("satellite");
  const [costar, setCostar] = useState(false);
  const [terrain, setTerrain] = useState(true);
  const [loading, setLoading] = useState(true);

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
    map.current = m;
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
          42,557 real buildings (Vexcel outlines, heights from CoStar or Assessor) on free terrain tiles. Dashed: Sunset Fire 2025 evacuation areas.
          {loading && <b> Loading buildings…</b>}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(Object.keys(VIEWS) as (keyof typeof VIEWS)[]).map(v => <button key={v} style={btn(false)} onClick={() => fly(v)}>{v}</button>)}
          <button style={btn(base === "satellite")} onClick={() => switchBase(base === "satellite" ? "light" : "satellite")}>
            {base === "satellite" ? "satellite" : "light"} base</button>
          <button style={btn(terrain)} onClick={() => setTerrain(t => !t)}>hills {terrain ? "on" : "off"}</button>
        </div>
      </div>
      <button onClick={() => setCostar(c => !c)} style={{ ...btn(costar), position: "absolute", left: 64, bottom: 28,
        background: costar ? "#f2c200" : "#fcfcfbee", color: "#1d1d1b", fontWeight: 600 }}>
        {costar ? "Showing CoStar buildings (314)" : "Highlight CoStar buildings"}
      </button>
    </div>
  );
}
