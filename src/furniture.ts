// FURNITURE — placeable pieces (cabinets, kitchen island, beds, couches) that
// sit on a level's floor. Like stairs, a furniture piece is its OWN kind of
// object (not a room or a wall opening): a footprint rectangle {x, y, w, d} on a
// `level`, a `type`, an overall height `h`, a facing direction `dir`
// ("+x"/"-x"/"+y"/"-y", where the FRONT of the piece faces that way), and an
// optional `color` override.
//
// `furnitureParts(f)` is the single source of truth for a piece's geometry: it
// returns a list of axis-aligned colored boxes (absolute X/Y in feet, Z measured
// from the floor at 0). It is PURE — shared by the three.js viewer (buildFurnitureGeo)
// and the OpenSCAD export (scad.js) so both build identical pieces.

import type { PartBox, Furniture, Dir } from "./types.ts";

interface FurnTypeDef { label: string; w: number; d: number; h: number; color: string; }

// Per-type defaults: footprint (w × d, feet), height h, and base color.
export const FURNITURE_TYPES: Record<string, FurnTypeDef> = {
  cabinet: { label: "Cabinet", w: 2.0, d: 2.0, h: 3.0, color: "#b89a72" },
  island:  { label: "Island",  w: 6.0, d: 3.0, h: 3.0, color: "#8d7a5e" },
  bed:     { label: "Bed",     w: 5.0, d: 6.7, h: 2.6, color: "#8a6f4e" },
  couch:   { label: "Couch",   w: 6.5, d: 3.0, h: 2.6, color: "#6f7e8c" },
};
export const FURNITURE_ORDER = ["cabinet", "island", "bed", "couch"];

const COUNTER_COLOR = "#dcd8d0";   // stone countertop
const BEDDING_COLOR = "#e9e5dc";   // mattress / duvet
const PILLOW_COLOR  = "#f4f0e8";

// lighten/darken a #rrggbb hex by amt in [-1,1] (cushions read against the frame).
export function shade(hex: string, amt: number): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + 255 * amt)));
  const r = f((n >> 16) & 255), g = f((n >> 8) & 255), b = f(n & 255);
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

export const box = (
  x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, color: string,
): PartBox => ({
  cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, cz: (z0 + z1) / 2,
  sx: Math.abs(x1 - x0), sy: Math.abs(y1 - y0), sz: Math.abs(z1 - z0), color,
});

type Rect = [number, number, number, number];

// thin slab along the BACK edge (opposite the facing dir) of a footprint.
// Exported so cabinets.js (Phase 5) can reuse the same dir math as furniture.
export const backRect = (x0: number, y0: number, x1: number, y1: number, dir: Dir, t: number): Rect =>
  dir === "+y" ? [x0, y0, x1, y0 + t] :
  dir === "-y" ? [x0, y1 - t, x1, y1] :
  dir === "+x" ? [x0, y0, x0 + t, y1] :
                 [x1 - t, y0, x1, y1];   // -x
// the two SIDE edges (perpendicular to the back)
export const sideRects = (x0: number, y0: number, x1: number, y1: number, dir: Dir, t: number): Rect[] =>
  (dir === "+y" || dir === "-y")
    ? [[x0, y0, x0 + t, y1], [x1 - t, y0, x1, y1]]
    : [[x0, y0, x1, y0 + t], [x0, y1 - t, x1, y1]];

export function furnitureParts(f: Furniture): PartBox[] {
  const type = FURNITURE_TYPES[f.type] ? f.type : "cabinet";
  const def = FURNITURE_TYPES[type];
  const x0 = f.x, y0 = f.y, x1 = f.x + f.w, y1 = f.y + f.d;
  const h = f.h ?? def.h;
  const dir = f.dir || "+y";
  const col = f.color || def.color;
  const parts: PartBox[] = [];

  if (type === "cabinet" || type === "island") {
    const over = type === "island" ? 0.15 : 0.1;     // countertop overhang (island floats free)
    const counterT = 0.16;
    parts.push(box(x0, y0, x1, y1, 0, h - counterT, col));                              // cabinet body
    parts.push(box(x0 - over, y0 - over, x1 + over, y1 + over, h - counterT, h, COUNTER_COLOR));  // countertop
  } else if (type === "bed") {
    const frameT = 0.25, baseTop = 0.55, mattTop = Math.max(baseTop + 0.3, h - 0.9);
    parts.push(box(x0, y0, x1, y1, 0, baseTop, col));                                   // bed frame / box
    parts.push(box(x0 + frameT, y0 + frameT, x1 - frameT, y1 - frameT, baseTop, mattTop, BEDDING_COLOR)); // mattress
    const [bx0, by0, bx1, by1] = backRect(x0, y0, x1, y1, dir, 0.3);                    // headboard at the back
    parts.push(box(bx0, by0, bx1, by1, 0, h, col));
    // two pillows laid along the head end, on top of the mattress
    const along = (dir === "+y" || dir === "-y");                                       // head spans X (pillows side by side in X)
    const py0 = dir === "+y" ? by1 : dir === "-y" ? by0 - 1.3 : y0 + frameT;
    const pillowD = 1.3;
    for (const k of [0, 1]) {
      if (along) {
        const w2 = (x1 - x0 - 2 * frameT) / 2, px = x0 + frameT + k * w2;
        const a = dir === "+y" ? by1 + 0.05 : by0 - 0.05 - pillowD;
        parts.push(box(px + 0.15, a, px + w2 - 0.15, a + pillowD, mattTop, mattTop + 0.45, PILLOW_COLOR));
      } else {
        const d2 = (y1 - y0 - 2 * frameT) / 2, py = y0 + frameT + k * d2;
        const a = dir === "+x" ? bx1 + 0.05 : bx0 - 0.05 - pillowD;
        parts.push(box(a, py + 0.15, a + pillowD, py + d2 - 0.15, mattTop, mattTop + 0.45, PILLOW_COLOR));
      }
    }
  } else if (type === "couch") {
    const seatTop = Math.min(0.9, h * 0.45), cushionTop = seatTop + 0.3, armT = 0.5, backT = 0.55;
    // backrest along the back; arms along the two sides; seat between them
    const [bx0, by0, bx1, by1] = backRect(x0, y0, x1, y1, dir, backT);
    parts.push(box(bx0, by0, bx1, by1, 0, h, col));                                     // backrest
    for (const [sx0, sy0, sx1, sy1] of sideRects(x0, y0, x1, y1, dir, armT))
      parts.push(box(sx0, sy0, sx1, sy1, 0, h * 0.62, col));                            // arms
    // seat base + back cushions, inset from arms/back
    const along = (dir === "+y" || dir === "-y");
    const sx0 = along ? x0 + armT : (dir === "+x" ? bx1 : x0);
    const sx1 = along ? x1 - armT : (dir === "-x" ? bx0 : x1);
    const sy0 = along ? (dir === "+y" ? by1 : y0) : y0 + armT;
    const sy1 = along ? (dir === "-y" ? by0 : y1) : y1 - armT;
    parts.push(box(sx0, sy0, sx1, sy1, 0, seatTop, col));                               // seat base
    parts.push(box(sx0 + 0.1, sy0 + 0.1, sx1 - 0.1, sy1 - 0.1, seatTop, cushionTop, shade(col, 0.1))); // seat cushion
  }
  return parts;
}
