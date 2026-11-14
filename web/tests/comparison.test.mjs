import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createComparison } = require(process.env.ROLLCALL_COMPARISON_MODULE);

test("both policies receive identical initial inputs and finish on the same clock", async () => {
  const buildings = [{
    id: "a", lat: 34.1, lng: -118.33, people_est: 20,
    people_need_help_est: 8, fire_arrival_min: 4,
  }];
  const trucks = [{
    id: "t1", station_id: "s1", lat: 34, lng: -118,
    status: "idle", building_id: null,
  }];
  const config = {
    seed: 42, self_evac_rate_per_min: 1, assisted_evac_rate_per_min: 5,
    rematch_every_min: 2, truck_speed_kmh: 40,
  };
  const initial = {};
  const comparison = createComparison(buildings, trucks, config, async (state, policy) => {
    if (state.now_min === 0) initial[policy] = state;
    return policy === "ours"
      ? [{ truck_id: "t1", building_id: "a", eta_min: 1, reason: "test" }]
      : [];
  }, 180);

  await comparison.frame(0);
  const result = await comparison.frame(24000);
  assert.deepEqual(initial.ours, initial.nearest);
  assert.equal(result.done, true);
  assert.equal(result.minute, 180);
  assert.deepEqual(result.ours, { inside: 0, evacuated: 20, trapped: 0 });
  assert.deepEqual(result.nearest, { inside: 0, evacuated: 5, trapped: 15 });
  assert.equal(trucks[0].status, "idle");
});
