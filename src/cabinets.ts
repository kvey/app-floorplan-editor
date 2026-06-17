// CABINETS — first-class kitchen/storage cabinets (Phase 5). A cabinet is a
// footprint rectangle {x, y, w, d} on a `level`, like furniture, plus a facing
// direction `dir` (the FRONT — doors/drawers — faces that way), a `kind`
// (base/wall/tall), a `front` style (slab/shaker), a `drawers` count (top rows),
// a `counter` flag, a `mount` (bottom z-offset from the floor — wall cabinets
// float), and two colors (carcass + countertop).
//
// `cabinetParts(c)` is the single source of truth for a cabinet's geometry: a
// list of axis-aligned colored boxes (absolute X/Y in feet, Z measured from the
// LEVEL FLOOR at 0 — `mount` lifts the carcass). It is PURE — shared by the
// three.js viewer (buildCabinetGeo) and the OpenSCAD export (scad.js / cab_parts)
// so both build identical cabinets. The box record matches furnitureParts:
// { cx, cy, cz, sx, sy, sz, color }.

import { shade, box, backRect, sideRects } from "./furniture.ts";
import type { PartBox, Cabinet, Dir } from "./types.ts";

type Rect = [number, number, number, number];
interface CabinetKindDef {
  label: string; w: number; d: number; h: number;
  mount: number; counter: boolean; toeKick: boolean;
}

// Per-kind defaults (feet). base sits on the floor with a counter; wall floats
// at mount 4.5 with no counter/toe-kick; tall is a full-height pantry/oven box.
export const CABINET_KINDS: Record<string, CabinetKindDef> = {
  base: { label: "Base", w: 2.0, d: 2.0,   h: 3.0, mount: 0,   counter: true,  toeKick: true },
  wall: { label: "Wall", w: 2.0, d: 1.083, h: 2.5, mount: 4.5, counter: false, toeKick: false },
  tall: { label: "Tall", w: 2.0, d: 2.0,   h: 7.0, mount: 0,   counter: false, toeKick: true },
};
export const CABINET_ORDER = ["base", "wall", "tall"];
export const FRONT_ORDER = ["slab", "shaker"];

const PULL_COLOR = "#3a3a3a";
const COUNTER_COLOR = "#dcd8d0";
const TOE_INSET = 0.25;       // front-face inset of the toe kick
const TOE_H = 0.3;            // toe-kick height
const COUNTER_T = 0.13;       // countertop slab thickness
const COUNTER_OVER = 0.1;     // countertop overhang (front + exposed sides)
const FRONT_PROUD = 0.08;     // door/drawer face thickness proud of the carcass front
const SHAKER_RAIL = 0.2;      // shaker frame rail/stile width
const SHAKER_PANEL_T = 0.03;  // recessed shaker panel thickness
const DRAWER_H = 0.55;        // height of one drawer row
const BAY_MAX = 1.75;         // max door bay width before splitting
const PULL_W = 0.04, PULL_LEN = 0.35;   // pull bar cross-section + length

// Is the cabinet front facing along +Y / -Y (vs ±X)? When facing ±Y the door
// "width" runs along X; when facing ±X it runs along Y.
const isYFacing = (dir: Dir): boolean => dir === "+y" || dir === "-y";

// The OUTWARD unit normal of the front face (points the way `dir` faces).
const frontNormal = (dir: Dir): [number, number] =>
  dir === "+y" ? [0, 1] : dir === "-y" ? [0, -1] : dir === "+x" ? [1, 0] : [-1, 0];

export function cabinetParts(c: Cabinet): PartBox[] {
  const kindKey = c.kind && CABINET_KINDS[c.kind] ? c.kind : "base";
  const def = CABINET_KINDS[kindKey];
  const x0 = c.x, y0 = c.y, x1 = c.x + c.w, y1 = c.y + c.d;
  const dir = c.dir || "+y";
  const h = c.h ?? def.h;
  const mount = c.mount ?? def.mount;
  const col = c.color || "#9aa3ad";
  const counterColor = c.counterColor || COUNTER_COLOR;
  const front = c.front === "shaker" ? "shaker" : "slab";
  const wantCounter = (c.counter ?? def.counter) && kindKey === "base";
  const wantToe = def.toeKick;
  const drawers = kindKey === "wall" ? 0 : Math.max(0, Math.min(3, c.drawers ?? 0));
  const parts: PartBox[] = [];

  const yFace = isYFacing(dir);
  // face-axis run length (along the doors) and its world span [f0,f1]
  const faceLen = yFace ? (x1 - x0) : (y1 - y0);
  const faceLo = yFace ? x0 : y0;
  const [nx, ny] = frontNormal(dir);

  // carcass vertical span: from toe-kick top (or mount) up to the counter underside
  const carcassZ0 = mount + (wantToe ? TOE_H : 0);
  const carcassTop = mount + h - (wantCounter ? COUNTER_T : 0);

  // ---- toe kick (base/tall): inset on the front face, full height TOE_H -----
  if (wantToe && mount + TOE_H > mount + 1e-6) {
    // shrink the footprint on the front face by TOE_INSET, then place TOE_H tall
    const [tx0, ty0, tx1, ty1] = insetFront(x0, y0, x1, y1, dir, TOE_INSET);
    parts.push(box(tx0, ty0, tx1, ty1, mount, mount + TOE_H, shade(col, -0.25)));
  }

  // ---- carcass --------------------------------------------------------------
  parts.push(box(x0, y0, x1, y1, carcassZ0, carcassTop, col));

  // ---- fronts (doors + drawers) on the dir face -----------------------------
  // The front faces are PROUD of the carcass front by FRONT_PROUD. Split the run
  // into nDoors bays of ≤ BAY_MAX; drawer rows sit at the TOP of every bay.
  const nDoors = Math.max(1, Math.ceil(faceLen / BAY_MAX));
  const bayLen = faceLen / nDoors;
  // the front-face outer plane is the carcass edge + FRONT_PROUD outward
  const faceZ0 = carcassZ0, faceZTop = carcassTop;
  const drawerBandH = Math.min(drawers * DRAWER_H, Math.max(0, faceZTop - faceZ0 - 0.2));
  const drawerRowH = drawers > 0 ? drawerBandH / drawers : 0;
  const doorZTop = faceZTop - drawerBandH;            // doors stop below the drawer band

  for (let b = 0; b < nDoors; b++) {
    const bLo = faceLo + b * bayLen, bHi = bLo + bayLen;
    // door (lower portion of the bay)
    if (doorZTop - faceZ0 > 0.05) {
      pushFace(parts, dir, bLo, bHi, faceZ0, doorZTop, x0, y0, x1, y1, front, col, nx, ny);
      // door pull: vertical bar on the latch side (bay edge nearest the bay center
      // gap — use the inner edge for a 1-door bay, alternate otherwise). Place near
      // the top of the door.
      const latchAtHi = b < nDoors - 1 || nDoors === 1 ? false : true;
      pushDoorPull(parts, dir, bLo, bHi, faceZ0, doorZTop, x0, y0, x1, y1, nx, ny, latchAtHi);
    }
    // drawer rows (top of the bay), top-down
    for (let r = 0; r < drawers; r++) {
      const dHi = faceZTop - r * drawerRowH, dLo = dHi - drawerRowH;
      pushFace(parts, dir, bLo, bHi, dLo, dHi, x0, y0, x1, y1, front, col, nx, ny);
      pushDrawerPull(parts, dir, bLo, bHi, dLo, dHi, x0, y0, x1, y1, nx, ny);
    }
  }

  // ---- countertop (base + counter): slab with overhang ----------------------
  if (wantCounter) {
    // overhang on the FRONT + the two exposed SIDES (not the back, which is the wall).
    const [cx0, cy0, cx1, cy1] = counterFootprint(x0, y0, x1, y1, dir, COUNTER_OVER);
    parts.push(box(cx0, cy0, cx1, cy1, carcassTop, carcassTop + COUNTER_T, counterColor));
  }

  return parts;
}

// Shrink a footprint inward from the FRONT face by `t` (used by the toe kick).
function insetFront(x0: number, y0: number, x1: number, y1: number, dir: Dir, t: number): Rect {
  if (dir === "+y") return [x0, y0, x1, y1 - t];
  if (dir === "-y") return [x0, y0 + t, x1, y1];
  if (dir === "+x") return [x0, y0, x1 - t, y1];
  return [x0 + t, y0, x1, y1];   // -x
}

// Countertop footprint: footprint + overhang on the front + the two SIDE edges,
// flush at the back (the wall). The back edge is the one opposite `dir`.
function counterFootprint(x0: number, y0: number, x1: number, y1: number, dir: Dir, over: number): Rect {
  const a: Rect = [x0 - over, y0 - over, x1 + over, y1 + over];   // start: overhang all round
  // remove the overhang on the BACK edge (opposite the front normal)
  if (dir === "+y") a[1] = y0;        // back is -y
  else if (dir === "-y") a[3] = y1;   // back is +y
  else if (dir === "+x") a[0] = x0;   // back is -x
  else a[2] = x1;                     // back is +x
  return a;
}

// Place a front FACE (door or drawer) on the dir face, spanning the run [bLo,bHi]
// (face-axis world coords) and z [z0,z1], proud of the carcass front. For shaker:
// a frame of rails/stiles (SHAKER_RAIL wide) + a recessed center panel.
function pushFace(
  parts: PartBox[], dir: Dir, bLo: number, bHi: number, z0: number, z1: number,
  x0: number, y0: number, x1: number, y1: number, front: string, col: string, nx: number, ny: number,
) {
  const yFace = (dir === "+y" || dir === "-y");
  // the carcass front plane along the cross-axis
  const frontC = dir === "+y" ? y1 : dir === "-y" ? y0 : dir === "+x" ? x1 : x0;
  // outer plane of the proud face
  const cross0 = frontC, cross1 = frontC + (yFace ? ny : nx) * FRONT_PROUD;
  const clo = Math.min(cross0, cross1), chi = Math.max(cross0, cross1);
  const gap = 0.03;                                  // reveal between faces
  const fLo = bLo + gap, fHi = bHi - gap;
  if (fHi - fLo < 0.02 || z1 - z0 < 0.02) return;

  const faceBox = (a0: number, a1: number, zz0: number, zz1: number, cc0: number, cc1: number, color: string) => {
    if (yFace) parts.push(box(a0, cc0, a1, cc1, zz0, zz1, color));
    else parts.push(box(cc0, a0, cc1, a1, zz0, zz1, color));   // a-axis = Y when ±x
  };

  if (front === "shaker") {
    // outer frame: a thin slab (rails + stiles); recessed panel sits behind it.
    const r = Math.min(SHAKER_RAIL, (fHi - fLo) / 2 - 0.01, (z1 - z0) / 2 - 0.01);
    const panelChi = clo + (chi - clo) - SHAKER_PANEL_T;   // panel is recessed (inner)
    const panelClo = panelChi - SHAKER_PANEL_T;
    // frame as 4 rails/stiles spanning the face thickness
    faceBox(fLo, fHi, z0, z0 + r, clo, chi, col);            // bottom rail
    faceBox(fLo, fHi, z1 - r, z1, clo, chi, col);            // top rail
    faceBox(fLo, fLo + r, z0 + r, z1 - r, clo, chi, col);    // left stile
    faceBox(fHi - r, fHi, z0 + r, z1 - r, clo, chi, col);    // right stile
    // recessed center panel
    faceBox(fLo + r, fHi - r, z0 + r, z1 - r, panelClo, panelChi, shade(col, -0.08));
  } else {
    // slab: one box proud of the front face
    faceBox(fLo, fHi, z0, z1, clo, chi, col);
  }
}

// Vertical door pull on the latch side of a door face.
function pushDoorPull(
  parts: PartBox[], dir: Dir, bLo: number, bHi: number, z0: number, z1: number,
  x0: number, y0: number, x1: number, y1: number, nx: number, ny: number, latchAtHi: boolean,
) {
  const yFace = (dir === "+y" || dir === "-y");
  const frontC = dir === "+y" ? y1 : dir === "-y" ? y0 : dir === "+x" ? x1 : x0;
  const pc0 = frontC + (yFace ? ny : nx) * FRONT_PROUD;
  const pc1 = pc0 + (yFace ? ny : nx) * PULL_W;
  const clo = Math.min(pc0, pc1), chi = Math.max(pc0, pc1);
  const inset = 0.12;
  // latch side = the bay edge nearer the center; pick the high edge by default.
  const aCenter = latchAtHi ? (bHi - inset - PULL_W) : (bLo + inset);
  const a0 = aCenter, a1 = aCenter + PULL_W;
  const zc = (z0 + z1) / 2, pz0 = zc - PULL_LEN / 2, pz1 = zc + PULL_LEN / 2;
  if (pz1 - pz0 < 0.02) return;
  if (yFace) parts.push(box(a0, clo, a1, chi, pz0, pz1, PULL_COLOR));
  else parts.push(box(clo, a0, chi, a1, pz0, pz1, PULL_COLOR));
}

// Horizontal drawer pull, centered on the drawer face.
function pushDrawerPull(
  parts: PartBox[], dir: Dir, bLo: number, bHi: number, z0: number, z1: number,
  x0: number, y0: number, x1: number, y1: number, nx: number, ny: number,
) {
  const yFace = (dir === "+y" || dir === "-y");
  const frontC = dir === "+y" ? y1 : dir === "-y" ? y0 : dir === "+x" ? x1 : x0;
  const pc0 = frontC + (yFace ? ny : nx) * FRONT_PROUD;
  const pc1 = pc0 + (yFace ? ny : nx) * PULL_W;
  const clo = Math.min(pc0, pc1), chi = Math.max(pc0, pc1);
  const ac = (bLo + bHi) / 2, a0 = ac - PULL_LEN / 2, a1 = ac + PULL_LEN / 2;
  const zc = (z0 + z1) / 2, pz0 = zc - PULL_W / 2, pz1 = zc + PULL_W / 2;
  if (a1 - a0 < 0.02) return;
  if (yFace) parts.push(box(a0, clo, a1, chi, pz0, pz1, PULL_COLOR));
  else parts.push(box(clo, a0, chi, a1, pz0, pz1, PULL_COLOR));
}

// Bay/door count for a width — exported for tests.
export const cabinetDoorCount = (w: number): number => Math.max(1, Math.ceil(w / BAY_MAX));
