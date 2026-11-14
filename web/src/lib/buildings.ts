import { demoBuildings } from "./demo-buildings";
import type { Building, DemoRisk, MapBuilding } from "./types";

export async function getBuildings(signal: AbortSignal): Promise<{
  buildings: MapBuilding[];
  source: "api" | "demo";
  apiUnavailable?: boolean;
}> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!apiUrl) return { buildings: demoBuildings, source: "demo" };

  try {
    const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/buildings`, { signal });
    if (!response.ok) throw new Error(`Buildings request failed (${response.status})`);
    const data: { buildings: Building[] } = await response.json();
    if (!Array.isArray(data.buildings)) throw new Error("Buildings response must contain an array");
    return { buildings: data.buildings, source: "api" };
  } catch (error) {
    if (signal.aborted) throw error;
    return { buildings: demoBuildings, source: "demo", apiUnavailable: true };
  }
}

export function demoScore(risk: DemoRisk) {
  return Math.round(100 * risk.exposure * risk.evacuationDifficulty * risk.urgency) / 10;
}

export function riskColor(risk?: DemoRisk) {
  if (!risk) return "#81889a";
  const score = demoScore(risk);
  if (score >= 7) return "#fc7769";
  if (score >= 4) return "#f5b85b";
  return "#79cfc0";
}
