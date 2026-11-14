import type { DemoRisk } from "./types";

export function demoScore(risk: DemoRisk) {
  return Math.round(100 * risk.exposure * risk.evacuationDifficulty * risk.urgency) / 10;
}

export function riskColor(risk: DemoRisk) {
  const score = demoScore(risk);
  if (score >= 7) return "#fc7769";
  if (score >= 4) return "#f5b85b";
  return "#79cfc0";
}
