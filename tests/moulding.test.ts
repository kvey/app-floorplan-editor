// Phase 4.2 — pure moulding geometry tests (src/moulding.js, no three.js).
//
//   • run midpoints lie INSIDE the owning room polygon (point-in-poly), using a
//     real room from ROOMS via deriveWallGraph
//   • base runs split at a door placed on a room wall (count increases; the door
//     span is no longer covered)
//   • crown runs are continuous regardless of doors
//   • profile sub-boxes: z coverage [0,1] monotone; dFrac ≤ 1
//   • run-local parts stay within len × d × h bounds
//
// Run with:  node --test tests/

import test from "node:test";
import assert from "node:assert/strict";

import { deriveWallGraph } from "../src/walls.ts";
import { ROOMS } from "../src/rooms.ts";
import {
  MOULDING_PROFILES, MOULDING_PROFILE_ORDER, KIND_DEFAULTS,
  mouldingRuns, mouldingRunParts, mouldingZ, WALL_T,
} from "../src/moulding.ts";

const WALL_H = 8.0;

// point-in-polygon (ray cast); poly = [[x,y]...]
const inPoly = (px, py, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > py) !== (b[1] > py) && px < ((b[0] - a[0]) * (py - a[1])) / ((b[1] - a[1]) || 1e-9) + a[0]) c = !c;
  }
  return c;
};

// pick a real room with a clean ≥4-node loop to test against.
function pickRoom(graph) {
  for (let i = 0; i < graph.roomLoops.length; i++) {
    if ((graph.roomLoops[i] || []).length >= 4) return i;
  }
  return 0;
}
const loopPoly = (graph, ri) =>
  graph.roomLoops[ri].map((ni) => graph.nodes[ni]).filter(Boolean).map((n) => [n.x, n.y]);

test("(4.2a) run midpoints lie inside the owning room polygon", () => {
  const graph = deriveWallGraph(ROOMS);
  const ri = pickRoom(graph);
  const poly = loopPoly(graph, ri);
  const mld = { room: ri, kind: "base", profile: "stepped", h: 0.45, d: 0.06, color: "#fff" };
  const runs = mouldingRuns(graph, graph.roomLoops, [], [], mld, WALL_H);
  assert.ok(runs.length > 0, "expected runs for a real room");
  for (const r of runs) {
    const mx = (r.ax + r.bx) / 2, my = (r.ay + r.by) / 2;
    assert.ok(inPoly(mx, my, poly), `run midpoint (${mx.toFixed(2)},${my.toFixed(2)}) not inside room`);
  }
});

test("(4.2b) base runs split at a door on a room wall; crown stays continuous", () => {
  const graph = deriveWallGraph(ROOMS);
  const ri = pickRoom(graph);
  const loop = graph.roomLoops[ri];
  // find a wall belonging to this room's loop, long enough for a door.
  let doorWall = -1, doorWallLen = 0;
  for (let k = 0; k < loop.length; k++) {
    const na = loop[k], nb = loop[(k + 1) % loop.length];
    const wi = graph.walls.findIndex((w) => (w.a === na && w.b === nb) || (w.a === nb && w.b === na));
    if (wi < 0) continue;
    const w = graph.walls[wi], a = graph.nodes[w.a], b = graph.nodes[w.b];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > doorWallLen) { doorWallLen = len; doorWall = wi; }
  }
  assert.ok(doorWall >= 0 && doorWallLen > 3.5, "found a room wall to put a door on");
  const door = { wall: doorWall, t: 0.5, w: 2.6 };

  const baseMld = { room: ri, kind: "base", profile: "square", h: 0.45, d: 0.06 };
  const before = mouldingRuns(graph, graph.roomLoops, [], [], baseMld, WALL_H);
  const after = mouldingRuns(graph, graph.roomLoops, [door], [], baseMld, WALL_H);
  assert.ok(after.length > before.length, "base run count should increase when split at a door");

  // total run length should DROP by ~the door width (the gap is uncovered).
  const totLen = (runs) => runs.reduce((s, r) => s + Math.hypot(r.bx - r.ax, r.by - r.ay), 0);
  assert.ok(totLen(before) - totLen(after) > 2.0, "door span removed from base runs");

  // crown is continuous regardless of the door.
  const crownMld = { room: ri, kind: "crown", profile: "cove", h: 0.35, d: 0.05 };
  const cBefore = mouldingRuns(graph, graph.roomLoops, [], [], crownMld, WALL_H);
  const cAfter = mouldingRuns(graph, graph.roomLoops, [door], [], crownMld, WALL_H);
  assert.equal(cAfter.length, cBefore.length, "crown run count unchanged by doors");
  assert.ok(Math.abs(totLen(cAfter) - totLen(cBefore)) < 1e-6, "crown length unchanged by doors");
});

test("(4.2b2) no kind paints across a walk-through gap (loop edge with no wall)", () => {
  const graph = deriveWallGraph(ROOMS);
  const ri = pickRoom(graph);
  const loop = graph.roomLoops[ri];
  // punch a hole: remove the wall under one loop edge (what deleting nodes does —
  // the floor loop stays closed but the edge no longer has a wall).
  let gapWall = -1, gapLen = 0;
  for (let k = 0; k < loop.length; k++) {
    const na = loop[k], nb = loop[(k + 1) % loop.length];
    const wi = graph.walls.findIndex((w) => (w.a === na && w.b === nb) || (w.a === nb && w.b === na));
    if (wi < 0) continue;
    const w = graph.walls[wi], a = graph.nodes[w.a], b = graph.nodes[w.b];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > gapLen) { gapLen = len; gapWall = wi; }
  }
  assert.ok(gapWall >= 0 && gapLen > 1, "found a room wall to punch out");
  const holed = { nodes: graph.nodes, walls: graph.walls.filter((_, i) => i !== gapWall) };

  const totLen = (runs) => runs.reduce((s, r) => s + Math.hypot(r.bx - r.ax, r.by - r.ay), 0);
  for (const kind of ["base", "chair", "crown"]) {
    const mld = { room: ri, kind, profile: "square", h: 0.45, d: 0.06 };
    const before = mouldingRuns(graph, graph.roomLoops, [], [], mld, WALL_H);
    const after = mouldingRuns(holed, graph.roomLoops, [], [], mld, WALL_H);
    assert.ok(totLen(before) - totLen(after) > gapLen - 0.1,
      `${kind}: gap edge (${gapLen.toFixed(1)} ft) should be uncovered`);
    // and no surviving run lies along the removed edge
    const wl = graph.walls[gapWall], a = graph.nodes[wl.a], b = graph.nodes[wl.b];
    for (const r of after) {
      const mx = (r.ax + r.bx) / 2, my = (r.ay + r.by) / 2;
      // distance from run midpoint to the removed edge segment
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((mx - a.x) * dx + (my - a.y) * dy) / l2));
      const d = Math.hypot(mx - (a.x + dx * t), my - (a.y + dy * t));
      assert.ok(d > 0.4, `${kind}: run survives along the punched-out edge (d=${d.toFixed(2)})`);
    }
  }
});

test("(4.2c) profile sub-boxes: z coverage [0,1] monotone, dFrac ≤ 1", () => {
  for (const id of MOULDING_PROFILE_ORDER) {
    const boxes = MOULDING_PROFILES[id].boxes;
    assert.ok(boxes.length > 0, `${id}: has sub-boxes`);
    assert.equal(boxes[0][0], 0, `${id}: starts at z 0`);
    assert.equal(boxes[boxes.length - 1][1], 1, `${id}: ends at z 1`);
    for (let i = 0; i < boxes.length; i++) {
      const [z0, z1, df] = boxes[i];
      assert.ok(z1 > z0, `${id}: box ${i} z not increasing`);
      assert.ok(df > 0 && df <= 1 + 1e-9, `${id}: box ${i} dFrac out of (0,1]`);
      if (i > 0) assert.ok(Math.abs(z0 - boxes[i - 1][1]) < 1e-9, `${id}: box ${i} not contiguous`);
    }
  }
});

test("(4.2d) run-local parts stay within len × d × h bounds (base + crown)", () => {
  const len = 10, h = 0.45, d = 0.06;
  for (const kind of ["base", "crown"]) {
    const parts = mouldingRunParts("cove", kind, len, h, d, "#fff");
    assert.ok(parts.length > 0, `${kind}: parts produced`);
    for (const b of parts) {
      assert.ok(b.x0 >= -1e-9 && b.x1 <= len + 1e-9, `${kind}: x out of [0,len]`);
      assert.ok(b.y0 >= -d / 2 - 1e-9 && b.y1 <= d / 2 + 1e-9, `${kind}: y out of [-d/2,d/2]`);
      assert.ok(b.z0 >= -1e-9 && b.z1 <= h + 1e-9, `${kind}: z out of [0,h]`);
      assert.ok(b.x1 > b.x0 && b.z1 > b.z0, `${kind}: degenerate box`);
    }
  }
});

test("(4.2e) mouldingZ: base 0, chair 2.7, crown wallH - h", () => {
  assert.equal(mouldingZ({ kind: "base", h: 0.45 }, WALL_H), 0);
  assert.equal(mouldingZ({ kind: "chair", h: 0.2 }, WALL_H), 2.7);
  assert.equal(mouldingZ({ kind: "crown", h: 0.35 }, WALL_H), WALL_H - 0.35);
  assert.equal(WALL_T, 0.5);
  // KIND_DEFAULTS sanity (spec §4.2)
  assert.equal(KIND_DEFAULTS.base.h, 0.45);
  assert.equal(KIND_DEFAULTS.crown.h, 0.35);
  assert.equal(KIND_DEFAULTS.chair.h, 0.2);
});
