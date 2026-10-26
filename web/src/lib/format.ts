export function ago(iso: string | Date | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return 'in ' + span(-s);
  if (s < 45) return 'just now';
  return span(s) + ' ago';
}

export function until(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  return s <= 0 ? 'now' : 'in ' + span(s);
}

function span(s: number): string {
  if (s < 90) return s + 's';
  const m = Math.round(s / 60);
  if (m < 90) return m + ' min';
  const h = Math.round(m / 60);
  if (h < 36) return h + ' h';
  const d = Math.round(h / 24);
  if (d < 60) return d + ' d';
  return Math.round(d / 30) + ' mo';
}

export function num(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === '') return '—';
  return Number(n).toLocaleString('en-US');
}

export function approx(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1000) return '~' + n;
  if (n < 1_000_000) return '~' + (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k';
  return '~' + (n / 1_000_000).toFixed(1) + 'M';
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
}

export function ms(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1000) return Math.round(n) + ' ms';
  if (n < 60_000) return (n / 1000).toFixed(1) + ' s';
  return Math.round(n / 60_000) + ' min';
}

export function dateTime(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** CSV with formula-injection guard: cells starting with = + - @ are prefixed with '. */
export function toCsv(header: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}
