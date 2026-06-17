// Standalone OpenSCAD generator (export format). Produces ONE connected solid:
// walls are a CSG shell — union(rooms grown by WALL_OUT) − union(rooms shrunk by
// WALL_IN) — so adjacent rooms share a single partition (no disjoint double
// walls) and the building has one continuous exterior shell. Floors are per-room
// slabs; doors are cut from the shell and drawn with a leaf + swing arc.
//
// The live viewer renders procedurally in three.js (src/main.js); this file is
// for `openscad floorplan.scad` and export only. Doors are absolute
// {level, orient, x, y, w} (rooms.js DOORS).

import { CONST, LEVEL_Z, ROOF } from "./rooms.ts";
import { stairFloorOpening, stairSteps } from "./walls.ts";
import { furnitureParts } from "./furniture.ts";
import { cabinetParts } from "./cabinets.ts";
import { doorLeafFrames, doorLeafParts, casingParts, CASING_W, CASING_T } from "./doors.ts";
import type {
  Room, AbsDoor, AbsWindow, Roof, Stair, Furniture, Cabinet, MldRunRow,
} from "./types.ts";

// solid wall left above each doorway → styled-leaf height (mirrors main.js doorTop)
const scadDoorH = () => Math.min(Math.max(0.3, CONST.WALL_H - Math.min(1.2, CONST.WALL_H - 0.3)), 6.8);

const rectRing = (x: number, y: number, w: number, d: number): number[][] =>
  [[x - w / 2, y - d / 2], [x + w / 2, y - d / 2], [x + w / 2, y + d / 2], [x - w / 2, y + d / 2]];

const DIR_CODE: Record<string, number> = { "+x": 0, "-x": 1, "+y": 2, "-y": 3 };

// Profile sub-box fractions [zFrac0, zFrac1, dFrac], keyed by PROFILE_CODE
// (0 square · 1 stepped · 2 cove) — MUST stay in sync with MOULDING_PROFILES in
// src/moulding.js. Duplicated here so scad.js stays dependency-free.
const MLD_PROFILE_BOXES = [
  [[0, 1, 1.0]],                                   // 0 square
  [[0, 0.8, 0.7], [0.8, 1, 1.0]],                  // 1 stepped
  [[0, 0.55, 1.0], [0.55, 0.8, 0.66], [0.8, 1, 0.33]],  // 2 cove
];

// mldRuns: PRECOMPUTED run rows (main.js passes them so scad.js stays dumb):
//   [level, ax, ay, bx, by, z0, h, d, profileCode, crown(0|1), "color"]
export function roomsToScad(
  rooms: Room[], doors: AbsDoor[], windows: AbsWindow[] = [], roof: Roof = ROOF,
  stairs: Stair[] = [], furniture: Furniture[] = [], mldRuns: MldRunRow[] = [], cabinets: Cabinet[] = [],
): string {
  // normalize roof openings to point-rings (cuts) + [x,y,w,d] (skylights)
  const cutRings = (roof.cuts || []).map((c) => c.poly || rectRing(c.x!, c.y!, c.w!, c.d!));
  const skies = (roof.skylights || []).map((s) => [s.x, s.y, s.w, s.d]);
  const roofCutsSrc = cutRings.map((r) => `  [${r.map(([x, y]) => `[${x}, ${y}]`).join(", ")}],`).join("\n");
  const skiesSrc = skies.map((s) => `  [${s.join(", ")}],`).join("\n");
  const rows = rooms.map((r) =>
    `  [${r.x}, ${r.y}, ${r.w}, ${r.d}, ${LEVEL_Z[r.level]}, ${r.open ? 1 : 0}, ${r.level}], // ${r.name}`).join("\n");
  const cols = rooms.map((r) => `  "${r.color}",`).join("\n");
  const polys = rooms.map((r) =>
    `  ${r.poly ? `[${r.poly.map(([x, y]) => `[${x}, ${y}]`).join(", ")}]` : "[]"}, // ${r.name}`).join("\n");
  const doorRows = doors.map((d) =>
    `  [${d.level}, ${d.orient === "v" ? 1 : 0}, ${d.x}, ${d.y}, ${d.w}],`).join("\n");
  const winRows = windows.map((d) =>
    `  [${d.level}, ${d.orient === "v" ? 1 : 0}, ${d.x}, ${d.y}, ${d.w}, ${d.sill ?? 1.2}, ${d.h ?? 2.0}],`).join("\n");
  const stairRows = stairs.map((s) => {
    const floor = LEVEL_Z[s.level] ?? 0;            // anchor: the stair's level floor
    const base = +(floor - (s.down ?? 0)).toFixed(4), top = +(floor + (s.up ?? 0)).toFixed(4);
    return `  [${s.level}, ${s.x}, ${s.y}, ${s.w}, ${s.d}, ${DIR_CODE[s.dir ?? "+y"] ?? 2}, ${s.steps}, ${base}, ${top}], // ${s.name ?? "stair"}`;
  }).join("\n");
  // Stair SOLID as oriented step/landing boxes (computed via the shared
  // stairSteps(), so the .scad matches the viewer exactly — including turning
  // stairs with landings). Each row: [cx, cy, z0, l, w, h, yawDeg, level].
  const stairPartRows = stairs.flatMap((s) => {
    const fz = LEVEL_Z[s.level] ?? 0;
    return stairSteps(s, fz)
      .filter((st) => st.l > 1e-4 && st.w > 1e-4 && st.z1 - st.z0 > 1e-4)
      .map((st) => `  [${+st.cx.toFixed(3)}, ${+st.cy.toFixed(3)}, ${+st.z0.toFixed(3)}, ` +
        `${+st.l.toFixed(3)}, ${+st.w.toFixed(3)}, ${+(st.z1 - st.z0).toFixed(3)}, ` +
        `${+((st.ang * 180) / Math.PI).toFixed(3)}, ${s.level}],`);
  }).join("\n");
  // Stairwell cuts (computed in the REAL/stacked frame: floors WALL_H + SLAB
  // apart). A stair on level L spans [floor(L) - down, floor(L) + up]; for each
  // level it carves the height band out of crossed walls and punches the (inset)
  // footprint through any floor slab strictly inside that span. Local Z within a
  // level's walls is 0..WALL_H (the walls are drawn inside translate LEVELZ).
  // Furniture: flatten each piece to its colored boxes (furnitureParts is the
  // shared geometry, so the .scad matches the viewer). Z is absolute (level floor
  // + local). Each row = [x, y, z, sx, sy, sz, "color", level].
  const furnRows = furniture.flatMap((f) => {
    const fz = LEVEL_Z[f.level] ?? 0;
    return furnitureParts(f).map((p) =>
      `  [${+(p.cx - p.sx / 2).toFixed(3)}, ${+(p.cy - p.sy / 2).toFixed(3)}, ${+(fz + p.cz - p.sz / 2).toFixed(3)}, ` +
      `${+p.sx.toFixed(3)}, ${+p.sy.toFixed(3)}, ${+p.sz.toFixed(3)}, "${p.color}", ${f.level}],`);
  }).join("\n");

  // Cabinets (Phase 5): flatten each cabinet to its colored boxes (cabinetParts is
  // the shared geometry, so the .scad matches the viewer). Z is absolute (level
  // floor + local, where local already includes `mount`). Row = [x, y, z, sx, sy,
  // sz, "color", level] — same shape as FURN_PARTS, drawn by cab_parts().
  const cabRows = cabinets.flatMap((c) => {
    const cz = LEVEL_Z[c.level] ?? 0;
    return cabinetParts(c).map((p) =>
      `  [${+(p.cx - p.sx / 2).toFixed(3)}, ${+(p.cy - p.sy / 2).toFixed(3)}, ${+(cz + p.cz - p.sz / 2).toFixed(3)}, ` +
      `${+p.sx.toFixed(3)}, ${+p.sy.toFixed(3)}, ${+p.sz.toFixed(3)}, "${p.color}", ${c.level}],`);
  }).join("\n");

  // ---- Door v2 (Phase 3): styled leaves + casing ----------------------------
  // Each door flattens to leaf PLACEMENTS (hinge + base angle + swing sign) and
  // leaf-local PARTS (boxes in the leaf frame). door_leaves() draws them with
  //   translate(hinge) rotate([0,0,base + swingSign*DOOR_OPEN]) translate(part) cube
  // so -D DOOR_OPEN keeps swinging the leaves. Glass parts (glass01=1) are unioned
  // in the glass color/alpha. Casing emits per-face trim boxes oriented to the wall.
  const doorH = scadDoorH();
  const leafRows: string[] = [], leafPartRows: string[] = [], casingRows: string[] = [];
  doors.forEach((d) => {
    const frames = doorLeafFrames(d.style || "slab", d.x, d.y, d.w, d.ang ?? (d.orient === "v" ? 90 : 0), d.side ?? 1, d.hand ?? 1);
    frames.forEach((fr) => {
      const li = leafRows.length;
      // sign column = swingSign for swing leaves, slideSign for sliding leaves
      // (slide01 column tells door_leaves() which interpretation to use).
      const slide = fr.mode === "slide";
      const sign = slide ? (fr.slideSign || 0) : fr.swingSign;
      leafRows.push(`  [${d.level}, ${+fr.hx.toFixed(3)}, ${+fr.hy.toFixed(3)}, ${+fr.baseDeg.toFixed(3)}, ${sign}, ${+fr.w.toFixed(3)}, ${+doorH.toFixed(3)}, ${li}, ${slide ? 1 : 0}],`);
      const { solids, glass } = doorLeafParts(fr.leaf, fr.w, doorH, d.color || "#8a5a3c");
      for (const b of solids) leafPartRows.push(
        `  [${li}, ${+b.x0.toFixed(3)}, ${+b.y0.toFixed(3)}, ${+b.z0.toFixed(3)}, ` +
        `${+(b.x1 - b.x0).toFixed(3)}, ${+(b.y1 - b.y0).toFixed(3)}, ${+(b.z1 - b.z0).toFixed(3)}, 0, "${b.color || d.color || "#8a5a3c"}"],`);
      for (const b of glass) leafPartRows.push(
        `  [${li}, ${+b.x0.toFixed(3)}, ${+b.y0.toFixed(3)}, ${+b.z0.toFixed(3)}, ` +
        `${+(b.x1 - b.x0).toFixed(3)}, ${+(b.y1 - b.y0).toFixed(3)}, ${+(b.z1 - b.z0).toFixed(3)}, 1, "${d.color || "#8a5a3c"}"],`);
    });
    // casing: WALL-LOCAL boxes placed at the opening center, oriented along the wall.
    if (d.casing) {
      const wallDeg = d.ang ?? (d.orient === "v" ? 90 : 0);
      for (const cb of casingParts(d.w, doorH, 0.5)) {
        casingRows.push(`  [${d.level}, ${+d.x.toFixed(3)}, ${+d.y.toFixed(3)}, ${+wallDeg.toFixed(3)}, ` +
          `${+cb.x0.toFixed(3)}, ${+cb.y0.toFixed(3)}, ${+cb.z0.toFixed(3)}, ` +
          `${+(cb.x1 - cb.x0).toFixed(3)}, ${+(cb.y1 - cb.y0).toFixed(3)}, ${+(cb.z1 - cb.z0).toFixed(3)}],`);
      }
    }
  });

  // mouldings: precomputed run rows (level, ax,ay,bx,by, z0, h, d, profileCode, crown01, color)
  const mldRows = mldRuns.map((r) =>
    `  [${r[0]}, ${+r[1].toFixed(3)}, ${+r[2].toFixed(3)}, ${+r[3].toFixed(3)}, ${+r[4].toFixed(3)}, ` +
    `${+r[5].toFixed(3)}, ${+r[6].toFixed(3)}, ${+r[7].toFixed(3)}, ${r[8]}, ${r[9]}, "${r[10]}"],`).join("\n");

  const INTER = CONST.WALL_H + CONST.SLAB, INS = 0.5;
  const wallCutRows: string[] = [], floorCutRows: string[] = [];
  for (const s of stairs) {
    const sf = s.level * INTER, top = sf + (s.up ?? 0), base = sf - (s.down ?? 0);
    const sx = s.x ?? 0, sy = s.y ?? 0, sw = s.w ?? 0, sd = s.d ?? 0;
    // walls: inset footprint (keep the shaft's own perimeter walls)
    const wx0 = +(sx + INS).toFixed(3), wy0 = +(sy + INS).toFixed(3), wx1 = +(sx + sw - INS).toFixed(3), wy1 = +(sy + sd - INS).toFixed(3);
    // floors: WHOLE footprint + headroom at the top, so a person can walk the flight
    const fo = stairFloorOpening(s);
    const fx0 = +fo.x0.toFixed(3), fy0 = +fo.y0.toFixed(3), fx1 = +fo.x1.toFixed(3), fy1 = +fo.y1.toFixed(3);
    const fcx = sx + sw / 2, fcy = sy + sd / 2;   // footprint centroid (gates the floor cut)
    const overFloor = (lvl: number) => rooms.some((r) => r.level === lvl && fcx >= r.x && fcx <= r.x + r.w && fcy >= r.y && fcy <= r.y + r.d);
    for (const lvl of [0, 1]) {
      const wb0 = lvl * INTER, wb1 = wb0 + CONST.WALL_H;
      const cb = Math.max(base, wb0), ct = Math.min(top, wb1);
      if (ct - cb >= 0.1 && wx1 - wx0 > 0.05 && wy1 - wy0 > 0.05)
        wallCutRows.push(`  [${lvl}, ${wx0}, ${wy0}, ${wx1}, ${wy1}, ${+(cb - wb0).toFixed(3)}, ${+(ct - wb0).toFixed(3)}],`);
      const fz = lvl * INTER;                        // this level's floor height (real frame)
      if (fz > base + 0.05 && fz <= top + 0.01 && overFloor(lvl)) floorCutRows.push(`  [${lvl}, ${fx0}, ${fy0}, ${fx1}, ${fy1}],`);
    }
  }

  return `// floorplan.scad — exploded dollhouse
// GENERATED from src/rooms.ts by tools/gen-scad.ts — do not edit by hand.
//   MODE 0 floors · 1 walls · 2 both (default)   LVL -1 both / 0 / 1

MODE = 2;
LVL  = -1;
WALL_H = ${CONST.WALL_H};
SLAB   = ${CONST.SLAB};
// wall network = union(rooms grown by WALL_OUT) minus union(rooms shrunk by
// WALL_IN); WALL_OUT bridges the sub-foot gaps so the shell is continuous.
WALL_OUT = 0.45;
WALL_IN  = 0.15;
DOOR_SPAN = 2.2;   // how far a door cut reaches across a wall
DOOR_OPEN = 80;    // door leaf swing (deg)
DOOR_HEAD = 1.2;   // solid wall left above each doorway
WIN_SILL = 1.2;    // window sill height
WIN_HEAD = 0.6;    // window header thickness (from top)
ROOF_T   = ${roof.thickness ?? 0.4};   // roof slab thickness
ROOFZ    = ${LEVEL_Z[1]} + WALL_H;     // roof sits on top of the main walls

ROOMS = [
${rows}
];
COLS = [
${cols}
];
POLYS = [
${polys}
];
// doors: [level, orient(0=h,1=v), x, y, clear_width]
DOORS = [
${doorRows}
];
// windows: [level, orient(0=h,1=v), x, y, clear_width]
WINDOWS = [
${winRows}
];
// roof: open-to-sky CUTS (point rings) + glazed SKYLIGHTS [x,y,w,d]
ROOF_CUTS = [
${roofCutsSrc}
];
SKYLIGHTS = [
${skiesSrc}
];
// stairs: [level, x, y, w, d, dir(0=+x,1=-x,2=+y,3=-y), steps, base_z, top_z]
// (footprint metadata; the rendered solid is STAIR_PARTS below)
STAIRS = [
${stairRows}
];
// stair solid: oriented step/landing boxes [cx, cy, z0, l, w, h, yawDeg, level]
STAIR_PARTS = [
${stairPartRows}
];
// stairwell wall cuts: [level, x0, y0, x1, y1, h0, h1] (local height band in that
// level's walls, 0..WALL_H); stairwell floor cuts: [level, x0, y0, x1, y1].
STAIR_WALL_CUTS = [
${wallCutRows.join("\n")}
];
STAIR_FLOOR_CUTS = [
${floorCutRows.join("\n")}
];
// furniture: flattened colored boxes [x, y, z, sx, sy, sz, "color", level]
FURN_PARTS = [
${furnRows}
];
// cabinets: flattened colored boxes [x, y, z, sx, sy, sz, "color", level]
CAB_PARTS = [
${cabRows}
];
// door leaves: [level, hingeX, hingeY, baseAngDeg, swingSign, leafW, leafH, leafIdx]
DOOR_LEAVES = [
${leafRows.join("\n")}
];
// door leaf parts (LEAF-LOCAL): [leafIdx, x0, y0, z0, sx, sy, sz, glass01, "color"]
DOOR_LEAF_PARTS = [
${leafPartRows.join("\n")}
];
// door casing: [level, openX, openY, wallAngDeg, x0, y0, z0, sx, sy, sz] (wall-local box)
CASINGS = [
${casingRows.join("\n")}
];
// mouldings: precomputed run rows
//   [level, ax, ay, bx, by, z0, h, d, profileCode, crown(0|1), "color"]
MLD_RUNS = [
${mldRows}
];
// profile sub-boxes [zFrac0, zFrac1, dFrac] per profileCode (0 square·1 stepped·2 cove)
// — KEEP IN SYNC with MOULDING_PROFILES in src/moulding.js.
MLD_PROFILES = [
  [[0, 1, 1.0]],
  [[0, 0.8, 0.7], [0.8, 1, 1.0]],
  [[0, 0.55, 1.0], [0.55, 0.8, 0.66], [0.8, 1, 0.33]],
];
LEVELZ = [${LEVEL_Z[0]}, ${LEVEL_Z[1]}];

// 2D footprint of room i, expanded by off (negative = shrink)
module room_2d(i, off) {
  if (len(POLYS[i]) > 0) offset(off) polygon(POLYS[i]);
  else offset(off) translate([ROOMS[i][0], ROOMS[i][1]]) square([ROOMS[i][2], ROOMS[i][3]]);
}
module floor_slab(i, z, col) {
  difference() {
    if (len(POLYS[i]) > 0)
      color(col) translate([0, 0, z - SLAB]) linear_extrude(SLAB) polygon(POLYS[i]);
    else color(col) translate([ROOMS[i][0], ROOMS[i][1], z - SLAB]) cube([ROOMS[i][2], ROOMS[i][3], SLAB]);
    // stairwell openings punched through this room's floor (level = ROOMS[i][6])
    for (c = STAIR_FLOOR_CUTS) if (c[0] == ROOMS[i][6])
      translate([c[1], c[2], z - SLAB - 0.1]) cube([c[3] - c[1], c[4] - c[2], SLAB + 0.2]);
  }
}
// a stairwell opening carved out of a level's walls: footprint × local height
// band [h0,h1] (over-extended past the wall top/bottom when flush, for clean CSG).
module stair_wall_cut(c) {
  z0 = (c[5] <= 0.01) ? -0.2 : c[5];
  z1 = (c[6] >= WALL_H - 0.01) ? WALL_H + 0.2 : c[6];
  translate([c[1], c[2], z0]) cube([c[3] - c[1], c[4] - c[2], z1 - z0]);
}

// doorway cut (local Z frame), absolute position, oriented h/v
// cut only as high as the (capped) door leaf — leaf height is min(doorTop, 6.8),
// so on tall walls the wall above 6.8 stays solid and a shut door seals (no gap).
function door_z1() = min(max(0.3, WALL_H - min(DOOR_HEAD, WALL_H - 0.3)), 6.8);
module door_cut(d) {
  o = d[1]; x = d[2]; y = d[3]; w = d[4];
  if (o == 0) translate([x - w/2, y - DOOR_SPAN/2, -0.2]) cube([w, DOOR_SPAN, door_z1() + 0.2]);
  else        translate([x - DOOR_SPAN/2, y - w/2, -0.2]) cube([DOOR_SPAN, w, door_z1() + 0.2]);
}
// window: cut only the band [sill, sill+h] (sill + header remain), add glass.
// per-window sill = d[5], height = d[6]
function win_z0(d) = max(0, min(d[5], WALL_H - 0.3));
function win_z1(d) = min(WALL_H, win_z0(d) + max(0.3, d[6]));
module window_cut(d) {
  o = d[1]; x = d[2]; y = d[3]; w = d[4]; z0 = win_z0(d); h = win_z1(d) - win_z0(d);
  if (o == 0) translate([x - w/2, y - DOOR_SPAN/2, z0]) cube([w, DOOR_SPAN, h]);
  else        translate([x - DOOR_SPAN/2, y - w/2, z0]) cube([DOOR_SPAN, w, h]);
}
module window_glass(d) {
  o = d[1]; x = d[2]; y = d[3]; w = d[4]; z0 = win_z0(d); z1 = win_z1(d);
  color([0.62, 0.82, 0.88, 0.5]) translate([x, y, (z0 + z1) / 2]) rotate([0, 0, o == 0 ? 0 : 90])
    translate([-w/2, -0.05, -(z1 - z0)/2]) cube([w, 0.1, z1 - z0]);
}
function arc_pts(r, a0, a1, n) = [for (i = [0:n]) let (a = a0 + (a1 - a0) * i / n) [r*cos(a), r*sin(a)]];
// Door v2: styled leaves drawn from DOOR_LEAVES (placement) + DOOR_LEAF_PARTS
// (leaf-local boxes). The swing angle = baseAng + swingSign*DOOR_OPEN, so the
// -D DOOR_OPEN parameter still swings every leaf. Per-part color; glass parts
// (part[7]==1) drawn in the glass color/alpha. Swing arc per leaf on the floor.
GLASS_COL = [0.62, 0.82, 0.88, 0.5];
module door_leaves(level) {
  for (lf = DOOR_LEAVES) if (lf[0] == level) {
    li = lf[7]; slide = lf[8] == 1;
    // sliding leaves keep the base angle and TRANSLATE along it (sign*w*frac);
    // swing leaves rotate by base + sign*DOOR_OPEN as before.
    ang = slide ? lf[3] : lf[3] + lf[4] * DOOR_OPEN;
    off = slide ? lf[4] * lf[5] * min(1, max(0, DOOR_OPEN / 110)) : 0;
    translate([lf[1], lf[2], 0]) rotate([0, 0, ang]) translate([off, 0, 0])
      for (p = DOOR_LEAF_PARTS) if (p[0] == li) {
        if (p[7] == 1) color(GLASS_COL) translate([p[1], p[2], p[3]]) cube([p[4], p[5], p[6]]);
        else           color(p[8])      translate([p[1], p[2], p[3]]) cube([p[4], p[5], p[6]]);
      }
    // swing arc (floor) at radius = leaf width; sliding leaves draw their straight
    // track over the full travel instead (fixed patio panels draw nothing).
    if (DOOR_OPEN >= 2 && !slide)
      color("#9a6a4a") translate([lf[1], lf[2], 0.06]) linear_extrude(0.05)
        polygon(concat(arc_pts(lf[5], lf[3], lf[3] + lf[4]*DOOR_OPEN, 14),
                       arc_pts(lf[5] - 0.13, lf[3] + lf[4]*DOOR_OPEN, lf[3], 14)));
    if (DOOR_OPEN >= 2 && slide && lf[4] != 0)
      color("#9a6a4a") translate([lf[1], lf[2], 0.06]) rotate([0, 0, lf[3]])
        translate([min(0, lf[4] * lf[5]), -0.04, 0]) linear_extrude(0.05)
          square([lf[5] * (1 + abs(lf[4])), 0.08]);
  }
}
// Door casing: per-face trim boxes, placed at the opening and oriented to the wall.
module casings(level) {
  for (c = CASINGS) if (c[0] == level)
    translate([c[1], c[2], 0]) rotate([0, 0, c[3]])
      translate([c[4], c[5], c[6]]) cube([c[7], c[8], c[9]]);
}
// Mouldings: each run is a wall-aligned segment painted with a stacked profile.
// Row = [level, ax, ay, bx, by, z0, h, d, profileCode, crown01, color]. For each
// profile sub-box [zFrac0, zFrac1, dFrac] (mirrored vertically when crown01),
// translate to the run start, rotate to the run angle, then place a cube of
// [len, dFrac*d, (zFrac1-zFrac0)*h] across (centered) at the right height.
module mouldings(level) {
  for (m = MLD_RUNS) if (m[0] == level) {
    ax = m[1]; ay = m[2]; bx = m[3]; by = m[4]; z0 = m[5]; h = m[6]; d = m[7];
    prof = MLD_PROFILES[m[8]]; crown = m[9];
    len = sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
    ang = atan2(by - ay, bx - ax);
    color(m[10]) translate([ax, ay, z0]) rotate([0, 0, ang])
      for (sb = prof) {
        zz = crown == 1 ? (1 - sb[1]) * h : sb[0] * h;
        hh = (sb[1] - sb[0]) * h;
        dd = sb[2] * d;
        translate([0, -dd / 2, zz]) cube([len, dd, hh]);
      }
  }
}

// Roof slab: the main-level footprint (rooms grown by WALL_OUT) extruded at
// ROOFZ, with CUTS (open to sky, e.g. the central patio) and SKYLIGHTS removed.
module roof() {
  color("${roof.color ?? "#6b6f76"}") translate([0, 0, ROOFZ]) linear_extrude(ROOF_T) difference() {
    union() { for (i = [0:len(ROOMS)-1]) if (ROOMS[i][6]==1 && ROOMS[i][5]==0) room_2d(i, WALL_OUT); }
    for (c = ROOF_CUTS) polygon(c);
    for (s = SKYLIGHTS) translate([s[0]-s[2]/2, s[1]-s[3]/2]) square([s[2], s[3]]);
  }
}
module sky_glass() {
  for (s = SKYLIGHTS)
    color([0.75, 0.9, 0.95, 0.5]) translate([s[0], s[1], ROOFZ + ROOF_T/2]) cube([s[2], s[3], 0.1], center=true);
}

// Stairs: a solid run of oriented step/landing boxes (shared geometry with the
// viewer via stairSteps). Each part [cx, cy, z0, l, w, h, yawDeg, level] is a box
// l deep along the flight, w across, yawed about its center — so straight,
// L- and U-shaped (landing) stairs all render the same way.
module stairs_parts() {
  for (p = STAIR_PARTS) if (LVL < 0 || p[7] == LVL)
    color("#b9a487") translate([p[0], p[1], p[2]]) rotate([0, 0, p[6]])
      translate([-p[3] / 2, -p[4] / 2, 0]) cube([p[3], p[4], p[5]]);
}

// Furniture: each piece is a set of colored boxes (shared geometry with the
// viewer). Drawn in absolute Z like the floor slabs / stairs.
module furniture_parts() {
  for (p = FURN_PARTS) if (LVL < 0 || p[7] == LVL)
    color(p[6]) translate([p[0], p[1], p[2]]) cube([p[3], p[4], p[5]]);
}

// Cabinets: same flattened-box pattern as furniture, kept as its own table/module
// so domains stay readable. Drawn in absolute Z (level floor + local mount).
module cab_parts() {
  for (p = CAB_PARTS) if (LVL < 0 || p[7] == LVL)
    color(p[6]) translate([p[0], p[1], p[2]]) cube([p[3], p[4], p[5]]);
}

// one continuous wall solid per level, doors subtracted, with mouldings unioned
// on so the level stays a single manifold solid.
module level_walls(level) {
  union() {
    color("#ede9e1") difference() {
      linear_extrude(WALL_H) difference() {
        union() { for (i = [0:len(ROOMS)-1]) if (ROOMS[i][6]==level && ROOMS[i][5]==0) room_2d(i,  WALL_OUT); }
        union() { for (i = [0:len(ROOMS)-1]) if (ROOMS[i][6]==level && ROOMS[i][5]==0) room_2d(i, -WALL_IN); }
      }
      for (k = [0:len(DOORS)-1]) if (DOORS[k][0] == level) door_cut(DOORS[k]);
      for (k = [0:len(WINDOWS)-1]) if (WINDOWS[k][0] == level) window_cut(WINDOWS[k]);
      if (len(STAIR_WALL_CUTS) > 0)
        for (k = [0:len(STAIR_WALL_CUTS)-1]) if (STAIR_WALL_CUTS[k][0] == level) stair_wall_cut(STAIR_WALL_CUTS[k]);
    }
    if (len(MLD_RUNS) > 0) mouldings(level);
  }
}

if (MODE != 1)
  for (i = [0:len(ROOMS)-1]) if (LVL < 0 || ROOMS[i][6] == LVL) floor_slab(i, ROOMS[i][4], COLS[i]);
if (MODE != 0)
  for (level = [0:1]) if (LVL < 0 || LVL == level) translate([0, 0, LEVELZ[level]]) {
    level_walls(level);
    color("#ede9e1") casings(level);                 // door casing trim (wall color)
    door_leaves(level);                              // styled door leaves + swing arcs + glass
    for (k = [0:len(WINDOWS)-1]) if (WINDOWS[k][0] == level) window_glass(WINDOWS[k]);
  }
// roof over the main level (with patio cut + skylights)
if (MODE != 0 && (LVL < 0 || LVL == 1)) { roof(); sky_glass(); }
// stairs (solid stepped blocks) — drawn in absolute Z like the floor slabs
if (MODE != 0 && len(STAIR_PARTS) > 0) stairs_parts();
// furniture (island, beds, couches, legacy cabinets) — colored boxes, absolute Z
if (len(FURN_PARTS) > 0) furniture_parts();
// cabinets (base / wall / tall) — colored boxes, absolute Z
if (len(CAB_PARTS) > 0) cab_parts();
`;
}
