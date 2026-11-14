// Two scripted agent moments for the AI run (plan v2 demo). The words are a SCRIPTED demo transcript;
// the live agent (#52 / #58 / #66, POST /api/agent/event) can replace them. The effects on the simulation are real:
// the truck is out of service, the stuck tenants exist in both runs, and the AI re-matches after each call.

import { mins, type Simulation, type LogEntry } from "./engine.ts";

export interface Line { t: number; speaker: "Roll Call" | "Driver" | "Supervisor" | "Dispatcher" | "System"; to?: string; text: string }

export const STUCK = {
  building_id: "16356373b879",  // Lanewood Court Apartments (CoStar, 5 stories, manager phone on file), fire ~136 min
  count: 3,
  call_min: 100,
};
export const DECLINE = { call_min: 35, out_min: 25 };

/** Call once at the start of BOTH runs: the stuck tenants are real in both worlds. */
export function seedHidden(sim: Simulation) {
  sim.addHiddenNeed(STUCK.building_id, STUCK.count);
}

function notifications(sim: Simulation, fromIdx: number, t: number): Line[] {
  return sim.log.slice(fromIdx)
    .filter((e: LogEntry) => e.kind === "assign" || e.kind === "reassign")
    .map(e => {
      const tr = sim.trucks.find(x => x.id === e.truck)!;
      const b = sim.byId.get(e.building!)!;
      return { t, speaker: "Roll Call" as const, to: tr.name,
        text: `${tr.name}, new assignment: ${b.label}. About ${Math.round(b.needKnown)} people need help. ` +
              `Fire expected in ${mins(b.fire - sim.t)}. Your ETA is ${mins(tr.eta_min ?? 0)}.` };
    });
}

/** Driver declines: the truck that is driving and furthest from its building says no. Returns the transcript. */
export function driverDeclines(sim: Simulation): Line[] {
  const t = sim.t;
  const driving = sim.trucks.filter(tr => tr.status === "en_route" && tr.building);
  const working = sim.trucks.filter(tr => tr.status === "on_scene" && tr.building);
  const pool = driving.length ? driving : working;
  if (!pool.length) return [];
  const tr = pool.reduce((a, b) => ((a.eta_min ?? 0) >= (b.eta_min ?? 0) ? a : b));
  const b = sim.byId.get(tr.building!)!;
  const onScene = tr.status === "on_scene";
  const lines: Line[] = [
    { t, speaker: "Roll Call", to: tr.name, text: onScene
      ? `${tr.name}, status check at ${b.label}: ${Math.round(b.needKnown)} people still need help. How long do you need?`
      : `${tr.name}, confirm you are heading to ${b.label}, ${Math.round(b.needKnown)} people need help.` },
    { t, speaker: "Driver", to: "Roll Call", text: onScene
      ? `We have to leave. Man down on Franklin, cardiac, and we're the closest unit. We'll be committed for about ${DECLINE.out_min} minutes.`
      : `Negative. We stopped for a man down on Franklin, cardiac. We're committed here for about ${DECLINE.out_min} minutes.` },
    { t, speaker: "Roll Call", to: tr.name, text: `Understood. I'm marking ${tr.name} out of service for ${DECLINE.out_min} minutes and moving ${b.label} to another truck.` },
  ];
  const from = sim.log.length;
  sim.log.push({ t, kind: "call", truck: tr.id, building: b.id, speaker: "Driver",
    text: `${tr.name} declines ${b.label}: committed to a medical call (${DECLINE.out_min} min).` });
  sim.applyEvent({ type: "driver_declines", truck_id: tr.id, reason: "medical call", out_min: DECLINE.out_min });
  sim.rematch(true);
  const notes = notifications(sim, from, t);
  const taker = sim.trucks.find(x => x.building === b.id);
  if (!taker && sim.approvalRequired) lines.push({ t, speaker: "System", text: `New pairing for ${b.label} sent to the dispatcher for approval.` });
  else if (!taker) lines.push({ t, speaker: "System",
    text: `No other truck is free and able to reach ${b.label} before the fire right now (the others are working at buildings). It stays in the queue for the next free truck.` });
  return [...lines, ...notes];
}

/** A building supervisor calls in: tenants who cannot get out. */
export function tenantStuck(sim: Simulation): Line[] {
  const t = sim.t;
  const b = sim.byId.get(STUCK.building_id);
  if (!b || b.burned) return [];
  const lines: Line[] = [
    { t, speaker: "Supervisor", to: "Roll Call", text: `This is the building manager at ${b.label}. We have a tenant on the 4th floor in a wheelchair, and her two neighbors won't leave without her. The elevator is off.` },
    { t, speaker: "Roll Call", text: `Thank you. I've logged ${STUCK.count} people who need help at ${b.label}. The fire is expected there in about ${mins(b.fire - t)}. Please keep them together by the stairwell on the 4th floor.` },
  ];
  const from = sim.log.length;
  sim.log.push({ t, kind: "call", building: b.id, speaker: "Supervisor",
    text: `Supervisor at ${b.label}: ${STUCK.count} people cannot get out (wheelchair, 4th floor, elevator off).` });
  sim.applyEvent({ type: "tenant_stuck", building_id: b.id, count: STUCK.count, note: "wheelchair, 4th floor" });
  sim.rematch(true);
  const notes = notifications(sim, from, t);
  const sent = sim.trucks.find(tr => tr.building === b.id);
  lines.push(sent
    ? { t, speaker: "Roll Call", to: "Supervisor", text: `${sent.name} is on its way to you, ETA ${mins(sent.eta_min ?? 0)}. I'll call back if that changes.` }
    : sim.approvalRequired
      ? { t, speaker: "Roll Call", to: "Supervisor", text: `I'm asking the dispatcher to approve a truck for you now. I'll call you back with the ETA.` }
      : { t, speaker: "Roll Call", to: "Supervisor", text: `Every truck is busy right now. You are next in the queue; I'll call you back with an ETA.` });
  return [...lines, ...notes];
}

/** Callback to the supervisor when a truck is assigned to the stuck building after the call. */
export function followUps(sim: Simulation, fromIdx: number, afterMin: number): Line[] {
  return sim.log.slice(fromIdx)
    .filter(e => e.t > afterMin && (e.kind === "assign" || e.kind === "reassign") && e.building === STUCK.building_id)
    .map(e => {
      const tr = sim.trucks.find(x => x.id === e.truck)!;
      return { t: e.t, speaker: "Roll Call" as const, to: "Supervisor",
        text: `Calling back: ${tr.name} is on its way to you now, ETA ${mins(tr.eta_min ?? 0)}.` };
    });
}
