"use client";

import { useMemo, useState } from "react";
import CesiumMap from "./cesium-map";
import { demoScore, riskColor } from "../lib/buildings";
import { demoBuildings } from "../lib/demo-buildings";
import { cityBuildingCount, createCityBuildings } from "../lib/city-buildings";

const numberFormat = new Intl.NumberFormat("en-US");

export default function Home() {
  const [largeDemo, setLargeDemo] = useState(false);
  const [activeId, setActiveId] = useState<string>();
  const buildings = useMemo(() => largeDemo ? createCityBuildings() : demoBuildings, [largeDemo]);
  const listedBuildings = useMemo(() => {
    if (!largeDemo) return buildings;
    return buildings.map((building) => ({ building, score: demoScore(building.demoRisk) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(({ building }) => building);
  }, [buildings, largeDemo]);

  const selected = buildings.find((building) => building.id === activeId) ?? listedBuildings[0];
  const risk = selected.demoRisk;

  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Roll Call</h1>
          <p>Building evacuation risk</p>
        </div>
        <div className="demo-controls">
          <p className="source">Demo data · Database integration pending</p>
          <label htmlFor="demo-size">Dataset</label>
          <select id="demo-size" value={largeDemo ? "city" : "sample"} onChange={(event) => {
            setActiveId(undefined);
            setLargeDemo(event.target.value === "city");
          }}>
            <option value="sample">6 buildings</option>
            <option value="city">{numberFormat.format(cityBuildingCount)} buildings</option>
          </select>
        </div>
      </header>
      <div className="dashboard-grid">
        <section className="map-panel" aria-label="Building map">
          <CesiumMap key={String(largeDemo)} buildings={buildings} batched={largeDemo}
            activeId={selected.id} onSelect={setActiveId} />
          <footer className="map-footer">
            <span>Drag to pan · Scroll to zoom</span>
            <div className="legend" aria-label="Demo score ranges">
              <span className="low">Low</span>
              <span className="medium">Medium</span>
              <span className="high">High</span>
            </div>
          </footer>
        </section>
        <aside className="sidebar">
          <h2>{largeDemo ? "Top 20 by risk" : "Buildings"}</h2>
          <ul className="building-list">
            {listedBuildings.map((building) => (
              <li key={building.id}>
                <button onClick={() => setActiveId(building.id)} aria-pressed={selected.id === building.id}>
                  <span>{building.name}</span>
                  <strong style={{ color: riskColor(building.demoRisk) }}>
                    {demoScore(building.demoRisk).toFixed(1)}
                  </strong>
                </button>
              </li>
            ))}
          </ul>
          <section className="building-detail" aria-labelledby="selected-building">
            <h2 id="selected-building">{selected.name}</h2>
            <dl>
              <div><dt>Height</dt><dd>{selected.height_m} m</dd></div>
              <div><dt>Exposure</dt><dd>{Math.round(risk.exposure * 100)}%</dd></div>
              <div><dt>Evacuation difficulty</dt><dd>{Math.round(risk.evacuationDifficulty * 100)}%</dd></div>
              <div><dt>Urgency</dt><dd>{Math.round(risk.urgency * 100)}%</dd></div>
              <div className="score"><dt>Demo risk</dt><dd>{demoScore(risk).toFixed(1)} / 10</dd></div>
            </dl>
          </section>
        </aside>
      </div>
    </main>
  );
}
