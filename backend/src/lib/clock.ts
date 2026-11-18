/** A replaceable clock so tests can control "now" for schedules and cutoffs. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(start: Date): Clock & { set(d: Date): void; advance(ms: number): void } {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set: (d) => {
      current = new Date(d);
    },
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}
