"use client";

import { useEffect, useState } from "react";
import CesiumMap from "./cesium-map";
import { demoScore, getBuildings, riskColor } from "../lib/buildings";

export default function Home() {
  const [result, setResult] = useState<Awaited<ReturnType<typeof getBuildings>>>();
  const [activeId, setActiveId] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    getBuildings(controller.signal).then((data) => {
      if (!controller.signal.aborted) setResult(data);
    }).catch(() => {});
    return () => controller.abort();
  }, []);

  const selected = result?.buildings.find((building) => building.id === activeId) ?? result?.buildings[0];
  const risk = selected?.demoRisk;

  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Roll Call</h1>
          <p>Building evacuation risk</p>
        </div>
        {result && (
          <p className="source">
            {result.source === "api" ? "API buildings · Risk scores pending" :
              result.apiUnavailable ? "Demo data · API unavailable" : "Demo data · Database integration pending"}
          </p>
        )}
      </header>
      {result ? (
        <div className="dashboard-grid">
          <section className="map-panel" aria-label="Building map">
            <CesiumMap buildings={result.buildings} activeId={selected?.id} onSelect={setActiveId} />
            <footer className="map-footer">
              <span>Drag to pan · Scroll to zoom</span>
              {result.source === "demo" && (
                <div className="legend" aria-label="Demo score ranges">
                  <span className="low">Low</span>
                  <span className="medium">Medium</span>
                  <span className="high">High</span>
                </div>
              )}
            </footer>
          </section>
          <aside className="sidebar">
            <h2>Buildings</h2>
            {result.buildings.length ? (
              <ul className="building-list">
                {result.buildings.map((building) => (
                  <li key={building.id}>
                    <button onClick={() => setActiveId(building.id)} aria-pressed={selected?.id === building.id}>
                      <span>{building.name}</span>
                      <strong style={{ color: riskColor(building.demoRisk) }}>
                        {building.demoRisk ? demoScore(building.demoRisk).toFixed(1) : "–"}
                      </strong>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p>No buildings were returned.</p>}
            {selected && (
              <section className="building-detail" aria-labelledby="selected-building">
                <h2 id="selected-building">{selected.name}</h2>
                <dl>
                  <div><dt>Height</dt><dd>{selected.height_m} m</dd></div>
                  {risk && (
                    <>
                      <div><dt>Exposure</dt><dd>{Math.round(risk.exposure * 100)}%</dd></div>
                      <div><dt>Evacuation difficulty</dt><dd>{Math.round(risk.evacuationDifficulty * 100)}%</dd></div>
                      <div><dt>Urgency</dt><dd>{Math.round(risk.urgency * 100)}%</dd></div>
                      <div className="score"><dt>Demo risk</dt><dd>{demoScore(risk).toFixed(1)} / 10</dd></div>
                    </>
                  )}
                </dl>
              </section>
            )}
          </aside>
        </div>
      ) : <p role="status">Loading buildings…</p>}
    </main>
  );
}
