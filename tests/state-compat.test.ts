// State-compat tests — the "legacy file loads" guarantee.
//
// A LEGACY v1 floorplan.scad header (written before Phases 3–5) has:
//   • doors WITHOUT style/color/casing fields
//   • NO `mouldings` / `cabinets` keys at all
//   • stairs with the OLD single `rise` + absolute `top` (no up/down)
//   • furniture WITHOUT `dir` / `h`
// On load, main.js runs each collection through the pure normalizers in
// src/normalize.js (the SAME code these tests import) so old files render
// identically. This test builds such a blob, embeds it in a header, extracts it
// back out (same b64/header helpers as main.js), then asserts the normalizers
// fill the right defaults — i.e. exercises the load path end-to-end through the
// real normalizer code.
//
// Run with:  node --test tests/

import test from "node:test";
import assert from "node:assert/strict";

import { normDoor, normFurn, normCab, migrateStair } from "../src/normalize.ts";
import { CABINET_KINDS } from "../src/cabinets.ts";
import { FURNITURE_TYPES } from "../src/furniture.ts";
import { LEVEL_Z } from "../src/rooms.ts";

// ---- header helpers: VERBATIM copies of main.js (STATE_TAG/b64/embed/extract) ----
const STATE_TAG = "KIRKHAM-STATE-V1";
const b64enc = (s) => btoa(unescape(encodeURIComponent(s)));
const b64dec = (s) => decodeURIComponent(escape(atob(s)));
const fileScad = (state, body = "MODE = 2;\n") =>
  `/* ${STATE_TAG}\n${b64enc(JSON.stringify(state))}\n${STATE_TAG} */\n` + body;
const extractState = (text) => {
  const re = new RegExp("/\\*\\s*" + STATE_TAG + "\\s*\\n([\\s\\S]*?)\\n" + STATE_TAG + "\\s*\\*/");
  const m = (text || "").match(re);
  if (!m) return null;
  try { return JSON.parse(b64dec(m[1].replace(/\s+/g, ""))); }
  catch (e) { return null; }
};

// A LEGACY v1 blob: doors with no style fields, no mouldings/cabinets keys, a
// pre-up/down stair (rise + absolute top), furniture with no dir/h.
function legacyBlob() {
  return {
    v: 1,
    nodes: [{ x: 0, y: 0, level: 1 }, { x: 10, y: 0, level: 1 }, { x: 10, y: 8, level: 1 }, { x: 0, y: 8, level: 1 }],
    walls: [{ a: 0, b: 1, level: 1 }, { a: 1, b: 2, level: 1 }, { a: 2, b: 3, level: 1 }, { a: 3, b: 0, level: 1 }],
    roomLoops: [[0, 1, 2, 3]],
    doors: [{ wall: 0, t: 0.5, w: 2.6, side: 1 }],            // NO style/color/casing
    windows: [{ wall: 1, t: 0.5, w: 3, sill: 1.2, h: 2 }],
    // legacy stair on the MAIN level (LEVEL_Z[1]): rise 4.3 ending at top = floor+4.3
    stairs: [{ name: "Stair", level: 1, x: 1, y: 1, w: 3, d: 4, steps: 6, dir: "+y", rise: 4.3, top: (LEVEL_Z[1] ?? 0) + 4.3 }],
    furniture: [{ type: "island", level: 1, x: 2, y: 2, w: 4, d: 2 }],  // NO dir/h
    // NOTE: deliberately NO `mouldings`, NO `cabinets`, and NO `labels` keys.
    wallH: 8,
  };
}

test("(sc.a) legacy header round-trips through embed/extract", () => {
  const blob = legacyBlob();
  const text = fileScad(blob);
  const out = extractState(text);
  assert.ok(out, "extractState returned a blob");
  assert.equal(out.v, 1);
  assert.equal(out.doors.length, 1);
  assert.equal(out.mouldings, undefined, "legacy blob has no mouldings key");
  assert.equal(out.cabinets, undefined, "legacy blob has no cabinets key");
});

test("(sc.b) normDoor fills slab/no-casing for a legacy styleless door", () => {
  const out = extractState(fileScad(legacyBlob()));
  const doors = out.doors.map(normDoor);
  assert.equal(doors[0].style, "slab", "legacy door defaults to slab");
  assert.equal(doors[0].casing, false, "legacy door has no casing");
  assert.equal(doors[0].color, "#8a5a3c", "legacy door gets the default leaf color");
  // existing fields are preserved
  assert.equal(doors[0].wall, 0);
  assert.equal(doors[0].w, 2.6);
  assert.equal(doors[0].side, 1);
});

test("(sc.c) missing mouldings/cabinets keys default to empty (main.js Array.isArray guard)", () => {
  const out = extractState(fileScad(legacyBlob()));
  // main.js applies these collections only when Array.isArray — so absent keys
  // leave the live arrays empty. Mirror that guard here.
  const mouldings = Array.isArray(out.mouldings) ? out.mouldings.map((m) => ({ ...m })) : [];
  const cabinets = Array.isArray(out.cabinets) ? out.cabinets.map(normCab) : [];
  assert.deepEqual(mouldings, []);
  assert.deepEqual(cabinets, []);
});

test("(sc.h) a legacy blob has no labels key → null-sentinel/seed path (Phase 7)", () => {
  // main.js declares `let labels = null` and only assigns from the blob when
  // Array.isArray(s.labels). A legacy blob carries no `labels` key, so the array
  // check fails and `labels` stays null — the build() boot then seeds labels from
  // the room names (silent migration). Mirror that guard here.
  const out = extractState(fileScad(legacyBlob()));
  assert.equal(out.labels, undefined, "legacy blob has no labels key");
  assert.equal(Array.isArray(out.labels), false, "Array.isArray(s.labels) is false → seed path");
});

test("(sc.d) migrateStair maps legacy rise/top → up/down (idempotent)", () => {
  const out = extractState(fileScad(legacyBlob()));
  const s = out.stairs.map(migrateStair)[0];
  assert.equal(s.up, 4.3, "up = top - floor");
  assert.equal(s.down, 0, "no travel below the floor");
  assert.equal(s.top, undefined, "legacy `top` is dropped");
  assert.equal(s.rise, undefined, "legacy `rise` is dropped");
  // idempotent: re-migrating a migrated stair is a no-op
  const again = migrateStair(s);
  assert.equal(again.up, 4.3);
  assert.equal(again.down, 0);
});

test("(sc.e) migrateStair guarantees up/down on a brand-new stair", () => {
  const s = migrateStair({ name: "S", level: 1, x: 0, y: 0, w: 3, d: 4 });
  assert.equal(s.up, 0);
  assert.equal(s.down, 0);
});

test("(sc.f) normFurn fills dir/height for a legacy piece, keeping its type", () => {
  const out = extractState(fileScad(legacyBlob()));
  const f = out.furniture.map(normFurn)[0];
  assert.equal(f.type, "island", "type preserved");
  assert.equal(f.dir, "+y", "default facing");
  assert.equal(f.h, FURNITURE_TYPES.island?.h ?? 3, "height from the type catalog");
});

test("(sc.g) normCab fills kind defaults for partial cabinet records", () => {
  // A partial cabinet record (only kind + footprint) gets front/drawers/counter/
  // mount/colors from CABINET_KINDS.
  const wall = normCab({ kind: "wall", level: 1, x: 0, y: 0, w: 2, d: 1.083, h: 2.5 });
  assert.equal(wall.front, "shaker");
  assert.equal(wall.drawers, 0);
  assert.equal(wall.counter, CABINET_KINDS.wall.counter);
  assert.equal(wall.mount, CABINET_KINDS.wall.mount);
  assert.equal(wall.color, "#9aa3ad");
  assert.equal(wall.counterColor, "#dcd8d0");
  // unknown kind falls back to base defaults (but keeps the given kind string)
  const weird = normCab({ kind: "zzz", level: 1, x: 0, y: 0 });
  assert.equal(weird.counter, CABINET_KINDS.base.counter);
  assert.equal(weird.mount, CABINET_KINDS.base.mount);
});
