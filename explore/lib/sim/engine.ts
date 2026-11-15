// Roll Call evacuation simulation (plan v2). Pure and deterministic: no randomness, no clock, no DOM.
// Same fire, same people, same trucks for both strategies; only the dispatch strategy changes.
//
//  "nearest" (old way): each free truck goes to the nearest building that still needs help; it never re-plans.
//  "ours"    (AI):      rank buildings by people needing help x urgency (time left before the fire), send the
//                       nearest truck that can arrive before the fire, re-match every few minutes and after calls.
//
// Ideas and shapes follow #60 (Simulation) and #62 (matching), with trucks routed on the real OSM road graph.

import { RoadGraph, meters, type RoadsJson } from "./graph.ts";

// "calls" = today's dispatch (the baseline): trucks go only to buildings whose 911 call was answered, oldest call
// first, closest free truck (CAD + AVL), no re-planning. "nearest" = older simple baseline. "ours" = Roll Call.
export type Policy = "ours" | "calls" | "nearest";

/** Every assumption in one place. The UI shows these. Values are assumptions, not measurements. */
export interface SimConfig {
  self_evac_rate_per_min: number;   // share of people who can leave alone that leave each minute
  need_alone_rate_per_min: number;  // share of people who need help that still get out alone each minute
  walk_m_per_min: { able: number; need: number };  // walking speed to safety along the streets
  assisted_people_per_min: number;  // people one truck crew brings out per minute
  truck_speed_kmh: number;          // average driving speed on hill streets during an evacuation
  rematch_every_min: number;        // AI only
  arrive_before_fire_min: number;   // AI only: do not send a truck that arrives later than this before the fire
  withdraw_before_fire_min: number; // crews leave a building this long before the fire reaches it (both runs)
  urgency_tau_min: number;          // AI time term: urgency = 1 / (1 + minutes_left / tau); threat = 1 + urgency
  // AI ranking (ranking only: the simulated people are the same in every run)
  priority_rule: "risk" | "urgency"; // "risk" = dynamic risk score: people x structure x threat(t) (Rasul's score +
                                     // fire timing); "urgency" = the earlier rule, people x urgency
  risk_people: "rasul" | "estimate"; // people count behind the ranking: Rasul's people_at_risk (Supabase) or our
                                     // 10% estimate. A call that reports the real count replaces either.
  risk_structure: boolean;           // multiply by Rasul's structure_factor (0.5-2.0: trees, neighbors, construction)
  threat_boost: number;              // threat = 1 + threat_boost x urgency: the fire can raise a score up to (1 + this) times
  // People in high-risk buildings leave on their own more slowly (both runs; the true simulated people). By the rank
  // of Rasul's static risk_score: lowest rank leaves leave_fast_low x faster, the middle at the base rates, the
  // highest leave_slow_high x slower (smooth in between). Buildings with no score keep the base rates.
  leave_by_risk: boolean;
  leave_fast_low: number;
  leave_slow_high: number;
  match_rule: "rate" | "fleet" | "priority";  // AI: "rate" = people helped per minute of truck time (greedy);
                                              // "fleet" = whole-fleet assignment by people a crew can help (CONTRACTS phase 4, #80);
                                              // "priority" = most urgent first
  duration_min: number;
  // 911 calls (both runs get the same calls; only "calls" depends on them to send a truck)
  call_share: number;               // share of buildings with people who need help where someone calls 911
  call_lead_min: [number, number];  // they call this many minutes before the fire reaches them (uniform)
  call_takers: number;              // 911 call-takers working these calls
  call_handle_min: number;          // minutes to take one call
  seed: number;
}

export interface Call { id: number; building: string; t_call: number; t_answer: number; t_dispatch: number | null;
                        truck: string | null; from: "911" | "supervisor" }

export const DEFAULT_CONFIG: SimConfig = {
  self_evac_rate_per_min: 0.15,
  need_alone_rate_per_min: 0.01,
  walk_m_per_min: { able: 80, need: 30 },
  assisted_people_per_min: 1.5,
  truck_speed_kmh: 30,
  rematch_every_min: 5,
  arrive_before_fire_min: 3,
  withdraw_before_fire_min: 3,
  urgency_tau_min: 30,
  priority_rule: "risk",
  risk_people: "rasul",
  risk_structure: false,
  threat_boost: 9,
  leave_by_risk: true,
  leave_fast_low: 1.5,
  leave_slow_high: 3,
  match_rule: "rate",
  duration_min: 180,
  call_share: 0.7,
  call_lead_min: [10, 60],
  call_takers: 4,
  call_handle_min: 2.5,
  seed: 7,
};

function rng(seed: number) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; };
}

export interface DemoBuildingLite {
  id: string; lat: number; lng: number;
  people_est: number; people_need_help_est: number; fire_arrival_min: number | null;
  units?: number | null; height_m?: number;
  /** Rasul's static score, joined by location (data/pipeline/join_risk.py). Missing = no match in Supabase. */
  risk?: { score: number | null; people: number | null; structure: number | null; source: string } | null;
  costar?: null | { name: string; address: string; stories: number | null; manager: { company: string | null; phone: string | null } };
}
export interface StationLite { id: string; name: string; number: number; lat: number; lng: number; node: number }

export type TruckStatus = "idle" | "en_route" | "on_scene" | "unavailable";
export interface Truck {
  id: string; name: string; station: number; status: TruckStatus;
  lng: number; lat: number;
  building: string | null; eta_min: number | null; reason: string;
  // route
  path: number[];       // node ids; path[0] may be a virtual start (-1) at [startLng, startLat]
  cum: number[];        // cumulative meters along path
  pos_m: number;        // meters travelled along path
  startLng: number; startLat: number;
  node: number;         // last road node reached (routing source)
  unavailable_until: number;
  served: number;       // people this crew brought out
}

export interface SimBuilding {
  id: string; idx: number; lat: number; lng: number; node: number; fire: number;   // fire = Infinity if never
  label: string; costar: boolean;
  able: number;        // people inside who can leave alone (true value)
  need: number;        // people inside who need help (true value)
  needKnown: number;   // what dispatch believes (estimate; a call can raise it)
  /** Ranking weight on needKnown: Rasul's people_at_risk / our estimate (1 = estimate, or a call confirmed the count). */
  rankScale: number;
  structure: number;   // Rasul's structure_factor (1 when unknown)
  riskStatic: number | null;  // Rasul's risk_score (null = no score: people not known or no match)
  riskSource: string;  // where the people count comes from: CoStar, Assessor, estimate, call
  leaveF: number;      // leaving-rate factor from the static risk rank (1 = base rates; < 1 = slower)
  hidden: number;      // people needing help that only a call reveals
  stuck: number;       // people who cannot leave alone at all (a call reports them)
  evacuated: number; evacuatedNeed: number; trapped: number; trappedNeed: number;
  burned: boolean;
  /** Last minute people can start walking out and still reach a safe street before the fire (per walking speed). */
  safeAble: number; safeNeed: number;
}

export type LogKind = "assign" | "reassign" | "arrive" | "done" | "withdraw" | "unassign" | "call" | "event" | "burned";
export interface LogEntry {
  t: number; kind: LogKind; truck?: string; building?: string; text: string;
  speaker?: "Roll Call" | "Driver" | "Supervisor" | "Dispatcher";
}

export type AgentEvent =
  | { type: "driver_declines"; truck_id: string; reason: string; out_min: number }
  | { type: "tenant_stuck"; building_id: string; count: number; note: string }
  // people_remaining = people who still need help, as reported. 0 removes the building from the queue.
  // It changes what dispatch believes (needKnown), not the simulated people, like tenant_stuck.
  | { type: "building_cleared"; building_id: string; people_remaining: number; note: string };

export interface SimData { roads: RoadsJson; buildings: DemoBuildingLite[]; stations: StationLite[] }

const DT = 0.1;
export const mins = (m: number) => { const r = Math.max(1, Math.round(m)); return `${r} min`; }; // minutes per tick: fixed, so results do not depend on frame rate

export function buildingLabel(b: DemoBuildingLite): string {
  if (b.costar) return `${b.costar.name || b.costar.address}`;
  const kind = (b.units ?? 0) >= 5 ? "Apartments" : (b.units ?? 0) >= 2 ? "Multi-unit home" : "House";
  return `${kind} ${b.id.slice(0, 4).toUpperCase()}`;
}

export class Simulation {
  t = 0;
  readonly policy: Policy;
  readonly cfg: SimConfig;
  readonly g: RoadGraph;
  readonly buildings: SimBuilding[];
  readonly byId: Map<string, SimBuilding>;
  readonly trucks: Truck[];
  /** 911 calls, made at the start (same seed in both runs). pending = answered, waiting for a truck ("calls"). */
  calls: Call[] = [];
  private callsMade = false;
  private callPtr = 0;
  private pending: Call[] = [];
  log: LogEntry[] = [];
  /** building idx whose people numbers changed visibly since the last drain (for feature-state) */
  dirty = new Set<number>();
  private nextMatch = 0;
  private needRematch = true;   // full re-match (scheduled or after a call)
  private needFill = true;      // a truck became free: give idle trucks work, leave the others alone
  private dist: Float64Array[]; private prev: Int32Array[];
  private speedMpm: number;
  /** Optional hook: the console can veto or edit AI pairings before they apply. */
  approve?: (proposals: Proposal[]) => Proposal[];
  /** True when pairings wait for a dispatcher's approval (console "I approve each" mode). Used for call wording. */
  approvalRequired = false;
  /** Dispatcher holds: a truck locked to a building (or held out) is not re-matched by the AI. */
  locks = new Map<string, string | null>();
  /** Pairings the dispatcher rejected: "truck|building" -> sim minute until which the AI will not propose it again. */
  vetoes = new Map<string, number>();

  constructor(data: SimData | { g: RoadGraph; buildings: DemoBuildingLite[]; stations: StationLite[] },
              policy: Policy, cfg: Partial<SimConfig> = {}) {
    this.policy = policy;
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.g = "g" in data ? data.g : new RoadGraph(data.roads);
    this.speedMpm = (this.cfg.truck_speed_kmh * 1000) / 60;
    // Only buildings the fire reaches can trap anyone; the rest are never at risk in this scenario.
    this.buildings = data.buildings
      .filter(b => b.fire_arrival_min !== null && b.people_est > 0)
      .map((b, idx) => {
        const need = Math.min(b.people_need_help_est, b.people_est);
        return {
          id: b.id, idx, lat: b.lat, lng: b.lng, node: this.g.buildingNode[b.id] ?? -1,
          fire: b.fire_arrival_min as number, label: buildingLabel(b), costar: !!b.costar,
          able: b.people_est - need, need, needKnown: need, hidden: 0, stuck: 0,
          rankScale: this.cfg.risk_people === "rasul" && b.risk?.people != null && need > 0 ? b.risk.people / need : 1,
          structure: b.risk?.structure ?? 1, riskStatic: b.risk?.score ?? null,
          riskSource: this.cfg.risk_people === "rasul" && b.risk?.people != null ? b.risk.source : "estimate",
          leaveF: 1,
          evacuated: 0, evacuatedNeed: 0, trapped: 0, trappedNeed: 0, burned: false, safeAble: 0, safeNeed: 0,
        };
      });
    this.byId = new Map(this.buildings.map(b => [b.id, b]));
    if (this.cfg.leave_by_risk) {
      // rank r from 0 (lowest static risk) to 1 (highest); factor fast^(1-2r) below the middle, (1/slow)^(2r-1) above
      const scored = this.buildings.filter(b => b.riskStatic != null).sort((a, b) => a.riskStatic! - b.riskStatic! || (a.id < b.id ? -1 : 1));
      const n = scored.length;
      scored.forEach((b, i) => {
        const r = n > 1 ? i / (n - 1) : 0.5;
        b.leaveF = r < 0.5 ? Math.pow(this.cfg.leave_fast_low, 1 - 2 * r) : Math.pow(1 / this.cfg.leave_slow_high, 2 * r - 1);
      });
    }
    this.trucks = data.stations.map(st => ({
      id: `E${st.number}`, name: `Engine ${st.number}`, station: st.number, status: "idle" as TruckStatus,
      lng: this.g.lng[st.node], lat: this.g.lat[st.node],
      building: null, eta_min: null, reason: "", path: [], cum: [], pos_m: 0,
      startLng: this.g.lng[st.node], startLat: this.g.lat[st.node], node: st.node,
      unavailable_until: 0, served: 0,
    }));
    this.dist = this.trucks.map(() => new Float64Array(this.g.n));
    // For each building: the last minute to start walking out along its street route and stay ahead of the fire.
    const esc = this.g.escape(), fireT = this.g.fireTimes();
    for (const b of this.buildings) {
      let minA = b.fire, minN = b.fire, d = 0, px = b.lng, py = b.lat;
      for (let v = b.node, n = 0; v >= 0 && n < 600; v = esc[v], n++) {
        d += meters(px, py, this.g.lng[v], this.g.lat[v]); px = this.g.lng[v]; py = this.g.lat[v];
        minA = Math.min(minA, fireT[v] - d / this.cfg.walk_m_per_min.able);
        minN = Math.min(minN, fireT[v] - d / this.cfg.walk_m_per_min.need);
      }
      // 2-minute margin: street fire times come from the road graph, which is coarser than the 30 m fire grid
      b.safeAble = minA - 2; b.safeNeed = minN - 2;
    }
    this.prev = this.trucks.map(() => new Int32Array(this.g.n));
  }

  /** People who need help but that only a phone call reveals (a stuck tenant). Present in both runs. */
  addHiddenNeed(buildingId: string, count: number) {
    const b = this.byId.get(buildingId);
    if (!b) return;
    b.need += count; b.hidden += count; b.stuck += count;
  }

  get counts() {
    let inside = 0, need = 0, evacuated = 0, trapped = 0, trappedNeed = 0, total = 0;
    for (const b of this.buildings) {
      inside += b.able + b.need; need += b.need; evacuated += b.evacuated;
      trapped += b.trapped; trappedNeed += b.trappedNeed;
    }
    total = inside + evacuated + trapped;
    return { inside, need, evacuated, trapped, trappedNeed, total };
  }

  get done() { return this.t >= this.cfg.duration_min - 1e-9; }

  /** Advance to `targetMin` in fixed ticks. */
  advanceTo(targetMin: number) {
    const target = Math.min(targetMin, this.cfg.duration_min);
    while (this.t + DT <= target + 1e-9) this.tick();
  }

  private say(e: Omit<LogEntry, "t">) { this.log.push({ t: this.t, ...e }); }

  /** Who calls 911 and when; the queue at the call-takers gives each call its answer time. Deterministic. */
  private makeCalls() {
    this.callsMade = true;
    const r = rng(this.cfg.seed), [lo, hi] = this.cfg.call_lead_min;
    const raw: { b: SimBuilding; t: number }[] = [];
    for (const b of this.buildings) {
      const calls = r() < this.cfg.call_share, lead = lo + (hi - lo) * r();
      if (b.need >= 0.5 && calls) raw.push({ b, t: Math.max(0.5, b.fire - lead) });
    }
    raw.sort((a, b) => a.t - b.t || (a.b.id < b.b.id ? -1 : 1));
    const free = new Array(Math.max(1, this.cfg.call_takers)).fill(0);
    for (const { b, t } of raw) {
      let k = 0; for (let i = 1; i < free.length; i++) if (free[i] < free[k]) k = i;
      const start = Math.max(t, free[k]); free[k] = start + this.cfg.call_handle_min;
      this.calls.push({ id: this.calls.length, building: b.id, t_call: t, t_answer: start + this.cfg.call_handle_min,
                        t_dispatch: null, truck: null, from: "911" });
    }
    this.calls.sort((a, b) => a.t_answer - b.t_answer || a.id - b.id);
  }

  /** A supervisor's call goes into the same 911 queue in the "calls" run (scripted moment). */
  addCall(buildingId: string, from: Call["from"] = "supervisor") {
    if (!this.callsMade) this.makeCalls();
    const c: Call = { id: this.calls.length, building: buildingId, t_call: this.t, t_answer: this.t + this.cfg.call_handle_min,
                      t_dispatch: null, truck: null, from };
    this.calls.push(c);
    this.calls.sort((a, b) => a.t_answer - b.t_answer || a.id - b.id);
    this.callPtr = this.calls.findIndex(x => x.t_answer > this.t);
    if (this.callPtr < 0) this.callPtr = this.calls.length;
  }

  /** Calls whose truck is on the way but has not arrived yet (the phone stays, without shaking). */
  answeredWaiting(): Call[] {
    return this.calls.filter(c => c.t_dispatch !== null && c.truck !== null && (() => {
      const tr = this.trucks.find(x => x.id === c.truck)!, b = this.byId.get(c.building)!;
      return tr.building === c.building && tr.status === "en_route" && !b.burned && b.need >= 0.5; })());
  }

  /** Calls whose building still waits: rung, no truck yet, building not burned and not empty. */
  ringing(): Call[] {
    return this.calls.filter(c => c.t_call <= this.t && c.t_dispatch === null && (() => {
      const b = this.byId.get(c.building)!; return !b.burned && b.need >= 0.5; })());
  }

  private answerCalls() {
    while (this.callPtr < this.calls.length && this.calls[this.callPtr].t_answer <= this.t) {
      const c = this.calls[this.callPtr++];
      const b = this.byId.get(c.building)!;
      if (b.burned) continue;
      if (this.policy === "calls") {
        this.pending.push(c); this.needFill = true;
        this.say({ kind: "call", building: b.id, speaker: "Dispatcher",
          text: `911 call answered: ${b.label} needs help (waited ${mins(this.t - c.t_call)}). ${this.pending.length} calls waiting for a truck.` });
      } else if (this.policy === "ours") {
        // the caller tells dispatch how many people need help; Roll Call uses it like any other call
        if (b.need - b.needKnown >= 0.5) { b.needKnown = b.need; this.needRematch = true; }
        // the call confirms the count; the next regular re-plan (every 5 min) ranks with it. A full re-plan for every
        // answered call doubled the engine time and slowed playback; a count that goes UP still re-plans at once (above).
        if (b.rankScale !== 1) { b.rankScale = 1; b.riskSource = "call"; }
        c.t_dispatch = this.trucks.some(tr => tr.building === b.id) ? this.t : null;
      }
    }
  }

  /** Today's dispatch: oldest answered call first, closest free truck (by road), no re-planning. */
  private scratchD: Float64Array | null = null;
  private scratchP: Int32Array | null = null;
  private assignCalls() {
    const idle = new Map<number, number>();   // routing source node -> truck index
    this.trucks.forEach((tr, ti) => { if (tr.status === "idle") idle.set(this.source(tr).node, ti); });
    if (!idle.size || !this.pending.length) return;
    this.scratchD ??= new Float64Array(this.g.n); this.scratchP ??= new Int32Array(this.g.n);
    const keep: Call[] = [];
    for (const c of this.pending) {
      const b = this.byId.get(c.building)!;
      if (b.burned) continue;                       // the fire got there first: the call is closed
      if (!idle.size) { keep.push(c); continue; }
      // closest free truck = the first truck reached when searching the streets outward from the building
      const hit = this.g.dijkstra(b.node, this.t, this.scratchD, this.scratchP, Infinity, Infinity, 0, n => idle.has(n));
      if (hit < 0) { keep.push(c); continue; }
      const ti = idle.get(hit)!; idle.delete(hit);
      const tr = this.trucks[ti], src = this.source(tr);
      // the truck's own route, searched only until it reaches the building
      this.g.dijkstra(src.node, this.t, this.dist[ti], this.prev[ti], Infinity, this.speedMpm, src.offset, n => n === b.node);
      if (!Number.isFinite(this.dist[ti][b.node])) { keep.push(c); idle.set(hit, ti); continue; }
      c.t_dispatch = this.t; c.truck = tr.id;
      this.dispatch(tr, ti, b, src.offset, `911 call from ${mins(this.t - c.t_call)} ago; closest free truck.`);
    }
    this.pending = keep;
  }

  private tick() {
    const t0 = this.t, t1 = Math.round((this.t + DT) * 1000) / 1000;
    if (!this.callsMade) this.makeCalls();
    this.answerCalls();
    // dispatch first, so a truck freed in the last tick is used now
    if (this.policy === "calls") {
      if (this.needFill) { this.needFill = false; this.assignCalls(); }
    } else if (this.policy === "ours") {
      if (t0 >= this.nextMatch || this.needRematch) this.rematch(true);
      else if (this.needFill) this.rematch(false);
    } else if (this.needFill || Math.abs(t0 - Math.round(t0)) < 1e-6) {
      const changed = this.needFill; this.needFill = false;
      this.assignNearest(changed);
    }
    this.moveTrucks(DT);
    this.people(t0, t1);
    this.t = t1;
    for (const tr of this.trucks)
      if (tr.status === "unavailable" && tr.unavailable_until <= this.t) {
        tr.status = "idle"; this.needFill = true;
        this.say({ kind: "event", truck: tr.id, text: `${tr.name} is back in service.` });
      }
  }

  // ---------- people ----------
  private onScene(): Map<number, number> {
    const m = new Map<number, number>();
    for (const tr of this.trucks) if (tr.status === "on_scene" && tr.building) {
      const b = this.byId.get(tr.building)!; m.set(b.idx, (m.get(b.idx) ?? 0) + 1);
    }
    return m;
  }

  private people(t0: number, t1: number) {
    const crews = this.onScene();
    const selfRate = this.cfg.self_evac_rate_per_min * DT, aloneRate = this.cfg.need_alone_rate_per_min * DT;
    for (const b of this.buildings) {
      if (b.burned) continue;
      const before = Math.round(b.able + b.need);
      if (b.fire <= t1) {
        // the fire reaches the building in this tick: everyone still inside is trapped
        b.trapped += b.able + b.need; b.trappedNeed += b.need;
        b.able = 0; b.need = 0; b.needKnown = 0; b.burned = true; this.dirty.add(b.idx);
        continue;
      }
      // people only start walking out while they can still get ahead of the fire; after that they stay (trapped)
      // leaving alone, slowed (or sped up) by the building's static risk rank
      const a = t1 <= b.safeAble ? b.able * (1 - Math.exp(-selfRate * b.leaveF)) : 0;
      const canGo = t1 <= b.safeNeed;
      let h = canGo ? Math.max(0, b.need - b.stuck) * (1 - Math.exp(-aloneRate * b.leaveF)) : 0;
      const k = crews.get(b.idx) ?? 0;
      if (k > 0 && canGo) h += Math.min(b.need - h, k * this.cfg.assisted_people_per_min * DT);
      b.able -= a; b.need -= h; b.evacuated += a + h; b.evacuatedNeed += h;
      b.stuck = Math.min(b.stuck, b.need);
      b.needKnown = Math.min(b.needKnown, b.need);
      if (k > 0) {
        for (const tr of this.trucks) if (tr.status === "on_scene" && tr.building === b.id) tr.served += h / k;
      }
      if (b.need < 1e-6) b.need = 0;
      // any departure marks the building: the map creates walker dots the moment people leave (not later)
      if (a + h > 0 || Math.round(b.able + b.need) !== before) this.dirty.add(b.idx);
    }
  }

  // ---------- trucks ----------
  private moveTrucks(dt: number) {
    for (const tr of this.trucks) {
      if (tr.status === "en_route") {
        tr.pos_m += this.speedMpm * dt;
        const total = tr.cum[tr.cum.length - 1];
        if (tr.pos_m >= total) {
          tr.pos_m = total;
          const last = tr.path[tr.path.length - 1];
          tr.node = last; tr.lng = this.g.lng[last]; tr.lat = this.g.lat[last];
          const b = this.byId.get(tr.building!)!;
          if (b.burned || b.need < 0.05) {
            this.say({ kind: "done", truck: tr.id, building: b.id,
              text: `${tr.name} reached ${b.label}: ${b.burned ? "fire already there" : "nobody left who needs help"}.` });
            this.free(tr);
          } else {
            tr.status = "on_scene"; tr.eta_min = 0;
            this.say({ kind: "arrive", truck: tr.id, building: b.id,
              text: `${tr.name} on scene at ${b.label}: ${Math.round(b.need)} people need help.` });
          }
        } else this.placeOnPath(tr);
      } else if (tr.status === "on_scene") {
        const b = this.byId.get(tr.building!)!;
        if (b.need < 0.05) {
          this.say({ kind: "done", truck: tr.id, building: b.id, text: `${tr.name} cleared ${b.label}.` });
          this.free(tr);
        } else if (b.fire - this.t <= this.cfg.withdraw_before_fire_min || this.t >= b.safeNeed) {
          this.say({ kind: "withdraw", truck: tr.id, building: b.id,
            text: `${tr.name} pulls out of ${b.label}: fire arriving, ${Math.round(b.need)} still inside.` });
          this.free(tr);
        }
      }
    }
  }

  private free(tr: Truck) {
    tr.status = "idle"; tr.building = null; tr.eta_min = null; tr.path = []; tr.cum = []; tr.pos_m = 0;
    tr.startLng = tr.lng; tr.startLat = tr.lat;
    this.needFill = true;
  }

  private placeOnPath(tr: Truck) {
    let i = 1;
    while (i < tr.cum.length - 1 && tr.cum[i] < tr.pos_m) i++;
    const a = tr.path[i - 1], b = tr.path[i];
    const aLng = a < 0 ? tr.startLng : this.g.lng[a], aLat = a < 0 ? tr.startLat : this.g.lat[a];
    const seg = tr.cum[i] - tr.cum[i - 1];
    const f = seg > 0 ? (tr.pos_m - tr.cum[i - 1]) / seg : 1;
    tr.lng = aLng + (this.g.lng[b] - aLng) * f; tr.lat = aLat + (this.g.lat[b] - aLat) * f;
    tr.node = f > 0.5 || a < 0 ? b : a;
  }

  /** Routing source for a truck: the next node on its current path (it finishes its current street segment). */
  private source(tr: Truck): { node: number; offset: number } {
    if (tr.status !== "en_route" || tr.path.length < 2) return { node: tr.node, offset: meters(tr.lng, tr.lat, this.g.lng[tr.node], this.g.lat[tr.node]) };
    let i = 1;
    while (i < tr.cum.length - 1 && tr.cum[i] < tr.pos_m) i++;
    return { node: tr.path[i], offset: tr.cum[i] - tr.pos_m };
  }

  private route(tr: Truck, ti: number, b: SimBuilding, offset: number) {
    const nodes = this.g.path(this.prev[ti], this.dist[ti], b.node)!;
    tr.startLng = tr.lng; tr.startLat = tr.lat;
    tr.path = [-1, ...nodes];
    tr.cum = [0, offset];
    for (let i = 2; i < tr.path.length; i++) {
      const p = tr.path[i - 1], q = tr.path[i];
      tr.cum.push(tr.cum[i - 1] + meters(this.g.lng[p], this.g.lat[p], this.g.lng[q], this.g.lat[q]));
    }
    // last leg: road node to the building door
    tr.path.push(tr.path[tr.path.length - 1]);
    tr.cum.push(tr.cum[tr.cum.length - 1]);
    tr.pos_m = 0;
  }

  private dispatch(tr: Truck, ti: number, b: SimBuilding, offset: number, reason: string) {
    const prev = tr.building;
    this.route(tr, ti, b, offset);
    tr.building = b.id; tr.status = "en_route"; tr.reason = reason;
    tr.eta_min = (this.dist[ti][b.node] + offset) / this.speedMpm;
    const eta = mins(tr.eta_min);
    const left = mins(b.fire - this.t);
    if (prev && prev !== b.id) {
      const pb = this.byId.get(prev)!;
      this.say({ kind: "reassign", truck: tr.id, building: b.id,
        text: `${tr.name}: ${pb.label} → ${b.label} (ETA ${eta}, fire in ${left}). ${reason}` });
    } else if (!prev) {
      this.say({ kind: "assign", truck: tr.id, building: b.id,
        text: `${tr.name} → ${b.label} (ETA ${eta}, fire in ${left}). ${reason}` });
    }
  }

  // ---------- old way: nearest building that needs help, never re-plan ----------
  private idleNoWork = new Set<string>();   // idle trucks that found nothing; they search again when something changes
  private assignNearest(changed: boolean) {
    if (changed) this.idleNoWork.clear();
    const targeted = new Set(this.trucks.map(t => t.building).filter(Boolean) as string[]);
    // road node -> first building (in list order) there that needs help and has no truck
    const atNode = new Map<number, SimBuilding>();
    for (const b of this.buildings)
      if (!b.burned && b.needKnown > 0.5 && !targeted.has(b.id) && b.node >= 0 && !atNode.has(b.node)) atNode.set(b.node, b);
    this.trucks.forEach((tr, ti) => {
      if (tr.status !== "idle" || this.idleNoWork.has(tr.id)) return;
      const src = this.source(tr);
      // the search stops at the first road node with a building that needs help: that is the nearest one
      const hit = this.g.dijkstra(src.node, this.t, this.dist[ti], this.prev[ti], 40000, this.speedMpm, src.offset, n => atNode.has(n));
      const best = hit >= 0 ? atNode.get(hit)! : null;
      if (!best) { this.idleNoWork.add(tr.id); return; }
      targeted.add(best.id);
      atNode.delete(best.node);
      for (const b of this.buildings)   // another building at the same node may still need a truck
        if (b.node === best.node && b !== best && !b.burned && b.needKnown > 0.5 && !targeted.has(b.id)) { atNode.set(b.node, b); break; }
      this.dispatch(tr, ti, best, src.offset, "Nearest building that needs help.");
    });
  }

  /** Latest useful arrival: before the fire (with margin), and early enough to walk people out to safety. */
  deadline(b: SimBuilding): number {
    return Math.min(b.fire - this.cfg.arrive_before_fire_min, b.safeNeed - 1);
  }

  // ---------- AI: people needing help x urgency, feasible before the fire, re-match ----------
  priority(b: SimBuilding): number {
    // same number as riskOf(b).risk, without making an object (the matcher calls this ~100k times per re-plan)
    const u = 1 / (1 + Math.max(0, b.fire - this.t) / this.cfg.urgency_tau_min);
    return b.needKnown * b.rankScale * (this.cfg.risk_structure ? b.structure : 1)
      * (this.cfg.priority_rule === "risk" ? 1 + this.cfg.threat_boost * u : u);
  }

  /** Dynamic risk score of one building now (an agent tool: the ranking behind every AI pairing).
   *  risk = people x structure x time term. people = what dispatch believes, scaled to Rasul's people_at_risk until a
   *  call confirms the count. threat goes from 1 (fire far) to 2 (fire here): risk is Rasul's score raised by the fire. */
  riskOf(b: SimBuilding): { risk: number; people: number; structure: number; threat: number; minutes_left: number; source: string } {
    const left = Math.max(0, b.fire - this.t), u = 1 / (1 + left / this.cfg.urgency_tau_min);
    const people = b.needKnown * b.rankScale, structure = this.cfg.risk_structure ? b.structure : 1;
    const threat = this.cfg.priority_rule === "risk" ? 1 + this.cfg.threat_boost * u : u;
    return { risk: people * structure * threat, people, structure, threat, minutes_left: left, source: b.riskSource };
  }

  /** All buildings that still need help, highest dynamic risk first (agent tool "risk_scores"). */
  riskScores(): { id: string; label: string; static_score: number | null; risk: number; people: number; structure: number;
                  threat: number; minutes_left: number; source: string }[] {
    return this.buildings.filter(b => !b.burned && b.needKnown > 0.5)
      .map(b => ({ id: b.id, label: b.label, static_score: b.riskStatic, ...this.riskOf(b) }))
      .sort((a, b) => b.risk - a.risk || (a.id < b.id ? -1 : 1));
  }

  /** full = every idle or driving truck may get a new building; otherwise only idle trucks are matched. */
  rematch(full = true) {
    if (full) { this.nextMatch = this.t + this.cfg.rematch_every_min; this.needRematch = false; }
    this.needFill = false;
    const free = this.trucks.map((tr, ti) => ({ tr, ti })).filter(({ tr }) =>
      (tr.status === "idle" || (full && tr.status === "en_route")) && !this.locks.has(tr.id));
    if (!free.length) return;
    const srcs = free.map(({ tr, ti }) => {
      const s = this.source(tr);
      this.g.dijkstra(s.node, this.t, this.dist[ti], this.prev[ti], this.speedMpm * 20, this.speedMpm, s.offset);  // search up to 20 min of driving: in our runs this gives the same pairings as no limit, and it is cheaper
      return s;
    });
    const covered = new Set<string>();
    for (const tr of this.trucks)
      if ((tr.status === "on_scene" || this.locks.has(tr.id) || (!full && tr.status === "en_route")) && tr.building) covered.add(tr.building);
    const cands = this.buildings
      .filter(b => !b.burned && b.needKnown > 0.5 && b.node >= 0 && !covered.has(b.id))
      .sort((a, b) => this.priority(b) - this.priority(a) || (a.id < b.id ? -1 : 1));
    const open = new Set(free.map((_, i) => i));
    const proposals: Proposal[] = [];
    // raw road ETA (minutes); Infinity if vetoed or unreachable. The keep bonus is applied only AFTER the deadline check.
    const etaOf = (i: number, b: SimBuilding) => {
      const { tr, ti } = free[i];
      if ((this.vetoes.get(`${tr.id}|${b.id}`) ?? -1) > this.t) return Infinity;
      return (this.dist[ti][b.node] + srcs[i].offset) / this.speedMpm;
    };
    const keep = (i: number, b: SimBuilding) => (free[i].tr.building === b.id ? 3 : 0); // minutes of preference, less churn
    const propose = (i: number, b: SimBuilding, eta: number) => {
      open.delete(i);
      const { tr } = free[i];
      proposals.push({ truck: tr.id, building: b.id, eta_min: Math.max(0, eta),
        reason: `${Math.round(b.needKnown)} need help.`, prev: tr.building });
    };
    const inTime = (b: SimBuilding, eta: number) => this.t + eta <= this.deadline(b);
    if (this.cfg.match_rule === "fleet") {
      this.fleetMatch(free, srcs, full, proposals, open);
    } else if (this.cfg.match_rule === "rate") {
      // Pick the truck-building pair that helps the most people per minute of truck time, then the next, and so on.
      // value = people needing help x urgency / (drive time + time on scene + 1)
      const left = new Set(cands);
      const prio = new Map(cands.map(b => [b, this.priority(b)]));   // fixed during one re-plan
      while (open.size && left.size) {
        let best: { i: number; b: SimBuilding; eta: number; v: number } | null = null;
        for (const i of open) for (const b of left) {
          const eta = etaOf(i, b);
          if (!inTime(b, eta)) continue;
          const v = prio.get(b)! / (Math.max(0, eta - keep(i, b)) + b.needKnown / this.cfg.assisted_people_per_min + 1);
          if (!best || v > best.v || (v === best.v && b.id < best.b.id)) best = { i, b, eta, v };
        }
        if (!best) break;
        left.delete(best.b);
        propose(best.i, best.b, best.eta);
      }
    } else {
      // "priority": most urgent building first, nearest truck that can arrive before the fire
      for (const b of cands) {
        if (!open.size) break;
        let bestI = -1, bestEta = Infinity;
        for (const i of open) { const eta = etaOf(i, b); if (inTime(b, eta) && eta - keep(i, b) < bestEta - (bestI >= 0 ? keep(bestI, b) : 0)) { bestEta = eta; bestI = i; } }
        if (bestI < 0) continue; // nobody can arrive in time
        propose(bestI, b, bestEta);
      }
    }
    const final = this.approve ? this.approve(proposals) : proposals;
    const chosen = new Set(final.map(p => p.truck));
    for (const p of final) {
      const i = free.findIndex(f => f.tr.id === p.truck);
      if (i < 0) continue;
      const { tr, ti } = free[i];
      const b = this.byId.get(p.building)!;
      if (tr.building === b.id) continue;
      if (!Number.isFinite(this.dist[ti][b.node])) continue;
      this.dispatch(tr, ti, b, srcs[i].offset, p.reason);
    }
    // en-route trucks with no useful target left stop where they are
    for (const { tr } of free) if (tr.status === "en_route" && !chosen.has(tr.id)) {
      const b = this.byId.get(tr.building!)!;
      if (b.burned || b.needKnown <= 0.5 || this.t > this.deadline(b)) {
        const why = b.needKnown <= 0.5 && !b.burned ? "nobody left who needs help" : "cannot arrive before the fire";
        this.say({ kind: "unassign", truck: tr.id, building: b.id, text: `${tr.name} called off ${b.label}: ${why}.` });
        this.free(tr);
      }
    }
  }

  /** Rule "fleet" (CONTRACTS phase 4, Rasul's PR #80): whole-fleet assignment. A column is one crew slot at a building
   *  (slot 0 = first crew there, 1 = second, ...). Value of a truck in a slot = people that crew can still help between
   *  arrival and withdrawal, minus what earlier crews there help. Checks: a route that avoids burning streets, the real
   *  ETA against the fire deadline, then the keep-assignment bonus. Idle trucks then check buildings nobody can reach. */
  private fleetMatch(free: { tr: Truck; ti: number }[], srcs: { node: number; offset: number }[], full: boolean,
                     proposals: Proposal[], open: Set<number>) {
    const crews = new Map<string, number>();
    for (const tr of this.trucks)
      if ((tr.status === "on_scene" || this.locks.has(tr.id) || (!full && tr.status === "en_route")) && tr.building)
        crews.set(tr.building, (crews.get(tr.building) ?? 0) + 1);
    const cands = this.buildings.filter(b => !b.burned && b.needKnown > 0.5 && b.node >= 0);
    const eta = (i: number, b: SimBuilding) => (this.dist[free[i].ti][b.node] + srcs[i].offset) / this.speedMpm;
    const rate = this.cfg.assisted_people_per_min;
    const cols: { b: SimBuilding; slot: number }[] = [];
    const val: number[][] = free.map(() => []);
    for (const b of cands) {
      const have = crews.get(b.id) ?? 0;
      for (let slot = have; slot < have + free.length; slot++) {
        const row = free.map(({ tr }, i) => {
          if ((this.vetoes.get(`${tr.id}|${b.id}`) ?? -1) > this.t) return 0;
          const e = eta(i, b);
          if (!Number.isFinite(e) || this.t + e > this.deadline(b)) return 0;
          const cap = rate * Math.max(0, Math.min(b.fire - this.cfg.withdraw_before_fire_min, b.safeNeed) - this.t - e);
          const people = Math.min(cap, Math.max(0, b.needKnown - slot * cap));
          if (people < 0.5) return 0;
          const keepBonus = tr.building === b.id ? rate * 3 : 0;
          return people + keepBonus + 1e-3 * this.priority(b);   // priority only breaks ties
        });
        if (row.every(v => v === 0)) break;
        cols.push({ b, slot });
        row.forEach((v, i) => val[i].push(v));
      }
    }
    const pick = assignMax(val, cols.length);
    const targeted = new Set(crews.keys());
    pick.forEach((c, i) => {
      if (c < 0 || val[i][c] <= 0) return;
      const { b, slot } = cols[c];
      const { tr } = free[i];
      targeted.add(b.id); open.delete(i);
      proposals.push({ truck: tr.id, building: b.id, eta_min: Math.max(0, eta(i, b)), prev: tr.building,
        reason: `${Math.round(b.needKnown)} need help${slot > 0 ? ` (crew ${slot + 1} there)` : ""}.` });
    });
    const late = cands.filter(b => !targeted.has(b.id))
      .sort((a, b) => this.priority(b) - this.priority(a) || (a.id < b.id ? -1 : 1));
    for (const i of [...open]) {
      const { tr } = free[i];
      const b = late.find(x => !targeted.has(x.id) && Number.isFinite(eta(i, x))
        && (this.vetoes.get(`${tr.id}|${x.id}`) ?? -1) <= this.t);
      if (!b) continue;
      targeted.add(b.id); open.delete(i);
      proposals.push({ truck: tr.id, building: b.id, eta_min: Math.max(0, eta(i, b)), prev: tr.building,
        reason: `Check, not a rescue: cannot arrive before the fire; ${Math.round(b.needKnown)} may be inside.` });
    }
  }

  // ---------- dispatcher actions (console) ----------
  /** Send a truck to a building now (an approved or edited proposal). Returns false if it is not possible. */
  applyProposal(p: { truck: string; building: string; reason: string }): boolean {
    const ti = this.trucks.findIndex(x => x.id === p.truck);
    const tr = this.trucks[ti], b = this.byId.get(p.building);
    if (!tr || !b || b.burned || tr.status === "unavailable" || b.node < 0) return false;
    if (tr.status === "on_scene" && tr.building !== b.id) {
      this.say({ kind: "unassign", truck: tr.id, building: tr.building!, text: `${tr.name} leaves ${this.byId.get(tr.building!)!.label} (dispatcher).` });
      tr.status = "idle";
    }
    if (tr.building === b.id) return true;
    const src = this.source(tr);
    this.g.dijkstra(src.node, this.t, this.dist[ti], this.prev[ti], Infinity, this.speedMpm, src.offset);
    if (!Number.isFinite(this.dist[ti][b.node])) return false;
    this.dispatch(tr, ti, b, src.offset, p.reason);
    return true;
  }

  outOfService(truckId: string, minutes: number, why: string) {
    const tr = this.trucks.find(x => x.id === truckId);
    if (!tr) return;
    this.say({ kind: "event", truck: tr.id, speaker: "Dispatcher", text: `${tr.name} out of service${minutes < 999 ? ` for ${minutes} min` : ""}: ${why}` });
    this.applyEvent({ type: "driver_declines", truck_id: truckId, reason: why, out_min: minutes });
  }

  backInService(truckId: string) {
    const tr = this.trucks.find(x => x.id === truckId);
    if (!tr || tr.status !== "unavailable") return;
    tr.unavailable_until = this.t;
  }

  /** Take a truck off its building (dispatcher undo); the AI may give it new work at the next match. */
  release(truckId: string) {
    const tr = this.trucks.find(x => x.id === truckId);
    if (tr && (tr.status === "en_route" || tr.status === "on_scene")) this.free(tr);
  }

  veto(truckId: string, buildingId: string, minutes = 10) {
    this.vetoes.set(`${truckId}|${buildingId}`, this.t + minutes);
  }

  // ---------- agent events ----------
  applyEvent(ev: AgentEvent) {
    if (ev.type === "driver_declines") {
      const tr = this.trucks.find(t => t.id === ev.truck_id);
      if (!tr) return;
      tr.status = "unavailable"; tr.unavailable_until = this.t + ev.out_min;
      tr.building = null; tr.eta_min = null; tr.path = []; tr.cum = [];
      tr.startLng = tr.lng; tr.startLat = tr.lat;
    } else if (ev.type === "building_cleared") {
      const b = this.byId.get(ev.building_id);
      if (!b || b.burned) return;
      b.needKnown = Math.min(b.need, Math.max(0, ev.people_remaining));
      b.rankScale = 1; b.riskSource = "call";   // a call gives the count: the ranking uses it as is
    } else {
      const b = this.byId.get(ev.building_id);
      if (!b || b.burned) return;
      const reveal = Math.min(ev.count, b.hidden);
      b.hidden -= reveal;
      b.needKnown = Math.min(b.need, b.needKnown + ev.count);
      b.rankScale = 1; b.riskSource = "call";   // a call gives the count: the ranking uses it as is
    }
    this.needRematch = true;
  }
}

export interface Proposal { truck: string; building: string; eta_min: number; reason: string; prev: string | null }

/** Rectangular assignment that maximizes total value (Hungarian method, O(rows^2 x cols)). From PR #80 (Rasul).
 *  `val[r][c]` >= 0; returns the column for each row, or -1. A row may stay unassigned (value 0). */
export function assignMax(val: number[][], m: number): number[] {
  const n = val.length;
  const out = new Array<number>(n).fill(-1);
  if (!n || !m) return out;
  const M = m + n;                                   // n extra "idle" columns with value 0
  const cost = (r: number, c: number) => (c < m ? -val[r][c] : 0);
  const u = new Float64Array(n + 1), v = new Float64Array(M + 1);
  const p = new Int32Array(M + 1), way = new Int32Array(M + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0;
    const minv = new Float64Array(M + 1).fill(Infinity), used = new Uint8Array(M + 1);
    do {
      used[j0] = 1; const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= M; j++) if (!used[j]) {
        const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= M; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  for (let j = 1; j <= M; j++) if (p[j] && j <= m) out[p[j] - 1] = j - 1;
  return out;
}
