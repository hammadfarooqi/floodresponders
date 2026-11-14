export type Policy = "ours" | "nearest";

export interface BuildingInput {
  id: string;
  lat: number;
  lng: number;
  people_est: number;
  people_need_help_est: number;
  fire_arrival_min: number | null;
}

export interface Truck {
  id: string;
  station_id: string;
  lat: number;
  lng: number;
  status: "idle" | "en_route" | "on_scene" | "unavailable";
  building_id: string | null;
}

export interface Assignment {
  truck_id: string;
  building_id: string;
  eta_min: number;
  reason: string;
}

export interface SimConfig {
  seed: number;
  self_evac_rate_per_min: number;
  assisted_evac_rate_per_min: number;
  rematch_every_min: number;
  truck_speed_kmh: number;
}

export type AgentEvent =
  | { type: "driver_declines"; truck_id: string; building_id: string; reason: string }
  | { type: "tenant_stuck"; building_id: string; count: number; note: string };

interface Building extends BuildingInput {
  inside: number;
  needsHelp: number;
  trapped: number;
  selfCredit: number;
  helpCredit: number;
}

interface SimulationTruck extends Truck {
  arrival: number | null;
}

export interface MatchState {
  now_min: number;
  buildings: BuildingInput[];
  trucks: Truck[];
  truck_speed_kmh: number;
}

export type Match = (state: MatchState, policy: Policy) =>
  readonly Assignment[] | Promise<readonly Assignment[]>;

// Fixed ticks keep outcomes independent of frame rate or playback speed.
const TICK_MIN = 1;
const HELP_SPEED = 0.25;

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export class Simulation {
  private buildings: Map<string, Building>;
  private trucks: Map<string, SimulationTruck>;
  private minute = 0;
  private nextMatch = 0;
  private pending = Promise.resolve();
  private total: number;
  private readonly config: SimConfig;
  private readonly policy: Policy;
  private readonly match: Match;
  readonly durationMin: number;

  constructor(
    buildings: readonly BuildingInput[],
    trucks: readonly Truck[],
    config: SimConfig,
    policy: Policy,
    match: Match,
    durationMin: number,
  ) {
    if (!Number.isFinite(durationMin) || durationMin < 0 ||
        !Number.isInteger(config.rematch_every_min) || config.rematch_every_min < 1 ||
        ![config.self_evac_rate_per_min, config.assisted_evac_rate_per_min]
          .every(rate => Number.isFinite(rate) && rate >= 0)) {
      throw new RangeError("Invalid simulation duration or evacuation rates");
    }

    this.config = { ...config };
    this.policy = policy;
    this.match = match;
    this.durationMin = durationMin;
    const random = seededRandom(config.seed);
    this.buildings = new Map(buildings.map(building => [building.id, {
      ...building,
      inside: building.people_est,
      needsHelp: Math.min(building.people_need_help_est, building.people_est),
      trapped: 0,
      selfCredit: random(),
      helpCredit: random(),
    }]));
    this.trucks = new Map(trucks.map(truck => [truck.id, { ...truck, arrival: null }]));
    this.total = buildings.reduce((total, building) => total + building.people_est, 0);
    this.updateLocations();
  }

  snapshot() {
    const buildings = [...this.buildings.values()].map(building => ({
      id: building.id,
      inside: building.inside,
      needsHelp: building.needsHelp,
      trapped: building.trapped,
      evacuated: building.people_est - building.inside - building.trapped,
    }));
    const inside = buildings.reduce((count, building) => count + building.inside, 0);
    const trapped = buildings.reduce((count, building) => count + building.trapped, 0);
    return {
      minute: this.minute,
      done: this.minute >= this.durationMin,
      buildings,
      trucks: this.matchState().trucks,
      counts: { inside, trapped, evacuated: this.total - inside - trapped },
    };
  }

  advanceTo(targetMin: number): Promise<void> {
    return this.enqueue(async () => {
      if (!Number.isFinite(targetMin)) throw new RangeError("Invalid target minute");
      const target = Math.min(targetMin, this.durationMin);
      if (this.minute >= this.nextMatch) await this.rematch();
      while (this.minute < target) {
        const end = Math.min(this.minute + TICK_MIN, this.durationMin);
        if (end > target) break;
        this.evacuate(end);
        this.minute = end;
        this.updateLocations();
        if (this.minute >= this.nextMatch && this.minute < this.durationMin) await this.rematch();
      }
    });
  }

  applyEvent(event: AgentEvent): Promise<void> {
    return this.enqueue(async () => {
      if (event.type === "driver_declines") {
        const truck = this.trucks.get(event.truck_id);
        if (truck?.building_id !== event.building_id) return;
        truck.status = "unavailable";
        truck.building_id = null;
        truck.arrival = null;
      } else {
        const building = this.buildings.get(event.building_id);
        if (!building || building.inside === 0) return;
        building.needsHelp = Math.min(building.inside, Math.max(building.needsHelp, event.count));
      }
      if (this.policy === "ours") await this.rematch();
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  private matchState(): MatchState {
    return {
      now_min: this.minute,
      buildings: [...this.buildings.values()].map(building => ({
        id: building.id,
        lat: building.lat,
        lng: building.lng,
        people_est: building.inside,
        people_need_help_est: building.needsHelp,
        fire_arrival_min: building.fire_arrival_min,
      })),
      trucks: [...this.trucks.values()].map(truck => ({
        id: truck.id,
        station_id: truck.station_id,
        lat: truck.lat,
        lng: truck.lng,
        status: truck.status,
        building_id: truck.building_id,
      })),
      truck_speed_kmh: this.config.truck_speed_kmh,
    };
  }

  private async rematch() {
    const assignments = await this.match(this.matchState(), this.policy);
    const reserved = new Set([...this.trucks.values()]
      .filter(truck => truck.status === "on_scene" ||
        (this.policy === "nearest" && truck.status === "en_route"))
      .map(truck => truck.building_id));
    const targets = new Map<string, Assignment>();
    for (const assignment of assignments) {
      const truck = this.trucks.get(assignment.truck_id);
      const building = this.buildings.get(assignment.building_id);
      if (!truck || !building?.needsHelp || reserved.has(building.id) ||
          targets.has(truck.id) || !Number.isFinite(assignment.eta_min) ||
          assignment.eta_min < 0 || truck.status === "unavailable" ||
          truck.status === "on_scene" ||
          (this.policy === "nearest" && truck.status !== "idle")) continue;

      reserved.add(building.id);
      targets.set(truck.id, assignment);
    }

    for (const truck of this.trucks.values()) {
      const assignment = targets.get(truck.id);
      if (assignment && truck.building_id !== assignment.building_id) {
        truck.building_id = assignment.building_id;
        truck.arrival = this.minute + assignment.eta_min;
        truck.status = "en_route";
      } else if (!assignment && this.policy === "ours" && truck.status === "en_route") {
        truck.building_id = null;
        truck.arrival = null;
        truck.status = "idle";
      }
    }
    this.nextMatch = this.minute + this.config.rematch_every_min;
    this.updateLocations();
  }

  private evacuate(end: number) {
    const truckArrival = new Map<string, number>();
    for (const truck of this.trucks.values()) {
      if (truck.building_id === null) continue;
      if (truck.status === "on_scene") truckArrival.set(truck.building_id, this.minute);
      if (truck.status === "en_route" && truck.arrival !== null) {
        truckArrival.set(truck.building_id, truck.arrival);
      }
    }
    for (const building of this.buildings.values()) {
      if (building.inside === 0) continue;
      const cutoff = Math.min(end, building.fire_arrival_min ?? end);
      const elapsed = cutoff - this.minute;
      const arrival = truckArrival.get(building.id) ?? Infinity;
      const assisted = Math.max(0, cutoff - Math.max(this.minute, arrival));
      const selfRate = this.config.self_evac_rate_per_min;
      const assistRate = Math.max(selfRate, this.config.assisted_evac_rate_per_min);

      building.selfCredit += (elapsed - assisted) * selfRate + assisted * assistRate;
      building.helpCredit += (elapsed - assisted) * selfRate * HELP_SPEED + assisted * assistRate;
      const self = Math.min(building.inside - building.needsHelp, Math.floor(building.selfCredit));
      const help = Math.min(building.needsHelp, Math.floor(building.helpCredit));
      building.selfCredit -= Math.floor(building.selfCredit);
      building.helpCredit -= Math.floor(building.helpCredit);
      building.inside -= self + help;
      building.needsHelp -= help;

      if (building.fire_arrival_min !== null && end >= building.fire_arrival_min) {
        building.trapped += building.inside;
        building.inside = 0;
        building.needsHelp = 0;
      }
    }
  }

  private updateLocations() {
    for (const building of this.buildings.values()) {
      if (building.fire_arrival_min !== null && building.fire_arrival_min <= this.minute) {
        building.trapped += building.inside;
        building.inside = 0;
        building.needsHelp = 0;
      }
    }
    for (const truck of this.trucks.values()) {
      if (truck.building_id === null) continue;
      const building = this.buildings.get(truck.building_id);
      const isArriving = truck.arrival !== null && truck.arrival <= this.minute;
      if (building && truck.status === "en_route" && isArriving) {
        truck.status = "on_scene";
        truck.lat = building.lat;
        truck.lng = building.lng;
        truck.arrival = null;
      }
      if (!building?.inside && (truck.status === "on_scene" || truck.status === "en_route")) {
        truck.status = "idle";
        truck.building_id = null;
        truck.arrival = null;
      }
    }
  }
}

// Drive the fixed simulation clock with requestAnimationFrame and real timestamps.
export class Playback {
  private target = 0;
  private previousMs: number | null = null;
  private playing = false;
  private speed = 1;

  private readonly simulation: Simulation;

  constructor(simulation: Simulation) {
    this.simulation = simulation;
    this.target = simulation.snapshot().minute;
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this.previousMs = null;
  }

  pause() {
    this.playing = false;
  }

  setSpeed(multiplier: number) {
    if (!Number.isFinite(multiplier) || multiplier <= 0) throw new RangeError("Invalid speed");
    this.speed = multiplier;
  }

  frame(timestampMs: number): Promise<void> {
    if (!this.playing) return Promise.resolve();
    const elapsed = timestampMs - (this.previousMs ?? timestampMs);
    this.previousMs = timestampMs;
    // 180 simulated minutes take 24 seconds at normal speed.
    this.target += Math.max(0, elapsed) * 0.0075 * this.speed;
    return this.simulation.advanceTo(this.target);
  }
}
