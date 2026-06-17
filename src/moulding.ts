// MOULDING — pure per-room trim geometry (no three.js imports, so this is
// unit-testable in Node and shared by the viewer + the SCAD export).
//
// A moulding object is applied PER ROOM, PER KIND (base | chair | crown) and
// paints the room's full interior perimeter:
//   { room, kind, profile, h, d, color }
//   room    = index into rooms / roomLoops
//   kind    = "base" | "chair" | "crown"
//   h       = profile height (ft)   d = depth proud of the wall face (ft)
//   profile = a key of MOULDING_PROFILES (the cross-section)
//
// Two pure functions are shared by the viewer (buildMouldingGeo) and the SCAD
// export (MLD_RUNS):
//   • mouldingRuns(graph, roomLoops, doors, windows, mld, wallH)
//       → [ { ax, ay, bx, by }, … ]  the room-perimeter wall RUNS, displaced
//       INWARD by WALL_T/2 + d/2, already SPLIT at the openings this kind cares
//       about (base/chair interrupt at doors; chair/base at intersecting windows;
//       crown is continuous across doors/windows). Loop edges with NO wall —
//       walk-through gaps punched by deleting nodes — get no runs at all.
//   • mouldingRunParts(profileId, kind, len, h, d)
//       → [ box… ]  the profile's stacked sub-boxes for ONE run, in the
//       WALL-RUN-LOCAL frame: x 0..len, y across centered on 0, z 0..h (crown is
//       mirrored vertically so the deep face is at the top).
//
// `mouldingZ(mld, wallH)` gives the base Z of a moulding (base 0, chair 2.7,
// crown wallH - h).

import type { LocalBox, Moulding, WallGraph, MouldRun } from "./types.ts";

interface ProfileDef { id: string; label: string; boxes: [number, number, number][]; }
interface KindDefault { h: number; d: number; profile: string; }
// A wall-relative opening (door or window) as consumed by mouldingRuns.
interface OpeningLike { wall: number; t: number; w: number; sill?: number; h?: number; }
type Span = [number, number];

export const WALL_T = 0.5;          // wall thickness (matches main.js / scad.js)
const CHAIR_Z = 2.7;                // chair-rail band base height (ft)

// ---- profiles ---------------------------------------------------------------
// Each profile is a list of stacked sub-boxes, bottom-up, as FRACTIONS of the
// moulding's (h, d): [zFrac0, zFrac1, dFrac]. zFrac spans [0,1] of the height,
// dFrac is the depth proud of the wall as a fraction of `d`. Pure data, drawn
// identically in three.js and SCAD. (For CROWN the sub-boxes are flipped
// vertically by mouldingRunParts so the deep face sits at the top.)
export const MOULDING_PROFILES: Record<string, ProfileDef> = {
  square:  { id: "square",  label: "Square",  boxes: [[0, 1, 1.0]] },
  stepped: { id: "stepped", label: "Stepped", boxes: [[0, 0.8, 0.7], [0.8, 1, 1.0]] },
  cove:    { id: "cove",    label: "Cove",    boxes: [[0, 0.55, 1.0], [0.55, 0.8, 0.66], [0.8, 1, 0.33]] },
};
export const MOULDING_PROFILE_ORDER = ["square", "stepped", "cove"];

// numeric profile code for the SCAD table (keep in sync with the order above).
export const PROFILE_CODE: Record<string, number> = { square: 0, stepped: 1, cove: 2 };

// ---- per-kind defaults ------------------------------------------------------
export const KIND_DEFAULTS: Record<string, KindDefault> = {
  base:  { h: 0.45, d: 0.06, profile: "stepped" },
  crown: { h: 0.35, d: 0.05, profile: "cove" },
  chair: { h: 0.20, d: 0.04, profile: "square" },
};
export const KIND_ORDER = ["base", "chair", "crown"];

// base Z (ft) of a moulding of the given kind. crown follows the live wallH.
export function mouldingZ(mld: Moulding, wallH: number): number {
  if (mld.kind === "crown") return Math.max(0, wallH - (mld.h ?? 0.35));
  if (mld.kind === "chair") return CHAIR_Z;
  return 0;                                           // base
}

// the vertical band [z0,z1] a moulding occupies, for opening-interrupt tests.
function mouldingBand(mld: Moulding, wallH: number) {
  const z0 = mouldingZ(mld, wallH);
  return { z0, z1: z0 + (mld.h ?? 0.3) };
}

// the vertical band of a window (matches main.js winBand semantics, defensively).
function windowBand(win: { sill?: number; h?: number }, wallH: number) {
  const sill = win.sill ?? 1.2;
  const z0 = Math.max(0, Math.min(sill, wallH - 0.3));
  let z1 = Math.min(wallH, z0 + (win.h ?? 2.0));
  if (z1 - z0 < 0.3) z1 = Math.min(wallH, z0 + 0.3);
  return { z0, z1 };
}

const signedArea = (pts: number[][]) => {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
};

// remove cut intervals (each [s,e], param along a run 0..len) from a list of spans.
function subtractSpans(spans: Span[], cuts: Span[]): Span[] {
  if (!cuts.length) return spans;
  let out = spans;
  for (const [cs, ce] of cuts) {
    const next: Span[] = [];
    for (const [s, e] of out) {
      if (ce <= s || cs >= e) { next.push([s, e]); continue; }
      if (cs > s) next.push([s, cs]);
      if (ce < e) next.push([ce, e]);
    }
    out = next;
  }
  return out.filter(([s, e]) => e - s > 1e-3);
}

// Find the index of the wall (in graph.walls) connecting loop nodes na→nb (either
// direction); -1 if none. Used to map a loop edge back to its openings.
function wallBetween(graph: WallGraph, na: number, nb: number): number {
  for (let i = 0; i < graph.walls.length; i++) {
    const w = graph.walls[i];
    if ((w.a === na && w.b === nb) || (w.a === nb && w.b === na)) return i;
  }
  return -1;
}

// Should this opening interrupt this moulding kind on this wall?
//   • doors interrupt base & chair (a door reaches the floor) — never crown.
//   • windows interrupt chair only if the chair band intersects the window band,
//     and interrupt base only if the window sill drops below the base height.
function openingCuts(
  kind: string, mld: Moulding, wallH: number, openings: OpeningLike[], windows: OpeningLike[],
): OpeningLike[] {
  if (kind === "crown") return [];
  const cuts: OpeningLike[] = [];
  const band = mouldingBand(mld, wallH);
  for (const o of openings) cuts.push(o);             // door spans (pre-resolved)
  for (const w of windows) {
    const wb = windowBand(w, wallH);
    let hit = false;
    if (kind === "chair") hit = wb.z0 < band.z1 && wb.z1 > band.z0;     // bands overlap
    else if (kind === "base") hit = wb.z0 < band.z1;                    // low sill reaches the base
    if (hit) cuts.push(w);
  }
  return cuts;
}

// The interior-perimeter RUNS of room `mld.room` at this kind/depth, split at the
// openings this kind cares about. Each run is { ax, ay, bx, by } in world XY,
// displaced INWARD (toward the room interior) by WALL_T/2 + d/2 along the edge
// normal. The loop is oriented CCW first (signed area) so the inward normal is
// deterministic.
export function mouldingRuns(
  graph: WallGraph, roomLoops: number[][], doors: OpeningLike[], windows: OpeningLike[],
  mld: Moulding, wallH: number,
): MouldRun[] {
  const loop = roomLoops[mld.room];
  if (!loop || loop.length < 3) return [];
  // keep node indices alongside coords so each edge maps back to its wall even
  // after we reverse the loop to orient it CCW.
  let nodes = loop.map((ni) => ({ ni, n: graph.nodes[ni] })).filter((o) => o.n)
    .map((o) => ({ ni: o.ni, x: o.n.x, y: o.n.y }));
  if (nodes.length < 3) return [];
  // orient CCW (positive signed area) so the LEFT normal of each edge points inward.
  if (signedArea(nodes.map((p) => [p.x, p.y])) < 0) nodes = nodes.reverse();
  const inset = WALL_T / 2 + (mld.d ?? 0.06) / 2;
  const runs: MouldRun[] = [];
  const N = nodes.length;
  for (let i = 0; i < N; i++) {
    const a = nodes[i], b = nodes[(i + 1) % N];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 1e-4) continue;
    const ux = dx / len, uy = dy / len;
    // inward normal for a CCW loop is the LEFT normal (-uy, ux).
    const nx = -uy, ny = ux;
    // map this loop edge back to its wall (by original node indices) to find openings.
    const wi = wallBetween(graph, a.ni, b.ni);
    // A loop edge with NO wall is a punched-out gap you could walk through
    // (deleting nodes removes their walls but keeps the floor loop closed).
    // Moulding attaches to a wall, so NO kind paints across the opening —
    // not even crown, which only stays continuous where a wall exists above.
    if (wi < 0) continue;
    let spans: Span[] = [[0, len]];
    if (mld.kind !== "crown") {
      const wallDoors = doors.filter((d) => d.wall === wi);
      const wallWins = windows.filter((w) => w.wall === wi);
      const cuts = openingCuts(mld.kind, mld, wallH, wallDoors, wallWins);
      // map each opening's center param + half-width onto this run's [0,len].
      const wl = graph.walls[wi], na = graph.nodes[wl.a], nb = graph.nodes[wl.b];
      const wlen = Math.hypot(nb.x - na.x, nb.y - na.y) || 1e-6;
      const cutSpans = cuts.map((o): Span => {
        const center = o.t * wlen, half = (o.w / 2);
        return [Math.max(0, center - half), Math.min(len, center + half)];
      }).filter(([s, e]) => e > s);
      spans = subtractSpans(spans, cutSpans);
    }
    for (const [s, e] of spans) {
      runs.push({ ax: a.x + nx * inset + ux * s, ay: a.y + ny * inset + uy * s,
                  bx: a.x + nx * inset + ux * e, by: a.y + ny * inset + uy * e });
    }
  }
  return runs;
}

const lbox = (
  x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, color: string | null,
): LocalBox => ({
  x0: Math.min(x0, x1), x1: Math.max(x0, x1),
  y0: Math.min(y0, y1), y1: Math.max(y0, y1),
  z0: Math.min(z0, z1), z1: Math.max(z0, z1), color,
});

// Stacked profile sub-boxes for ONE run, in the WALL-RUN-LOCAL frame:
//   x along the run 0..len · y across, centered on 0 (proud of the wall face on
//   the interior side: 0..d) · z 0..h. For CROWN the sub-boxes are mirrored
//   vertically (the deep face ends up at the TOP, against the ceiling).
export function mouldingRunParts(
  profileId: string, kind: string, len: number, h: number, d: number, color: string | null,
): LocalBox[] {
  const prof = MOULDING_PROFILES[profileId] || MOULDING_PROFILES.square;
  const out: LocalBox[] = [];
  const crown = kind === "crown";
  for (const [zf0, zf1, df] of prof.boxes) {
    let z0 = zf0 * h, z1 = zf1 * h;
    if (crown) { const t0 = (1 - zf1) * h, t1 = (1 - zf0) * h; z0 = t0; z1 = t1; }
    const depth = df * d;
    // proud of the wall face: the run line sits on the wall face, the moulding
    // stands out toward the interior (y from -depth/2..+depth/2 centered on 0 so
    // it straddles the displaced run line — the run was already inset by d/2).
    out.push(lbox(0, -depth / 2, len, depth / 2, z0, z1, color));
  }
  return out;
}
