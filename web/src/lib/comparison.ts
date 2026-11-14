import { Playback, Simulation } from "./simulation";
import type { Assignment, BuildingInput, Match, SimConfig, Truck } from "./simulation";

export function apiMatcher(base: string, signal: AbortSignal): Match {
  return async (state, policy) => {
    const response = await fetch(base + "/api/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, policy }),
      signal,
    });
    if (!response.ok) throw new Error("Matching failed (HTTP " + response.status + ").");
    const result: { assignments: Assignment[] } = await response.json();
    return result.assignments;
  };
}

export function createComparison(
  buildings: readonly BuildingInput[],
  trucks: readonly Truck[],
  config: SimConfig,
  match: Match,
  durationMin: number,
) {
  const ours = new Simulation(buildings, trucks, config, "ours", match, durationMin);
  const nearest = new Simulation(buildings, trucks, config, "nearest", match, durationMin);
  const oursPlayback = new Playback(ours);
  const nearestPlayback = new Playback(nearest);
  oursPlayback.play();
  nearestPlayback.play();

  return {
    async frame(timestamp: number) {
      await Promise.all([oursPlayback.frame(timestamp), nearestPlayback.frame(timestamp)]);
      const riskAware = ours.snapshot();
      const baseline = nearest.snapshot();
      return {
        minute: riskAware.minute,
        done: riskAware.done && baseline.done,
        ours: riskAware.counts,
        nearest: baseline.counts,
      };
    },
  };
}
