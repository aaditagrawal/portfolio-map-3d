import { expect, it } from "vitest";
import { LEAP_DURATION, LEAP_HEIGHT, LEAP_SPEED, leapHeight } from "./leap";

it("starts and lands on the ground with a high midpoint and long reach", () => {
  expect(leapHeight(0)).toBe(0);
  expect(leapHeight(LEAP_DURATION / 2)).toBe(LEAP_HEIGHT);
  expect(leapHeight(LEAP_DURATION)).toBe(0);
  expect(leapHeight(LEAP_DURATION * 2)).toBe(0);
  expect(LEAP_DURATION * LEAP_SPEED).toBeGreaterThan(30);
});

it("keeps the arc nonnegative for every sampled time", () => {
  for (let n = -10; n <= 150; n++) {
    const h = leapHeight((n / 100) * LEAP_DURATION);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(LEAP_HEIGHT);
  }
});
