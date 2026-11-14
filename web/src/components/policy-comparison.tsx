"use client";

import { useEffect, useRef, useState } from "react";
import { apiMatcher, createComparison } from "../lib/comparison";
import type { BuildingInput, SimConfig, Truck } from "../lib/simulation";

interface Props {
  buildings: readonly BuildingInput[];
  trucks: readonly Truck[];
  config: SimConfig;
  durationMin: number;
  apiBase: string;
}

type Frame = Awaited<ReturnType<ReturnType<typeof createComparison>["frame"]>>;

export function PolicyComparison({ buildings, trucks, config, durationMin, apiBase }: Props) {
  const [frame, setFrame] = useState<Frame>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);

  useEffect(() => () => active.current?.abort(), []);

  async function run() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setFrame(undefined);
    setError("");
    setRunning(true);

    try {
      const comparison = createComparison(
        buildings, trucks, config, apiMatcher(apiBase, controller.signal), durationMin,
      );
      let next: Frame;
      do {
        const timestamp = await new Promise<number>(resolve => requestAnimationFrame(resolve));
        if (controller.signal.aborted) return;
        next = await comparison.frame(timestamp);
        if (controller.signal.aborted) return;
        setFrame(next);
        if (!next.done) await new Promise(resolve => setTimeout(resolve, 120));
      } while (!next.done);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "The comparison failed.");
      }
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  }

  return (
    <section aria-label="Matching policy comparison">
      <h2>Matching policy comparison</h2>
      <p>Simulated estimates using the same fire, people, trucks, and seed.</p>
      <button type="button" disabled={running || !buildings.length || !trucks.length} onClick={run}>
        {running ? "Running both policies…" : "Run both policies"}
      </button>
      {error && <p role="alert">{error}</p>}
      {frame && (
        <>
          <p>Minute {Math.floor(frame.minute)} / {durationMin}{frame.done ? " · Complete" : ""}</p>
          <table>
            <caption>Simulated population outcomes</caption>
            <thead>
              <tr><th scope="col">Policy</th><th scope="col">Evacuated</th><th scope="col">Trapped</th><th scope="col">Inside</th></tr>
            </thead>
            <tbody>
              {([["Risk-aware", frame.ours], ["Nearest-first", frame.nearest]] as const).map(([name, counts]) => (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  <td>{counts.evacuated.toLocaleString()}</td>
                  <td>{counts.trapped.toLocaleString()}</td>
                  <td>{counts.inside.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
