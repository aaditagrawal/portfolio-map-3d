/** Long leaps use a bounded arc and fixed takeoff momentum. */
export const LEAP_DURATION = 1.35;
export const LEAP_HEIGHT = 4.8;
export const LEAP_SPEED = 24;
export const LEAP_RUN_SPEED = 32;

export function leapHeight(elapsed: number): number {
  const t = Math.max(0, Math.min(1, elapsed / LEAP_DURATION));
  return 4 * LEAP_HEIGHT * t * (1 - t);
}
