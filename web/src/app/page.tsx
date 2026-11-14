"use client";

import { useState } from "react";
import CesiumMap from "./cesium-map";
import { demoScore, riskColor } from "../lib/buildings";
import { demoBuildings } from "../lib/demo-buildings";

export default function Home() {
  const [activeId, setActiveId] = useState<string>();

  const selected = demoBuildings.find((building) => building.id === activeId) ?? demoBuildings[0];
  const risk = selected.demoRisk;

  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Roll Call</h1>
          <p>Building evacuation risk</p>
        </div>
        <p className="source">Demo data · Database integration pending</p>
      </header>
      <div className="dashboard-grid">
        <section className="map-panel" aria-label="Building map">
          <CesiumMap buildings={demoBuildings} activeId={selected.id} onSelect={setActiveId} />
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
          <h2>Buildings</h2>
          <ul className="building-list">
            {demoBuildings.map((building) => (
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
