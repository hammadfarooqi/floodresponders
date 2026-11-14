import type { StyleSpecification } from "maplibre-gl";

// Free tiles, no account: AWS Terrain Tiles (terrarium DEM) for hills, Esri imagery / light gray for the base.
export const TERRAIN = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
export const BASES = {
  satellite: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  light: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
};
export const VIEWS = {
  overview: { center: [-118.338, 34.098] as [number, number], zoom: 13.4, pitch: 62, bearing: 20 },
  hills: { center: [-118.352, 34.108] as [number, number], zoom: 15.2, pitch: 72, bearing: 160 },
  flats: { center: [-118.332, 34.0985] as [number, number], zoom: 16.2, pitch: 64, bearing: 15 },
};
export const USE_COLORS = ["match", ["get", "use"], "residential", "#e9e4d8", "commercial", "#b8c4d6", "none", "#8d8a83", "#cfcac0"];

export function style(base: keyof typeof BASES): StyleSpecification {
  return {
    version: 8,
    sources: {
      base: { type: "raster", tiles: [BASES[base]], tileSize: 256, maxzoom: 19, attribution: "Tiles © Esri" },
      dem: { type: "raster-dem", tiles: [TERRAIN], encoding: "terrarium", tileSize: 256, maxzoom: 15,
             attribution: "Terrain: Mapzen / AWS Open Data" },
      dem_shade: { type: "raster-dem", tiles: [TERRAIN], encoding: "terrarium", tileSize: 256, maxzoom: 15 },
      buildings: { type: "geojson", data: "/api/demo/buildings_map.geojson", promoteId: "id" },
      evac: { type: "geojson", data: "/api/demo/sunset_fire_2025_evacuation.geojson" },
      evac_whatif: { type: "geojson", data: "/api/demo/evac_whatif.geojson" },
      fire: { type: "geojson", data: "/api/demo/fire_cells.geojson", generateId: true },
    },
    layers: [
      { id: "base", type: "raster", source: "base" },
      { id: "hillshade", type: "hillshade", source: "dem_shade",
        paint: { "hillshade-exaggeration": 0.35, "hillshade-shadow-color": "#3a2f25" } },
      ...(["evac", "evac_whatif"] as const).flatMap(src => [
        { id: `${src}-fill`, type: "fill" as const, source: src,
          layout: { visibility: (src === "evac_whatif" ? "visible" : "none") as "visible" | "none" },
          paint: { "fill-color": ["case", ["==", ["slice", ["get", "name"], 0, 9], "Mandatory"], "#c2261d", "#eb6834"] as never,
                   "fill-opacity": 0.12 } },
        { id: `${src}-line`, type: "line" as const, source: src,
          layout: { visibility: (src === "evac_whatif" ? "visible" : "none") as "visible" | "none" },
          paint: { "line-color": ["case", ["==", ["slice", ["get", "name"], 0, 9], "Mandatory"], "#c2261d", "#eb6834"] as never,
                   "line-width": 3, "line-dasharray": [2, 1.5] } },
      ]),
      // Fire and burned buildings are driven by feature-state flags set once per cell/building as the clock
      // passes them. Changing paint expressions every frame made MapLibre re-lay out 42k buildings and lag.
      { id: "fire", type: "fill", source: "fire",
        paint: { "fill-color": ["case", ["boolean", ["feature-state", "front"], false], "#ff7a1a", "#5b2310"],
                 "fill-opacity": ["case", ["boolean", ["feature-state", "burned"], false], 0.8, 0] } },
      { id: "buildings", type: "fill-extrusion", source: "buildings",
        paint: { "fill-extrusion-color": ["case", ["boolean", ["feature-state", "burned"], false], "#3a2a22", USE_COLORS] as never,
                 "fill-extrusion-height": ["get", "h"],
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

