// Phase 3.2 — pure door geometry tests (src/doors.js, no three.js).
//
//   • every style's solids + glass stay within the leaf bbox
//       [0..w] × [-0.08..0.08] × [0..h]
//   • glass only appears in glazed15 / french
//   • french / double produce TWO leaves of w/2
//   • casing boxes SURROUND (don't cover) the opening
//   • panel counts match the style names
//
// Run with:  node --test tests/

import test from "node:test";
import assert from "node:assert/strict";

import {
  DOOR_STYLES, DOOR_STYLE_ORDER,
  doorLeafParts, doorLeaves, doorLeafFrames, casingParts,
  CASING_W, CASING_T,
} from "../src/doors.ts";

const EPS = 1e-6;
const LEAF_W = 3.0, LEAF_H = 6.8;
const COLOR = "#8a5a3c";

// single-leaf styles (the pair/slide styles compose these)
const SINGLE = ["slab", "panel2", "panel5", "glazed15", "glazed1"];

test("(3.2a) every style's solids + glass stay within the leaf bbox", () => {
  for (const id of SINGLE) {
    const { solids, glass } = doorLeafParts(id, LEAF_W, LEAF_H, COLOR);
    for (const b of [...solids, ...glass]) {
      assert.ok(b.x0 >= 0 - EPS && b.x1 <= LEAF_W + EPS, `${id}: x [${b.x0},${b.x1}] outside [0,${LEAF_W}]`);
      assert.ok(b.y0 >= -0.08 - EPS && b.y1 <= 0.08 + EPS, `${id}: y [${b.y0},${b.y1}] outside [-0.08,0.08]`);
      assert.ok(b.z0 >= 0 - EPS && b.z1 <= LEAF_H + EPS, `${id}: z [${b.z0},${b.z1}] outside [0,${LEAF_H}]`);
      assert.ok(b.x1 > b.x0 && b.z1 > b.z0, `${id}: degenerate box`);
    }
  }
});

test("(3.2b) glass only in glazed styles (and via french/double composition)", () => {
  for (const id of ["slab", "panel2", "panel5", "glazed15"]) {
    const { glass } = doorLeafParts(id, LEAF_W, LEAF_H, COLOR);
    const wantGlass = DOOR_STYLES[id].glass;
    if (wantGlass) assert.ok(glass.length > 0, `${id}: expected glass lites`);
    else assert.equal(glass.length, 0, `${id}: expected NO glass`);
  }
  // glazed15 = 3×5 = 15 lites; glazed1 (patio slider panel) = 1 full pane
  assert.equal(doorLeafParts("glazed15", LEAF_W, LEAF_H, COLOR).glass.length, 15, "15-lite grid");
  assert.equal(doorLeafParts("glazed1", LEAF_W, LEAF_H, COLOR).glass.length, 1, "single lite");
});

test("(3.2c) french / double produce two leaves of w/2 at opposite jambs", () => {
  for (const id of ["french", "double"]) {
    const W = 6.0;
    const leaves = doorLeaves(id, W);
    assert.equal(leaves.length, 2, `${id}: expected a pair`);
    assert.equal(leaves[0].w, W / 2, `${id}: leaf 0 width`);
    assert.equal(leaves[1].w, W / 2, `${id}: leaf 1 width`);
    // hinges at opposite jambs (0 and 1), mirrored swing
    assert.notEqual(leaves[0].hingeT, leaves[1].hingeT, `${id}: hinges at same jamb`);
    assert.equal(leaves[0].swingSign, -leaves[1].swingSign, `${id}: swing not mirrored`);
  }
  // single styles → exactly one full-width leaf
  for (const id of ["slab", "panel2", "panel5", "glazed15", "sliding"]) {
    const leaves = doorLeaves(id, 3.0);
    assert.equal(leaves.length, 1, `${id}: single leaf`);
    assert.equal(leaves[0].w, 3.0);
  }
  // sliding glass → a pair of half-width panels at opposite jambs
  const sg = doorLeaves("slidingGlass", 6.0);
  assert.equal(sg.length, 2, "slidingGlass: pair");
  assert.equal(sg[0].w, 3.0); assert.equal(sg[1].w, 3.0);
  assert.notEqual(sg[0].hingeT, sg[1].hingeT, "panels at same jamb");
});

test("(3.2d) french/double leaf parts (glass for french, none for double)", () => {
  // french leaves are glazed15 → glass; double leaves are slab → none
  const fr = doorLeaves("french", 6.0)[0];
  assert.ok(doorLeafParts("glazed15", fr.w, LEAF_H, COLOR).glass.length > 0, "french leaf glazed");
  const db = doorLeaves("double", 6.0)[0];
  assert.equal(doorLeafParts("slab", db.w, LEAF_H, COLOR).glass.length, 0, "double leaf slab");
});

test("(3.2e) panel counts match style names", () => {
  // panel2 → 2 recessed panels (PANEL_T = 0.07 thick boxes)
  const isPanel = (b) => Math.abs((b.y1 - b.y0) - 0.07) < 1e-6;
  const p2 = doorLeafParts("panel2", LEAF_W, LEAF_H, COLOR).solids.filter(isPanel);
  assert.equal(p2.length, 2, "panel2 has 2 recessed panels");
  const p5 = doorLeafParts("panel5", LEAF_W, LEAF_H, COLOR).solids.filter(isPanel);
  assert.equal(p5.length, 5, "panel5 has 5 recessed panels");
  // slab + glazed have no recessed 0.07 panels
  assert.equal(doorLeafParts("slab", LEAF_W, LEAF_H, COLOR).solids.filter(isPanel).length, 0);
});

test("(3.2f) casing boxes surround (don't cover) the opening", () => {
  const W = 3.0, H = 6.8, wallT = 0.5;
  const parts = casingParts(W, H, wallT);
  assert.ok(parts.length > 0, "casing produced");
  const hw = W / 2;
  for (const b of parts) {
    // casing must not intrude into the clear opening rectangle [-hw..hw] × [0..H]
    // a box covers the opening if it overlaps in x AND is below the head.
    const overlapsX = b.x1 > -hw + EPS && b.x0 < hw - EPS;
    const belowHead = b.z0 < H - EPS;
    assert.ok(!(overlapsX && belowHead), `casing box covers the opening: ${JSON.stringify(b)}`);
    // casing sits proud of a wall face (|y| >= wallT/2)
    assert.ok(Math.min(Math.abs(b.y0), Math.abs(b.y1)) >= wallT / 2 - EPS, "casing not on a wall face");
  }
  // legs + head on both faces → 6 boxes
  assert.equal(parts.length, 6, "two legs + head on each of two faces");
});

test("(3.2g) catalog has all eight styles in order", () => {
  assert.deepEqual(DOOR_STYLE_ORDER,
    ["slab", "panel2", "panel5", "glazed15", "french", "double", "sliding", "slidingGlass"]);
  for (const id of DOOR_STYLE_ORDER) assert.ok(DOOR_STYLES[id], `missing style ${id}`);
});

test("(3.2h) sliding frames translate, never rotate (mode/slideSign contract)", () => {
  // wall along +x, opening centered at (10, 0), w = 4, wallT = 0.5
  const [cx, cy, W, deg] = [10, 0, 4, 0];

  // barn-style opaque slider: one full-width leaf on a FACE track, slides -x.
  const barn = doorLeafFrames("sliding", cx, cy, W, deg, 1, 1, 0.5);
  assert.equal(barn.length, 1);
  assert.equal(barn[0].mode, "slide");
  assert.equal(barn[0].slideSign, -1, "parks past its jamb");
  assert.equal(barn[0].w, W, "covers the full opening");
  // track offset: off the wall face (|y| > wallT/2), on the `side` face
  assert.ok(barn[0].hy > 0.25, `face track outside the wall (hy=${barn[0].hy})`);
  // flip side → other face; flip hand → parks from the other jamb
  assert.ok(doorLeafFrames("sliding", cx, cy, W, deg, -1, 1, 0.5)[0].hy < -0.25, "side flips the face");
  const flipped = doorLeafFrames("sliding", cx, cy, W, deg, 1, -1, 0.5)[0];
  assert.ok(Math.abs(flipped.hx - (cx + W / 2)) < EPS, "hand moves the park jamb to B");

  // patio glass slider: two half panels INSIDE the wall, exactly one moves.
  const patio = doorLeafFrames("slidingGlass", cx, cy, W, deg, 1, 1, 0.5);
  assert.equal(patio.length, 2);
  for (const fr of patio) {
    assert.equal(fr.mode, "slide");
    assert.equal(fr.w, W / 2);
    assert.ok(Math.abs(fr.hy) < 0.25, `in-wall track (hy=${fr.hy})`);
    assert.equal(fr.leaf, "glazed1");
  }
  const signs = patio.map((fr) => fr.slideSign).sort();
  assert.deepEqual(signs, [0, 1], "one fixed panel, one sliding");
  // the two panels ride different tracks (opposite y offsets)
  assert.ok(patio[0].hy * patio[1].hy < 0, "panels on opposite tracks");
  // `hand` swaps which panel moves
  const swapped = doorLeafFrames("slidingGlass", cx, cy, W, deg, 1, -1, 0.5);
  assert.notEqual(swapped[0].slideSign, patio[0].slideSign, "hand swaps the moving panel");

  // swing styles are untouched: no mode field / real swingSign
  const swing = doorLeafFrames("slab", cx, cy, 3, deg, 1, 1);
  assert.notEqual(swing[0].mode, "slide");
  assert.ok(Math.abs(swing[0].swingSign) === 1, "swing leaves still swing");
});
