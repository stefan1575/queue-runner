// How dates and times are written in the window (#36, Display). The date style is ours; the clock
// is T3's Time format (`timestampFormat`), shown here, never set here. Shared with the renderer,
// so nothing here touches Node.

export type DateStyle = 'month-first' | 'weekday-first' | 'day-first' | 'iso';
/** T3's Time format, with T3's own names for the choices. */
export type TimeFormat = 'locale' | '12-hour' | '24-hour';

export const DATE_STYLES: { id: DateStyle; label: string }[] = [
  { id: 'month-first', label: 'Month first' },
  { id: 'weekday-first', label: 'Weekday first' },
  { id: 'day-first', label: 'Day first' },
  { id: 'iso', label: 'Year-month-day' },
];

export const TIME_FORMATS: { id: TimeFormat; label: string }[] = [
  { id: 'locale', label: 'System default' },
  { id: '12-hour', label: '12-hour' },
  { id: '24-hour', label: '24-hour' },
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const p2 = (n: number) => String(n).padStart(2, '0');

/** The time of day as T3 writes it for this Time format: "System default" is the PC's own. */
export function clock(d: Date, format: TimeFormat): string {
  if (format === '24-hour') return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  if (format === '12-hour') return `${d.getHours() % 12 || 12}:${p2(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Whether this Time format shows a 12-hour clock on this PC. */
export function isTwelveHour(format: TimeFormat): boolean {
  if (format !== 'locale') return format === '12-hour';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 === true;
}

/** A date and time in a date style; `short` is its form for tight spots. */
export function formatDate(d: Date, style: DateStyle, format: TimeFormat, short = false): string {
  const t = clock(d, format);
  const day = DAYS[d.getDay()]!, mon = MONTHS[d.getMonth()]!, n = d.getDate(), y = d.getFullYear();
  const d3 = day.slice(0, 3), m3 = mon.slice(0, 3);
  if (style === 'iso') return short ? `${p2(d.getMonth() + 1)}-${p2(n)} ${t}` : `${y}-${p2(d.getMonth() + 1)}-${p2(n)} ${d3} ${t}`;
  if (style === 'weekday-first') return short ? `${d3}, ${m3} ${n}, ${t}` : `${day}, ${mon} ${n}, ${y}, ${t}`;
  if (style === 'day-first') return short ? `${n} ${m3} ${d3} ${t}` : `${n} ${mon} ${y} ${day} ${t}`;
  return short ? `${m3} ${n} ${d3} ${t}` : `${mon} ${n}, ${y} ${day} ${t}`;
}
