// DOORS v2 — pure door-leaf + casing geometry (no three.js imports, so this is
// unit-testable in Node and shared by the viewer + the SCAD export).
//
// A door object: { wall, t, w, side, hinge/hand,  style, color, casing }.
// `style` selects a construction from DOOR_STYLES; `doorLeaves(style, w)` returns
// the leaf descriptors (one leaf for singles, two for french/double); and
// Sliding styles (kind "slide") return frames with mode:"slide" + slideSign from
// doorLeafFrames — those leaves translate along the wall (never rotate); the
// open parameter maps to a slide fraction (deg/110) instead of a swing angle.
// `doorLeafParts(style, leafW, leafH, color)` returns the box list of a single
// leaf in the LEAF-LOCAL frame:
//   • x runs ALONG the leaf from the hinge: 0 .. leafW
//   • y is thickness ACROSS the leaf, centered on 0 (total 0.15)
//   • z is up: 0 .. leafH
// Returned as { solids: [box...], glass: [box...] } where
//   box = { x0, x1, y0, y1, z0, z1, color }.
// `casingParts(openingW, openingH, wallT)` returns casing trim boxes in the
// WALL-LOCAL frame (x along the wall, y across, z up) — two legs + a head on each
// wall face, surrounding (never covering) the opening.

import type { LocalBox, LeafFrame, Dir } from "./types.ts";

interface DoorStyleDef {
  id: string; label: string;
  kind: "single" | "pair" | "slide";
  leaf: string; glass: boolean;
  panels?: number; lites?: [number, number];
}
interface Cell { x0: number; x1: number; z0: number; z1: number; }
interface LeafDesc { hingeT: number; swingSign: number; w: number; leaf: string; }

const LEAF_T = 0.15;        // total leaf thickness (y span, centered on 0)
const PANEL_T = 0.07;       // recessed panel thickness (proud face inset)
const GLASS_T = 0.05;       // glazed lite thickness
const HY = LEAF_T / 2;      // ±half thickness

// --- style catalog -----------------------------------------------------------
// `kind` drives doorLeaves (single vs. pair). The per-leaf construction is
// realized in doorLeafParts() below (keyed by leaf style). For pairs the two
// leaves are each the `leaf` style (french → glazed15, double → slab).
export const DOOR_STYLES: Record<string, DoorStyleDef> = {
  slab:     { id: "slab",     label: "Slab",          kind: "single", leaf: "slab",     glass: false },
  panel2:   { id: "panel2",   label: "2-Panel Shaker", kind: "single", leaf: "panel2",  glass: false, panels: 2 },
  panel5:   { id: "panel5",   label: "5-Panel",        kind: "single", leaf: "panel5",  glass: false, panels: 5 },
  glazed15: { id: "glazed15", label: "15-Lite Glazed", kind: "single", leaf: "glazed15", glass: true, lites: [3, 5] },
  french:   { id: "french",   label: "French Pair",    kind: "pair",   leaf: "glazed15", glass: true, lites: [3, 5] },
  double:   { id: "double",   label: "Double Slab",    kind: "pair",   leaf: "slab",     glass: false },
  // sliding styles (kind "slide"): leaves TRANSLATE along the wall instead of
  // swinging. `sliding` is an opaque barn-style slab hung on a face track that
  // parks beside the opening; `slidingGlass` is a patio-style pair of single-lite
  // panels on parallel in-wall tracks — one fixed, one slides over it.
  sliding:      { id: "sliding",      label: "Sliding",      kind: "slide", leaf: "slab",    glass: false },
  slidingGlass: { id: "slidingGlass", label: "Glass Slider", kind: "slide", leaf: "glazed1", glass: true, lites: [1, 1] },
};
export const DOOR_STYLE_ORDER = ["slab", "panel2", "panel5", "glazed15", "french", "double", "sliding", "slidingGlass"];

const box = (
  x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, color: string | null,
): LocalBox => ({
  x0: Math.min(x0, x1), x1: Math.max(x0, x1),
  y0: Math.min(y0, y1), y1: Math.max(y0, y1),
  z0: Math.min(z0, z1), z1: Math.max(z0, z1), color,
});

// Build the frame (stiles + rails) of a paneled/glazed leaf and the inner cells
// (panel/lite openings) to fill. `rows` is an array of [zFrac0, zFrac1] rail gaps
// (the openings between rails); `cols` the number of vertical divisions. Returns
// { frame: [box...], cells: [{x0,x1,z0,z1}...] }.
function frameAndCells(
  leafW: number, leafH: number, stile: number, rails: [number, number][], cols: number, color: string | null,
): { frame: LocalBox[]; cells: Cell[] } {
  const frame: LocalBox[] = [];
  // vertical stiles (left/right), full height
  frame.push(box(0, -HY, stile, HY, 0, leafH, color));
  frame.push(box(leafW - stile, -HY, leafW, HY, 0, leafH, color));
  // horizontal rails at the listed z positions (each rail = [z0,z1])
  for (const [z0, z1] of rails) frame.push(box(stile, -HY, leafW - stile, HY, z0, z1, color));
  // the open cell rows are the gaps BETWEEN consecutive rails
  const cells: Cell[] = [];
  const innerX0 = stile, innerX1 = leafW - stile;
  const cellW = (innerX1 - innerX0) / cols;
  for (let r = 0; r < rails.length - 1; r++) {
    const cz0 = rails[r][1], cz1 = rails[r + 1][0];
    if (cz1 - cz0 < 1e-4) continue;
    for (let c = 0; c < cols; c++) {
      cells.push({ x0: innerX0 + c * cellW, x1: innerX0 + (c + 1) * cellW, z0: cz0, z1: cz1 });
    }
  }
  return { frame, cells };
}

// LEAF-LOCAL parts for one leaf of the given (single-leaf) style.
export function doorLeafParts(styleId: string, leafW: number, leafH: number, color: string | null): { solids: LocalBox[]; glass: LocalBox[] } {
  const solids: LocalBox[] = [], glass: LocalBox[] = [];
  // accept a style id (slab, french, slidingGlass…) OR a bare leaf name
  // (glazed1, glazed15…) — frames carry leaf names, panels aren't styles.
  const st = DOOR_STYLES[styleId];
  const leaf = st ? (st.leaf || "slab") : styleId;

  if (leaf === "slab") {
    solids.push(box(0, -HY, leafW, HY, 0, leafH, color));
    return { solids, glass };
  }

  if (leaf === "panel2") {
    const stile = 0.38, topR = 0.38, midR = 0.5, botR = 0.75;
    // rails as [z0,z1] bands: bottom rail, mid rail, top rail (panels between).
    const rails: [number, number][] = [
      [0, botR],
      [(leafH - midR) / 2, (leafH + midR) / 2],
      [leafH - topR, leafH],
    ];
    const { frame, cells } = frameAndCells(leafW, leafH, stile, rails, 1, color);
    solids.push(...frame);
    // 2 recessed panels (0.07 thick, centered on the leaf y=0)
    for (const c of cells) solids.push(box(c.x0, -PANEL_T / 2, c.x1, PANEL_T / 2, c.z0, c.z1, color));
    return { solids, glass };
  }

  if (leaf === "panel5") {
    const stile = 0.38, railT = 0.3;
    // 5 stacked panels separated by 0.3 rails (top + bottom rails too).
    const n = 5, gaps = n + 1;                 // 6 rails bounding 5 cells
    const railTotal = gaps * railT;
    const panelH = Math.max(0.1, (leafH - railTotal) / n);
    const rails: [number, number][] = [];
    let z = 0;
    for (let i = 0; i <= n; i++) {
      rails.push([z, z + railT]); z += railT;
      if (i < n) z += panelH;
    }
    const { frame, cells } = frameAndCells(leafW, leafH, stile, rails, 1, color);
    solids.push(...frame);
    for (const c of cells) solids.push(box(c.x0, -PANEL_T / 2, c.x1, PANEL_T / 2, c.z0, c.z1, color));
    return { solids, glass };
  }

  if (leaf === "glazed15") {
    // stiles/rails 0.38; 3×5 glass lite grid, muntins 0.1.
    const stile = 0.38, muntin = 0.1, cols = 3, rows = 5;
    // top + bottom rails are the stile width; interior muntins split the glass.
    const rails: [number, number][] = [[0, stile], [leafH - stile, leafH]];
    const { frame, cells } = frameAndCells(leafW, leafH, stile, rails, 1, color);
    solids.push(...frame);
    // the single open cell is the glass field — fill with a muntin grid + glass.
    for (const cell of cells) {
      const gx0 = cell.x0, gx1 = cell.x1, gz0 = cell.z0, gz1 = cell.z1;
      const fieldW = gx1 - gx0, fieldH = gz1 - gz0;
      const cw = fieldW / cols, ch = fieldH / rows;
      // vertical muntins (between columns)
      for (let c = 1; c < cols; c++) {
        const x = gx0 + c * cw;
        solids.push(box(x - muntin / 2, -HY, x + muntin / 2, HY, gz0, gz1, color));
      }
      // horizontal muntins (between rows)
      for (let r = 1; r < rows; r++) {
        const z = gz0 + r * ch;
        solids.push(box(gx0, -HY, gx1, HY, z - muntin / 2, z + muntin / 2, color));
      }
      // glass lites, one per cell, inset by half a muntin so they meet the bars
      for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
        const lx0 = gx0 + c * cw + (c === 0 ? 0 : muntin / 2);
        const lx1 = gx0 + (c + 1) * cw - (c === cols - 1 ? 0 : muntin / 2);
        const lz0 = gz0 + r * ch + (r === 0 ? 0 : muntin / 2);
        const lz1 = gz0 + (r + 1) * ch - (r === rows - 1 ? 0 : muntin / 2);
        glass.push(box(lx0, -GLASS_T / 2, lx1, GLASS_T / 2, lz0, lz1, color));
      }
    }
    return { solids, glass };
  }

  if (leaf === "glazed1") {
    // single-lite glass panel (patio slider): slim frame + one full glass pane.
    const stile = 0.25;
    const rails: [number, number][] = [[0, stile], [leafH - stile, leafH]];
    const { frame, cells } = frameAndCells(leafW, leafH, stile, rails, 1, color);
    solids.push(...frame);
    for (const c of cells) glass.push(box(c.x0, -GLASS_T / 2, c.x1, GLASS_T / 2, c.z0, c.z1, color));
    return { solids, glass };
  }

  // fallback: slab
  solids.push(box(0, -HY, leafW, HY, 0, leafH, color));
  return { solids, glass };
}

// Leaf descriptors for a door of width `w`. One leaf for single styles; for a
// pair the two leaves are each w/2, hinged at OPPOSITE jambs (hingeT 0 and 1),
// meeting at the middle of the opening, with mirrored swing signs.
//   hingeT: 0 → hinge at the A-end of the opening, 1 → hinge at the B-end.
//   swingSign: ±1 → which way this leaf rotates (the two mirror).
export function doorLeaves(styleId: string, w: number): LeafDesc[] {
  const st = DOOR_STYLES[styleId] || DOOR_STYLES.slab;
  if (st.kind === "pair") {
    return [
      { hingeT: 0, swingSign: +1, w: w / 2, leaf: st.leaf },
      { hingeT: 1, swingSign: -1, w: w / 2, leaf: st.leaf },
    ];
  }
  if (st.kind === "slide" && st.leaf !== "slab") {
    // patio-style glass slider: two half-width panels at opposite jambs.
    return [
      { hingeT: 0, swingSign: 0, w: w / 2, leaf: st.leaf },
      { hingeT: 1, swingSign: 0, w: w / 2, leaf: st.leaf },
    ];
  }
  return [{ hingeT: 0, swingSign: +1, w, leaf: st.leaf }];
}

// Leaf placement frames for a door, in WORLD XY (degrees), shared by the viewer
// and the SCAD export so both swing identically. Given the opening center
// (cx, cy), wall direction `wallDeg` (A→B), clear width `w`, and side/hand, returns
// one frame per leaf: { hx, hy, baseDeg, swingSign, w, leaf }. The rendered leaf
// angle is baseDeg + swingSign * DOOR_OPEN (so the swing parameter feeds rotate()).
export function doorLeafFrames(
  styleId: string, cx: number, cy: number, w: number, wallDeg: number,
  side = 1, hand = 1, wallT = 0.5,
): LeafFrame[] {
  const rad = wallDeg * Math.PI / 180;
  const ux = Math.cos(rad), uy = Math.sin(rad);
  const hw = w / 2;
  const jambA = { x: cx - ux * hw, y: cy - uy * hw };   // A-end jamb
  const jambB = { x: cx + ux * hw, y: cy + uy * hw };   // B-end jamb
  const sd = side >= 1 ? 1 : -1, hd = hand >= 0 ? 1 : -1;
  const leaves = doorLeaves(styleId, w);
  const st = DOOR_STYLES[styleId] || DOOR_STYLES.slab;
  if (st.kind === "slide") {
    // SLIDING frames: mode "slide", never rotated — the consumer offsets the leaf
    // along its baseDeg axis by slideSign * leafW * openFrac (slideSign 0 = fixed
    // panel). The track's lateral offset is baked into the hinge point here, in
    // the WALL frame (left normal of A→B), so flipping baseDeg can't double-flip it.
    const nx = -uy, ny = ux;
    if (leaves.length === 1) {
      // barn-style single: full-width slab on a face track (side picks the wall
      // face), parking PAST its jamb (hand picks which jamb) → slides in -x.
      const lf = leaves[0], atA = hd > 0;
      const hinge = atA ? jambA : jambB;
      const off = sd * (wallT / 2 + LEAF_T / 2 + 0.02);
      return [{ hx: hinge.x + nx * off, hy: hinge.y + ny * off,
                baseDeg: wallDeg + (atA ? 0 : 180), swingSign: 0,
                mode: "slide", slideSign: -1, w: lf.w, leaf: lf.leaf }];
    }
    // patio pair: panels on two parallel tracks INSIDE the wall, meeting at the
    // opening center. `hand` picks which panel slides (over the other, which is
    // fixed); `side` mirrors which track each panel rides.
    return leaves.map((lf) => {
      const atA = lf.hingeT === 0;
      const hinge = atA ? jambA : jambB;
      const moves = hd > 0 ? !atA : atA;              // default: the B-jamb panel slides
      const off = sd * (LEAF_T / 2 + 0.01) * (atA ? -1 : 1);
      return { hx: hinge.x + nx * off, hy: hinge.y + ny * off,
               baseDeg: wallDeg + (atA ? 0 : 180), swingSign: 0,
               mode: "slide", slideSign: moves ? 1 : 0, w: lf.w, leaf: lf.leaf };
    });
  }
  if (leaves.length === 1) {
    // single: the jamb is chosen by `hand` (matches walls.js doorFrame), the leaf
    // points along the opening from that jamb, swing sign = side*hand.
    const lf = leaves[0], atA = hd > 0;
    const hinge = atA ? jambA : jambB;
    return [{ hx: hinge.x, hy: hinge.y, baseDeg: wallDeg + (atA ? 0 : 180), swingSign: sd * hd, w: lf.w, leaf: lf.leaf }];
  }
  // pair: leaves hinged at both jambs, swinging into the SAME room (mirrored).
  return leaves.map((lf) => {
    const atA = lf.hingeT === 0;
    const hinge = atA ? jambA : jambB;
    return { hx: hinge.x, hy: hinge.y, baseDeg: wallDeg + (atA ? 0 : 180), swingSign: sd * lf.swingSign, w: lf.w, leaf: lf.leaf };
  });
}

// --- casing ------------------------------------------------------------------
export const CASING_W = 0.30;   // face width of the casing band
export const CASING_T = 0.07;   // how far the casing stands proud of each wall face

// Casing trim around an opening, in the WALL-LOCAL frame:
//   x along the wall (centered on 0, so the opening spans [-W/2, +W/2])
//   y across the wall (centered on 0; wall faces at ±wallT/2)
//   z up: legs from 0..openingH+CASING_W head; head spans the full outer width.
// Two legs + one head on EACH wall face. The casing surrounds the opening — the
// legs sit just outside the jambs, the head just above the lintel.
export function casingParts(openingW: number, openingH: number, wallT: number): LocalBox[] {
  const parts: LocalBox[] = [];
  const hw = openingW / 2;
  const outer = hw + CASING_W;                       // legs sit outside the jamb
  const headTop = openingH + CASING_W;               // head above the lintel
  const faceY = wallT / 2;                            // each wall face
  for (const sgn of [+1, -1]) {
    const yIn = sgn * faceY, yOut = sgn * (faceY + CASING_T);
    const y0 = Math.min(yIn, yOut), y1 = Math.max(yIn, yOut);
    // left leg (outside the A-side jamb)
    parts.push(box(-outer, y0, -hw, y1, 0, headTop, null));
    // right leg (outside the B-side jamb)
    parts.push(box(hw, y0, outer, y1, 0, headTop, null));
    // head across the full outer width, above the opening
    parts.push(box(-outer, y0, outer, y1, openingH, headTop, null));
  }
  return parts;
}
