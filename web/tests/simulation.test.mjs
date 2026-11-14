import assert from "node:assert/strict";
import test from "node:test";

import { Playback, Simulation } from "../src/lib/simulation.ts";

const building = {
  id: "a", lat: 34.1, lng: -118.33,
  people_est: 20, people_need_help_est: 8, fire_arrival_min: 4,
};
const truck = { id: "t1", station_id: "s1", lat: 34, lng: -118, status: "idle", building_id: null };
const config = {
  seed: 42, self_evac_rate_per_min: 1, assisted_evac_rate_per_min: 5,
  rematch_every_min: 2, truck_speed_kmh: 40,
};
const noMatch = () => [];
const assignment = { truck_id: "t1", building_id: "a", eta_min: 1, reason: "test" };

test("a failed match leaves the same tick available for retry", async () => {
  let calls = 0;
  const simulation = new Simulation([building], [truck], config, "ours", () => {
    if (++calls === 1) throw new Error("offline");
    return [assignment];
  }, 4);

  await assert.rejects(simulation.advanceTo(1), /offline/);
  assert.equal(simulation.snapshot().minute, 0);
  await simulation.advanceTo(4);
  assert.equal(simulation.snapshot().done, true);
});

test("a full run is deterministic across frame sizes", async () => {
  const direct = new Simulation([building], [], config, "ours", noMatch, 180);
  const stepped = new Simulation([building], [], config, "ours", noMatch, 180);
  await direct.advanceTo(180);
  for (let minute = 0; minute <= 180; minute += 1) await stepped.advanceTo(minute);
  assert.deepEqual(direct.snapshot(), stepped.snapshot());
  assert.deepEqual(direct.snapshot().counts, { inside: 0, evacuated: 5, trapped: 15 });
});

test("assistance increases evacuation after a truck arrives", async () => {
  const simulation = new Simulation([building], [truck], config, "ours", () => [assignment], 4);
  await simulation.advanceTo(1);
  assert.equal(simulation.snapshot().trucks[0].status, "on_scene");
  await simulation.advanceTo(4);
  assert.deepEqual(simulation.snapshot().counts, { inside: 0, evacuated: 20, trapped: 0 });
});

test("a fractional arrival time only allows evacuation until the fire arrives", async () => {
  const simulation = new Simulation(
    [{ ...building, fire_arrival_min: 0.5 }], [],
    { ...config, self_evac_rate_per_min: 2 }, "ours", noMatch, 1,
  );
  await simulation.advanceTo(1);
  assert.deepEqual(simulation.snapshot().counts, { inside: 0, evacuated: 1, trapped: 19 });
});

test("periodic matching and agent events receive the current population and vehicle state", async () => {
  const states = [];
  const simulation = new Simulation([building], [truck], config, "ours", state => {
    states.push(state);
    return [assignment];
  }, 8);
  await simulation.advanceTo(2);
  await simulation.applyEvent({ type: "tenant_stuck", building_id: "a", count: 12, note: "demo" });
  await simulation.applyEvent({ type: "driver_declines", truck_id: "t1", building_id: "a", reason: "busy" });
  assert.deepEqual(states.map(state => state.now_min), [0, 2, 2, 2]);
  assert.equal(states[2].buildings[0].people_need_help_est, 9);
  assert.equal(states[3].trucks[0].status, "unavailable");
  assert.equal(simulation.snapshot().trucks[0].status, "unavailable");
});

test("nearest keeps an en-route assignment when matching runs again", async () => {
  const simulation = new Simulation(
    [building, { ...building, id: "b" }], [truck], config, "nearest",
    state => [{ ...assignment, building_id: state.now_min === 0 ? "a" : "b", eta_min: 3 }], 4,
  );
  await simulation.advanceTo(2);
  assert.equal(simulation.snapshot().trucks[0].building_id, "a");
});

test("playback pauses and resumes at the configured speed", async () => {
  const simulation = new Simulation([building], [], config, "ours", noMatch, 180);
  const playback = new Playback(simulation);
  playback.play();
  await playback.frame(0);
  await playback.frame(1000);
  assert.equal(simulation.snapshot().minute, 7);
  playback.pause();
  await playback.frame(2000);
  assert.equal(simulation.snapshot().minute, 7);
  playback.setSpeed(2);
  playback.play();
  await playback.frame(3000);
  await playback.frame(4000);
  assert.equal(simulation.snapshot().minute, 22);
  await playback.frame(15000);
  assert.equal(simulation.snapshot().done, true);
});
