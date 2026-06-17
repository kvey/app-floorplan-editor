// Pure state normalizers / migrations shared by the engine (src/main.js) and the
// state-compat tests. These are the SINGLE source of truth for how legacy v1
// .scad state blobs (and partial records) are upgraded to the current model:
//   • normDoor      — fills door style/color/casing (Phase 3). Legacy doors with
//                     no style render as a plain SLAB with no casing, identically
//                     to how they always did.
//   • normFurn      — fills furniture type/dir/height defaults.
//   • normCab       — fills cabinet kind/front/drawers/counter/mount/colors from
//                     the kind defaults (Phase 5).
//   • migrateStair  — upgrades the legacy single-`rise` + absolute-`top` stair to
//                     the current up/down travel pair (idempotent).
// They are PURE (no DOM, no three.js) so the tests exercise the exact same code
// main.js does — the "legacy file loads" guarantee.
import { FURNITURE_TYPES } from "./furniture.ts";
import { CABINET_KINDS } from "./cabinets.ts";
import { LEVEL_Z } from "./rooms.ts";
import type { Room } from "./types.ts";

// These coerce LEGACY / partial saved records (untyped JSON blobs) into the
// current model, so inputs are intentionally loose (`any`).

// A door is { wall, t, w, side, hinge, style, color, casing }. Missing style/
// color/casing → SLAB / brown / no casing (legacy doors render unchanged).
export const normDoor = (d: any) => ({ style: "slab", color: "#8a5a3c", casing: false, ...d });

// A furniture piece defaults to a cabinet facing +y at its type's height.
export const normFurn = (f: any) => ({ type: "cabinet", dir: "+y", h: FURNITURE_TYPES[f.type]?.h ?? 3, ...f });

// A cabinet fills its kind's counter/mount defaults, plus front/drawers/colors.
export const normCab = (c: any) => {
  const def = CABINET_KINDS[c.kind] ? CABINET_KINDS[c.kind] : CABINET_KINDS.base;
  return { kind: "base", front: "shaker", drawers: 0, dir: "+y",
    counter: def.counter, mount: def.mount, color: "#9aa3ad", counterColor: "#dcd8d0", ...c };
};

// A scene LABEL is { text, x, y, level } — a positionable text annotation in world
// feet (Phase 7). normLabel coerces a partial/legacy record to the full shape;
// seedLabels derives one label per NAMED room (skipping "Stair" placeholders) at
// the room's center — a one-time silent migration for files saved before labels
// existed. Rooms are NOT renameable, so a seeded label can never go stale.
export const normLabel = (l: any) => ({
  text: String(l.text ?? "Label"),
  x: +l.x || 0,
  y: +l.y || 0,
  level: l.level === 0 ? 0 : 1,
});
export const seedLabels = (rooms: Room[]) =>
  (rooms || [])
    .filter((r) => r.name && r.name !== "Stair")
    .map((r) => ({ text: r.name, x: r.x + r.w / 2, y: r.y + r.d / 2, level: r.level }));

// Older saved stairs stored a single `rise` + absolute `top`; migrate them to the
// up/down travel pair (idempotent — stairs that already carry up/down pass through
// with both fields guaranteed present).
export function migrateStair(s: any) {
  if (s && s.up == null && s.down == null && s.top != null) {
    const floor = LEVEL_Z[s.level] ?? 0, base = s.top - (s.rise ?? 0);
    const { top, rise, ...rest } = s;
    return { ...rest, up: Math.max(0, +(s.top - floor).toFixed(4)), down: Math.max(0, +(floor - base).toFixed(4)) };
  }
  return { up: 0, down: 0, ...s };                     // ensure both fields exist
}
