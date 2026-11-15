"use client";
// /interior: every property that has a usable interior scan, with the same panel that /console opens.
// It needs only data/demo/interiors_index.json and interiors.json, so it works with no fire or road data.
import { useEffect, useState } from "react";
import InteriorPanel from "./InteriorPanel";
import { loadInteriorIndex, type InteriorIndex } from "./interiorData";

export default function Page() {
  const [index, setIndex] = useState<InteriorIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    loadInteriorIndex().then(x => { setIndex(x); setOpen(new URLSearchParams(location.search).get("p")); }).catch(e => setError(String(e)));
  }, []);
  const ids = index ? Object.keys(index).sort((a, b) => (index[a].name ?? "").localeCompare(index[b].name ?? "")) : [];

  return (
    <div style={{ minHeight: "100vh", background: "#0a101c", color: "#e2e8f0", font: "13px/1.45 system-ui, sans-serif", padding: 16 }}>
      <h1 style={{ fontSize: 16, margin: "0 0 4px" }}>Interior layouts</h1>
      <p style={{ color: "#94a3b8", margin: "0 0 12px" }}>
        {error ? `Could not load the index: ${error}` : !index ? "Loading…"
          : ids.length ? `${ids.length} properties have a scanned apartment with a labelled bedroom. Pick one.`
          : "No layouts on this machine. Run: python3 data/pipeline/interior_layouts.py"}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 6 }}>
        {ids.map(id => (
          <button key={id} onClick={() => setOpen(id)}
            style={{ textAlign: "left", font: "inherit", color: "inherit", background: "#172033", border: "1px solid #334155", borderRadius: 5, padding: "6px 8px", cursor: "pointer" }}>
            <b>{index![id].name || index![id].address || id}</b>
            <div style={{ color: "#94a3b8" }}>{index![id].scans.length} scanned apartment{index![id].scans.length === 1 ? "" : "s"}</div>
          </button>))}
      </div>
      {open && index?.[open] &&
        <InteriorPanel title={index[open].name || index[open].address || open} scans={index[open].scans} onClose={() => setOpen(null)} />}
    </div>
  );
}
