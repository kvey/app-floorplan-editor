// Floor plan.
//
// DERIVED FROM THE SOURCE FLOOR-PLAN IMAGE, not guessed. Method:
//   - Detected the tan (main level) / gray (lower level) floor fills to find
//     each building footprint in pixels.
//   - Established scale from the two back bedrooms, whose printed dimensions
//     span the full width: 12'3" -> 135 px and 11'6" -> 127 px both give
//     ~11.03 px/ft. Cross-checked against the lower plan (same 276 px width).
//   - Extracted the wall grid (vertical/horizontal wall lines) and measured
//     each room's bounding box by scanning the floor mask out to the walls.
//   - Every room position below is the MEASURED pixel box converted to feet
//     (origin = front-left corner, X right, Y from street/front toward back),
//     reconciled against the printed room dimension where one is given.
// Rooms whose box is confirmed to match its printed label are marked "✓".
//
// The tight central core (WC, closets, second stair, hall) is drawn from the
// printed sizes + measured wall lines; those partitions are lightly drawn in
// the source image so their placement is the least precise part of the plan.
//
// Units are FEET. Both levels share the same X/Y footprint and are stacked
// (main lifted above lower) for the exploded dollhouse view.

import type { Room, AbsDoor, Roof, Stair, Furniture } from "./types.ts";

export const CONST = {
  WALL_H: 8.0,   // visible wall height (full-height interior walls — first-person walkthroughs read as real rooms)
  WALL_T: 0.4,   // wall thickness
  SLAB: 0.3,     // floor slab thickness
  EXPLODE: 6.0,  // vertical gap between the two stacked levels
  PXPF: 11.03,   // derived scale: pixels per foot
};

export const LEVEL_Z: Record<number, number> = {
  0: 0,                                              // lower level
  1: CONST.WALL_H + CONST.SLAB + CONST.EXPLODE,      // main level (= 10.3 ft)
};

// level: 0 = Lower Level, 1 = Main Level.  open:true -> slab only (no walls).
// Smaller rooms are listed before the large room they sit inside, so the
// viewer's "which room contains this point" color lookup picks the small one.
export const ROOMS: Room[] = [
  // ===== MAIN LEVEL =======================================================
  // Front band
  { name: "Entry",          x: 0.0,  y: 0.0,  w: 5.2,  d: 14.8, level: 1, color: "#bcae9a" }, // stair down + entry
  { name: "Living Room",    x: 5.2,  y: 0.0,  w: 19.2, d: 14.8, level: 1, color: "#cdbb9c" }, // ✓ 19'5"x14'8"
  // Foyer / Dining band
  { name: "Foyer",          x: 0.0,  y: 15.2, w: 9.4,  d: 6.0,  level: 1, color: "#d9c7b8" }, // ✓ 9'2"x6'0"
  { name: "Dining Room",    x: 10.2, y: 15.9, w: 14.2, d: 11.0, level: 1, color: "#c8b89a" }, // ✓ 14'6"x11'0"
  // Central core
  { name: "WC",             x: 0.0,  y: 22.0, w: 2.75, d: 4.75, level: 1, color: "#cfd8dc" }, // 2'9"x4'9"
  // Central light court — NOT a rectangle: the back-left corner is chamfered by
  // a diagonal where the bent hall wraps it (traced from the stippled fill).
  // It is a WALLED court (not `open`): its polygon drives the walls around it, so
  // the surrounding wall network follows the chamfer and closes cleanly. Right
  // edge X≈14.9, left straight at X≈7.8 to Y≈30.1, then angled to X≈11.3 (Y≈35.3).
  { name: "Patio",          x: 7.8,  y: 27.3, w: 7.1,  d: 8.0,  level: 1, color: "#bfb59d",
    poly: [[7.8, 27.3], [14.9, 27.3], [14.9, 35.3], [11.3, 35.3], [7.8, 30.1]] }, // 7'4"x8'2" light court
  { name: "Breakfast Nook", x: 15.5, y: 27.0, w: 8.9,  d: 8.25, level: 1, color: "#d2c2a4" }, // 8'11"x8'3"
  // Bent circulation spine: a narrow vertical corridor (X≈3.7–7.8) that wraps
  // RIGHT around the patio — its right edge follows the patio's left wall then
  // its diagonal chamfer — and continues up past the court (X≈6–11.3) to the
  // kitchen/bedrooms. Traced from the wood-floor (tan) corridor in the image.
  { name: "Hall",           x: 3.7,  y: 21.5, w: 7.6,  d: 23.0, level: 1, color: "#d4c6b4",
    poly: [[3.7, 21.5], [7.8, 21.5], [7.8, 30.1], [11.3, 35.3], [11.3, 44.5],
           [6.0, 44.5], [6.0, 31.0], [3.7, 31.0]] }, // bent hallway
  { name: "Bath",           x: 0.0,  y: 34.0, w: 5.7,  d: 10.6, level: 1, color: "#cfd8dc" }, // ✓ 5'8"x10'7"
  { name: "Kitchen",        x: 8.0,  y: 36.0, w: 13.3, d: 9.0,  level: 1, color: "#c8b89a" }, // 13'4"x9'0"
  // Back band
  { name: "Bedroom",        x: 0.0,  y: 45.1, w: 12.4, d: 14.6, level: 1, color: "#c9b08a" }, // ✓ 12'3"x14'6"
  { name: "Bedroom",        x: 13.1, y: 45.7, w: 11.5, d: 14.0, level: 1, color: "#c9b08a" }, // ✓ 11'6"x13'11"

  // ===== LOWER LEVEL ======================================================
  // Service rooms carved into the garage's left edge (listed first to win color lookup)
  { name: "Storage",        x: 0.0,  y: 0.0,  w: 5.0,  d: 10.0, level: 0, color: "#a9afb6" },
  { name: "Mech",           x: 0.0,  y: 14.0, w: 5.0,  d: 8.0,  level: 0, color: "#aeb4ba" },
  { name: "Laundry Area",   x: 0.0,  y: 30.0, w: 6.0,  d: 10.0, level: 0, color: "#b8c4d0" },
  { name: "Stair",          x: 0.0,  y: 40.0, w: 4.0,  d: 6.0,  level: 0, color: "#c0c0c0" },
  // Full-width bands, front to back
  { name: "Garage",         x: 0.0,  y: 0.0,  w: 24.2, d: 40.0, level: 0, color: "#8a9099" }, // 24'2"x40'0"
  { name: "Workshop / Storage", x: 0.0, y: 40.0, w: 24.2, d: 12.3, level: 0, color: "#b0a99a" }, // 24'2"x12'4"
  { name: "Patio",          x: 0.0,  y: 52.3, w: 24.4, d: 7.1,  level: 0, color: "#c9b79c", open: true }, // 24'7"x7'1"
];

// Doorways — openings cut into the wall network.
//   level, orient ('h' = gap along X at a given y / 'v' = gap along Y at x),
//   x, y = opening center (feet), w = clear width (feet).
// The 6 interior doors were DETECTED from the image: the floor runs continuously
// through a doorway, so each is a tan-continuous span across a wall centerline
// (see tools/detect-doors.py). The 2 exterior openings (front entry, garage
// door) are placed from the plan.
export const DOORS: AbsDoor[] = [
  // --- entryways ONTO the bent hall (so the circulation spine is reachable) ---
  // The wood-floor ones were detected on the hall's polygon edges
  // (tools/detect-hall-doors.py); Bath/WC have tile floors, so those are placed
  // from the plan.
  { level: 1, orient: "h", x: 5.7,  y: 21.5, w: 2.6 }, // Hall ↔ Foyer        (detected)
  { level: 1, orient: "v", x: 7.8,  y: 24.1, w: 2.6 }, // Hall ↔ Dining       (detected)
  { level: 1, orient: "v", x: 7.8,  y: 28.7, w: 2.4 }, // Hall ↔ Patio        (patio's straight left wall)
  { level: 1, orient: "v", x: 3.7,  y: 24.0, w: 2.2 }, // Hall ↔ WC           (placed)
  { level: 1, orient: "v", x: 6.0,  y: 39.0, w: 2.6 }, // Hall ↔ Bath         (placed)
  { level: 1, orient: "v", x: 11.3, y: 43.6, w: 2.6 }, // Hall ↔ Kitchen      (detected)
  { level: 1, orient: "h", x: 10.4, y: 44.5, w: 2.6 }, // Hall ↔ Bedroom (L)  (detected)
  // --- other room-to-room doors ---
  { level: 1, orient: "h", x: 7.2,  y: 15.0, w: 3.5 }, // Living ↔ Foyer
  { level: 1, orient: "h", x: 21.7, y: 26.9, w: 2.6 }, // Dining ↔ Breakfast Nook
  { level: 1, orient: "h", x: 13.0, y: 35.6, w: 2.3 }, // Patio ↔ Kitchen
  { level: 1, orient: "h", x: 20.0, y: 35.6, w: 2.6 }, // Breakfast Nook ↔ Kitchen
  { level: 1, orient: "h", x: 18.5, y: 45.3, w: 2.6 }, // Kitchen ↔ Bedroom (R)
  // --- exterior openings ---
  { level: 1, orient: "h", x: 2.6,  y: 0.0,  w: 3.0 },  // front entry door
  { level: 0, orient: "h", x: 14.0, y: 0.0,  w: 16.0 }, // garage door
];

// World-space center of a room's floor (for placing the HTML label overlay).
export function roomCenter(r: Room) {
  return { x: r.x + r.w / 2, y: r.y + r.d / 2, z: LEVEL_Z[r.level] };
}

// ===== ROOF =================================================================
// A flat roof slab sits on top of the MAIN level's walls (z = LEVEL_Z[1] +
// WALL_H). It is built over the main footprint and supports two kinds of
// openings:
//   • cuts      — open to the sky (no glass). Default: the central light court
//     (the "Patio" room) so the patio is uncovered, exactly as drawn.
//   • skylights — glazed openings (translucent panes) that let daylight in.
// Even when the roof is hidden in the viewer it still casts shadows, so the
// main level is lit through these openings (bright patches on the floor below).
export const ROOF: Roof = {
  thickness: 0.4,            // slab thickness (ft)
  color: "#6b6f76",          // roof tone
  // open-to-sky carves. A `poly` (closed ring) is used verbatim; otherwise a
  // centered rect (x,y,w,d). Default carve = the central patio light court.
  cuts: [
    { poly: [[7.8, 27.3], [14.9, 27.3], [14.9, 35.3], [11.3, 35.3], [7.8, 30.1]] }, // central patio
  ],
  // glazed skylights (centered rects), seeded over a few main rooms.
  skylights: [
    { x: 14.5, y: 7.0,  w: 3.0, d: 3.0 },  // Living Room
    { x: 14.6, y: 40.0, w: 3.0, d: 3.0 },  // Kitchen
    { x: 6.0,  y: 52.0, w: 2.5, d: 2.5 },  // Bedroom (L)
  ],
};

// ===== STAIRS ===============================================================
// Stairs are solid stepped blocks (a "ziggurat" of treads) rather than rooms or
// wall openings — like the roof, they are their own kind of object. Each stair
// has a footprint rectangle (x,y,w,d), an ascent `dir` ("+x"/"-x"/"+y"/"-y"),
// a `steps` count, and TWO independent vertical travels measured from its level
// floor: `up` (feet climbed ABOVE the floor) and `down` (feet descended BELOW
// it). The treads span [floor - down, floor + up], so a stair can rise, drop, or
// both. The lowest tread sits at the base; each successive tread is one step
// taller, so the last tread reaches floor + up.
//
// `level` groups the stair with a floor for stacking + the floor filter:
//   • The exterior FRONT STEPS ride the MAIN group and drop a full storey BELOW
//     the front-door threshold (door at x≈2.6, y=0) down to grade. When the
//     levels are stacked their base lands on grade; exploded, they float with
//     the main floor.
//   • The INTERIOR STAIR sits in the lower-level "Stair" room (x0,y40,4×6) and
//     climbs a full inter-floor height (WALL_H + SLAB) ABOVE the lower floor,
//     meeting the main floor when the levels are stacked.
const INTER_FLOOR = CONST.WALL_H + CONST.SLAB;   // one storey (= LEVEL_Z gap when stacked)
export const STAIRS: Stair[] = [
  { name: "Front Steps",    level: 1, x: 1.1, y: -4.0, w: 3.0, d: 4.0, dir: "+y",
    steps: 6, up: 0, down: INTER_FLOOR },          // main threshold -> down to grade
  { name: "Interior Stair", level: 0, x: 0.0, y: 40.0, w: 4.0, d: 6.0, dir: "+y",
    steps: 7, up: INTER_FLOOR, down: 0 },          // lower floor -> up to main
];

// ===== FURNITURE ============================================================
// Placeable pieces that sit on a level's floor (see src/furniture.js for the
// per-type geometry). Each is a footprint {x,y,w,d} (min corner + size, feet) on
// a `level`, a `type` (cabinet/island/bed/couch), a height `h`, and a facing
// `dir` ("+x"/"-x"/"+y"/"-y" — the FRONT faces that way; the back/headboard sits
// on the opposite edge). Seeded into a few rooms to furnish the home; fully
// editable (place/move/resize/rotate/recolor/delete) in the viewer.
export const FURNITURE: Furniture[] = [
  // --- Kitchen (x8,y36 .. x21.3,y45): an island + base cabinets along the back ---
  { type: "island",  level: 1, x: 11.6, y: 39.0, w: 6.0, d: 3.0, h: 3.0, dir: "+y" },
  { type: "cabinet", level: 1, x: 8.3,  y: 36.2, w: 2.0, d: 2.0, h: 3.0, dir: "+y" },
  { type: "cabinet", level: 1, x: 10.6, y: 36.2, w: 2.0, d: 2.0, h: 3.0, dir: "+y" },
  { type: "cabinet", level: 1, x: 18.8, y: 36.2, w: 2.0, d: 2.0, h: 3.0, dir: "+y" },
  // --- Living Room (x5.2,y0 .. x24.4,y14.8): a couch facing into the room ---
  { type: "couch",   level: 1, x: 7.5,  y: 1.4,  w: 6.5, d: 3.0, h: 2.6, dir: "+y" },
  // --- Bedrooms: a bed in each, headboard against the back wall ---
  { type: "bed",     level: 1, x: 3.5,  y: 45.6, w: 5.0, d: 6.7, h: 2.6, dir: "+y" },
  { type: "bed",     level: 1, x: 15.4, y: 46.2, w: 5.0, d: 6.7, h: 2.6, dir: "+y" },
];
