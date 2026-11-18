// Dates in a chosen style, with the time of day written in T3's Time format.
import { describe, expect, test } from 'vitest';
import { clock, formatDate, isTwelveHour } from '../src/display.ts';

const at = new Date(2026, 10, 16, 15, 5); // Monday 16 November 2026, 3:05 in the afternoon

describe('the date style', () => {
  test('the default reads "November 16, 2026 Monday" with the time', () => {
    expect(formatDate(at, 'month-first', '24-hour')).toBe('November 16, 2026 Monday 15:05');
    expect(formatDate(at, 'month-first', '24-hour', true)).toBe('Nov 16 Mon 15:05');
  });

  test('each preset, long and short', () => {
    expect(formatDate(at, 'weekday-first', '12-hour')).toBe('Monday, November 16, 2026, 3:05 PM');
    expect(formatDate(at, 'day-first', '12-hour', true)).toBe('16 Nov Mon 3:05 PM');
    expect(formatDate(at, 'iso', '24-hour')).toBe('2026-11-16 Mon 15:05');
    expect(formatDate(at, 'iso', '24-hour', true)).toBe('11-16 15:05');
  });
});

describe("the clock, in T3's Time format", () => {
  test('12-hour and 24-hour', () => {
    expect(clock(new Date(2026, 0, 1, 0, 7), '12-hour')).toBe('12:07 AM');
    expect(clock(new Date(2026, 0, 1, 0, 7), '24-hour')).toBe('00:07');
    expect(isTwelveHour('12-hour')).toBe(true);
    expect(isTwelveHour('24-hour')).toBe(false);
  });

  test("System default is the PC's own", () => {
    expect(clock(at, 'locale')).toBe(at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
  });
});
