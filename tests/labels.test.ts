// Labels tests (Phase 7) — exercise the PURE label normalizers/seeders and the
// header round-trip, importing ONLY src/normalize.js (never main.js, which pulls
// in three.js / the DOM). normLabel coerces a partial/legacy record to the full
// { text, x, y, level } shape; seedLabels derives one label per NAMED room. The
// header round-trip reuses the SAME b64/extract helpers main.js writes (replicated
// locally, like tests/state-compat.test.mjs) so a labels-carrying blob survives
// embed → extract → parse → normLabel.
//
// Run with:  node --test tests/

import test from "node:test";
import assert from "node:assert/strict";

import { normLabel, seedLabels } from "../src/normalize.ts";

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

test("(lbl.a) normLabel fills text/coords/level defaults", () => {
  const d = normLabel({});
  assert.equal(d.text, "Label", "missing text → 'Label'");
  assert.equal(d.x, 0);
  assert.equal(d.y, 0);
  assert.equal(d.level, 1, "missing level → main (1)");
});

test("(lbl.b) normLabel coerces string coords and clamps level to 0/1", () => {
  const a = normLabel({ text: "Kitchen", x: "3.5", y: "7", level: 0 });
  assert.equal(a.text, "Kitchen");
  assert.equal(a.x, 3.5, "string x coerced to number");
  assert.equal(a.y, 7);
  assert.equal(a.level, 0, "level 0 preserved");
  // any non-zero / non-numeric level → 1 (the only valid alternative)
  assert.equal(normLabel({ level: 2 }).level, 1, "level 2 clamped to 1");
  assert.equal(normLabel({ level: "0" }).level, 1, "non-strict-zero level → 1");
  // a numeric text is coerced to a string
  assert.equal(normLabel({ text: 42 }).text, "42");
  // garbage coords fall back to 0
  assert.equal(normLabel({ x: "abc", y: undefined }).x, 0);
  assert.equal(normLabel({ y: NaN }).y, 0);
});

test("(lbl.c) seedLabels skips unnamed + 'Stair' rooms, centers correctly, keeps level", () => {
  const rooms = [
    { name: "Kitchen", x: 0, y: 0, w: 10, d: 8, level: 1 },
    { name: "Stair", x: 1, y: 1, w: 3, d: 4, level: 1 },       // skipped
    { name: "", x: 2, y: 2, w: 4, d: 4, level: 1 },            // skipped (no name)
    { x: 5, y: 5, w: 4, d: 4, level: 0 },                       // skipped (no name)
    { name: "Den", x: 20, y: 4, w: 12, d: 10, level: 0 },
  ];
  const out = seedLabels(rooms);
  assert.equal(out.length, 2, "only the two named, non-Stair rooms seed labels");
  assert.deepEqual(out[0], { text: "Kitchen", x: 5, y: 4, level: 1 }, "centered at x+w/2, y+d/2");
  assert.deepEqual(out[1], { text: "Den", x: 26, y: 9, level: 0 }, "lower-level center + level preserved");
  assert.equal(seedLabels([]).length, 0, "no rooms → no labels");
  assert.equal(seedLabels(undefined).length, 0, "undefined rooms → no labels");
});

test("(lbl.d) labels survive the KIRKHAM-STATE-V1 header round-trip", () => {
  const labels = [
    { text: "Kitchen", x: 5, y: 4, level: 1 },
    { text: "Den", x: 26, y: 9, level: 0 },
  ];
  const blob = { v: 1, nodes: [], walls: [], roomLoops: [], labels };
  const out = extractState(fileScad(blob));
  assert.ok(out, "extractState returned a blob");
  assert.ok(Array.isArray(out.labels), "labels survived as an array");
  const round = out.labels.map(normLabel);
  assert.deepEqual(round, labels, "labels round-trip unchanged through normLabel");
});
