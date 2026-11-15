"use client";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { BASES, VIEWS } from "../3d/mapStyle";

// One row of the database function buildings_fire_risk. The rule and its weights are in the database
// (repo: data/db/fire_risk.py, DATABASE.md). This page holds no copy of them.
interface Row {
  id: string; lat: number; lng: number; assessor_address: string | null; building_type: string | null;
  units: number | null; units_source: string | null; people_at_risk: number | null; risk_score: number | null;
  fire_distance_m: number; fire_factor: number; fire_risk_score: number | null;
}
interface Origin { lat: number; lng: number }

const WINDS: [string, string][] = [["", "No wind (circle)"], ["0", "North"], ["45", "North-east"], ["90", "East"],
  ["135", "South-east"], ["180", "South"], ["225", "South-west"], ["270", "West"], ["315", "North-west"]];
const TABLE_ROWS = 25;
const label = (r: Row) => r.assessor_address || (r.building_type ?? "unknown use").replace("_", " ");
const num = (v: number | null, digits = 1) => (v === null ? "not known" : v.toFixed(digits));

export default function RiskView() {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const placingRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [wind, setWind] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [baseRank, setBaseRank] = useState<Map<string, number>>(new Map());
  const [status, setStatus] = useState("Loading the scores");

  // The map: a flat base map and one circle for each building in the result.
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = new maplibregl.Map({
      container: el.current, center: VIEWS.overview.center, zoom: 12.6,
      style: { version: 8, sources: { base: { type: "raster", tiles: [BASES.light], tileSize: 256, maxzoom: 16,
                                              attribution: "Tiles © Esri" } },
               layers: [{ id: "base", type: "raster", source: "base" }] },
    });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl(), "top-right");
    m.on("load", () => {
      m.addSource("risk", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "risk", type: "circle", source: "risk", paint: {
        // size = the score, color = how much the fire raised it (x1 yellow, x2 dark red)
        "circle-radius": ["interpolate", ["linear"], ["sqrt", ["get", "score"]], 0, 2, 20, 22],
        "circle-color": ["interpolate", ["linear"], ["get", "factor"], 1, "#f2c94c", 1.5, "#f2762e", 2, "#b3201a"],
        "circle-opacity": 0.8, "circle-stroke-color": "#fff", "circle-stroke-width": 0.6 } });
      setReady(true);
    });
    m.on("click", e => {
      if (placingRef.current) {
        placingRef.current = false; setPlacing(false);
        setOrigin({ lat: e.lngLat.lat, lng: e.lngLat.lng });
        return;
      }
      const f = m.queryRenderedFeatures(e.point, { layers: ["risk"] })[0];
      if (!f) return;
      new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(e.lngLat).setHTML(f.properties.html).addTo(m);
    });
    return () => { m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    placingRef.current = placing;
    if (map.current) map.current.getCanvas().style.cursor = placing ? "crosshair" : "";
  }, [placing]);

  // Ask the server for the scores: with no origin, the stored risk_score; with an origin, the fire-adjusted score.
  useEffect(() => {
    const query = origin ? `?lat=${origin.lat}&lng=${origin.lng}${wind ? `&wind_from_deg=${wind}` : ""}` : "";
    let stale = false;
    setStatus("Loading the scores");
    fetch(`/api/fire-risk${query}`).then(async res => {
      const data = await res.json();
      if (stale) return;
      if (!res.ok) { setStatus(data.detail ?? `Error ${res.status}`); return; }
      const list = data.buildings as Row[];
      setRows(list);
      if (!origin) setBaseRank(new Map(list.map((r, i) => [r.id, i + 1])));
      setStatus("");
    }).catch(() => { if (!stale) setStatus("The scores did not load."); });
    return () => { stale = true; };
  }, [origin, wind]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const esc = (s: string) => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
    (m.getSource("risk") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: rows.filter(r => r.fire_risk_score !== null).map(r => ({
        type: "Feature", geometry: { type: "Point", coordinates: [r.lng, r.lat] },
        properties: { score: r.fire_risk_score, factor: r.fire_factor, html:
          `<div class="pop"><b>${esc(label(r))}</b><table>` +
          `<tr><td class="k">Homes</td><td>${r.units ?? "not known"}${r.units_source ? ` (${esc(r.units_source)})` : ""}</td></tr>` +
          `<tr><td class="k">People who need help</td><td>${num(r.people_at_risk)} (estimate)</td></tr>` +
          `<tr><td class="k">Score with no fire</td><td>${num(r.risk_score)}</td></tr>` +
          (origin ? `<tr><td class="k">Distance to origin</td><td>${Math.round(r.fire_distance_m)} m</td></tr>` +
                    `<tr><td class="k">Fire factor</td><td>x${r.fire_factor.toFixed(2)}</td></tr>` +
                    `<tr><td class="k">Score with this fire</td><td>${num(r.fire_risk_score)}</td></tr>` : "") +
          `</table></div>` },
      })),
    });
  }, [rows, ready, origin]);

  useEffect(() => {
    marker.current?.remove();
    marker.current = null;
    if (origin && map.current)
      marker.current = new maplibregl.Marker({ color: "#b3201a" }).setLngLat([origin.lng, origin.lat]).addTo(map.current);
  }, [origin, ready]);

  const windName = WINDS.find(w => w[0] === wind)?.[1].toLowerCase();
  return (
    <div className="app" style={{ gridTemplateColumns: "470px 1fr" }}>
      <div className="side">
        <h1>Building risk for a fire origin</h1>
        <p className="sub">
          Each building has a stored risk score: people who need help to leave x how likely the structure is to burn.
          A fire origin raises the score of the buildings near it, at most to 2 times. It does not replace the score.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "10px 0" }}>
          <button onClick={() => setPlacing(p => !p)}
                  style={{ padding: "7px 12px", borderRadius: 6, border: "1px solid #b3201a", cursor: "pointer", fontWeight: 600,
                           background: placing ? "#fff" : "#b3201a", color: placing ? "#b3201a" : "#fff" }}>
            {placing ? "Cancel" : origin ? "Move fire origin" : "Create fire origin"}
          </button>
          {origin && <button onClick={() => { setOrigin(null); setPlacing(false); }}
                             style={{ padding: "7px 12px", borderRadius: 6, border: "1px solid var(--line)", cursor: "pointer",
                                      background: "transparent", color: "inherit" }}>Remove fire</button>}
          <label style={{ fontSize: 13 }}>Wind from{" "}
            <select value={wind} onChange={e => setWind(e.target.value)}>
              {WINDS.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
            </select>
          </label>
        </div>
        <p className="sub" style={{ minHeight: 18 }}>
          {status || (placing ? "Click the map where the fire starts."
            : origin ? `Fire origin at ${origin.lat.toFixed(4)}, ${origin.lng.toFixed(4)}${wind ? `, wind from the ${windName}` : ", no wind"}.`
            : "No fire. The map shows the stored risk score.")}
        </p>

        <h2>{origin ? "Highest scores with this fire" : "Highest scores with no fire"}</h2>
        <table>
          <thead><tr><th>Building</th><th>Homes</th><th>Score</th>
            {origin && <><th>Distance</th><th>Fire</th><th>New score</th><th>Rank before</th></>}</tr></thead>
          <tbody>
            {rows.slice(0, TABLE_ROWS).map((r, i) => (
              <tr key={r.id} style={{ cursor: "pointer" }}
                  onClick={() => map.current?.flyTo({ center: [r.lng, r.lat], zoom: Math.max(map.current.getZoom(), 15) })}>
                <td style={{ maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i + 1}. {label(r)}</td>
                <td>{r.units ?? ""}</td><td>{num(r.risk_score)}</td>
                {origin && <><td>{(r.fire_distance_m / 1000).toFixed(1)} km</td><td>x{r.fire_factor.toFixed(2)}</td>
                  <td><b>{num(r.fire_risk_score)}</b></td><td>{baseRank.get(r.id) ?? "over 1,000"}</td></>}
              </tr>
            ))}
          </tbody>
        </table>

        <h2>How to read the map</h2>
        <div className="legend" style={{ marginLeft: 0 }}>
          <div>Circle size: the score. The map shows the 1,000 highest scores.</div>
          <div><span className="sw" style={{ background: "#f2c94c" }} /> not raised by the fire (x1)</div>
          <div><span className="sw" style={{ background: "#f2762e" }} /> raised by half (x1.5)</div>
          <div><span className="sw" style={{ background: "#b3201a" }} /> at the origin (x2)</div>
        </div>
        <p className="note">
          This is a rule of thumb, not a fire model. It uses the distance to the origin and the wind direction only:
          no hills, no fuel, no time. With wind, distances downwind count as shorter, so the reach is a slight oval.
          The weights are first guesses that nobody has checked against a real fire. People numbers are estimates.
          Schools, hospitals, hotels and shops have no score, because the number of people inside is not known.
        </p>
      </div>
      <div ref={el} className="map" />
    </div>
  );
}
