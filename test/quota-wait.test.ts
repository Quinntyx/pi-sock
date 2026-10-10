import assert from "node:assert/strict";
import { test } from "node:test";
import { QuotaWaitClock } from "../quota-wait.ts";

test("quota pause clock is cumulative, monotonic, and excludes active work", () => {
  let now = 100;
  const clock = new QuotaWaitClock(() => now);
  assert.deepEqual(clock.snapshot(), { active: false, elapsedMs: 0 });
  now = 500; clock.setActive(true); now = 800;
  assert.deepEqual(clock.snapshot(), { active: true, elapsedMs: 300 });
  clock.setActive(true); now = 1000; clock.setActive(false);
  assert.deepEqual(clock.snapshot(), { active: false, elapsedMs: 500 });
  now = 2000; clock.setActive(false);
  assert.deepEqual(clock.snapshot(), { active: false, elapsedMs: 500 });
  clock.setActive(true); now = 2100;
  assert.deepEqual(clock.snapshot(), { active: true, elapsedMs: 600 });
  clock.setActive(false); now = 3000;
  assert.deepEqual(clock.snapshot(), { active: false, elapsedMs: 600 });
});
