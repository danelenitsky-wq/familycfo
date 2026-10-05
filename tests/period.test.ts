import { describe, expect, it } from 'vitest';
import { cycleByKey, cycleCount } from '../src/analytics/common';

describe('cycle ranges', () => {
  it('a range covers its first cycle start to its last cycle end', () => {
    expect(cycleByKey('2026-07..2026-09')).toEqual({ key: '2026-07..2026-09', start: '2026-07-01', end: '2026-09-30' });
    expect(cycleByKey('2026-11..2027-01', 10)).toEqual({ key: '2026-11..2027-01', start: '2026-11-10', end: '2027-02-09' });
    expect(cycleByKey('2026-07')).toEqual({ key: '2026-07', start: '2026-07-01', end: '2026-07-31' });
  });
  it('counts the cycles in a key', () => {
    expect(cycleCount('2026-07')).toBe(1);
    expect(cycleCount('2026-07..2026-09')).toBe(3);
    expect(cycleCount('2025-11..2026-10')).toBe(12);
  });
});
