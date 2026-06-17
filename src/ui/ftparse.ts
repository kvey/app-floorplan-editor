// Pure feet/inch parsing + formatting for the NumField component (§5.1).
// Kept dependency-free and side-effect-free so Node tests can import it directly
// (tests/ftparse.test.mjs). The engine reads decimal feet; the UI shows ft-in.
//
// Accepted input forms → decimal feet:
//   "3.5"      → 3.5      (plain decimal)
//   "3'6\""    → 3.5      (feet + inches, no space)
//   "3' 6\""   → 3.5      (feet + inches, spaced)
//   "42\""     → 3.5      (inches only)
//   "3'"       → 3        (feet only)
//   "3.25"     → 3.25
// Anything unparseable → null (caller reverts).

export function parseFeet(raw: string): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // normalize unicode primes/quotes to ASCII ' and "
  s = s.replace(/[′’ʹ]/g, "'").replace(/[″”ʺ]/g, '"');

  // feet+inches: <feet>' [<inches>"]  e.g. 3'6"  3' 6"  3'
  const fi = s.match(/^(-?\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*"?)?$/);
  if (fi) {
    const ft = parseFloat(fi[1]);
    const inch = fi[2] != null ? parseFloat(fi[2]) : 0;
    if (!isFinite(ft) || !isFinite(inch)) return null;
    return ft < 0 ? ft - inch / 12 : ft + inch / 12;
  }
  // inches only: <inches>"  e.g. 42"
  const inOnly = s.match(/^(-?\d+(?:\.\d+)?)\s*"$/);
  if (inOnly) {
    const inch = parseFloat(inOnly[1]);
    return isFinite(inch) ? inch / 12 : null;
  }
  // plain decimal feet
  const dec = s.match(/^-?\d+(?:\.\d+)?$/);
  if (dec) {
    const v = parseFloat(s);
    return isFinite(v) ? v : null;
  }
  return null;
}

export function clamp(v: number, min: number, max: number): number {
  if (min != null && v < min) return min;
  if (max != null && v > max) return max;
  return v;
}

// Format decimal feet as ft-in like walls.js ftIn() (the ft' in" part only):
//   3.5 → 3' 6"   ·  0.5 → 0' 6"  ·  3 → 3' 0"
export function formatFeet(ft: number): string {
  const sign = ft < 0 ? "-" : "";
  ft = Math.abs(ft);
  let f = Math.floor(ft);
  let inch = Math.round((ft - f) * 12);
  if (inch === 12) { f++; inch = 0; }
  return `${sign}${f}' ${inch}"`;
}

// Format for a NumField given its suffix. Feet fields ("ft" / "") show ft-in;
// angle / unitless fields show the rounded number plus the suffix.
export function formatField(v: number, suffix: string): string {
  const suf = (suffix || "").trim();
  if (suf === "ft") return formatFeet(v);
  // degrees / unitless: show a tidy number + suffix
  const n = Math.round(v * 100) / 100;
  return suf ? `${n}${suf === "°" ? "°" : " " + suf}` : String(n);
}
