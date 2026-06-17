// Phase 0 safety-net tests for the pure model/geometry/export layer.
//
// These exercise ONLY modules that have no three.js / browser dependency:
//   src/walls.js   — wall graph + node editing
//   src/scad.js    — OpenSCAD text generation
//   src/rooms.js   — seed data (ROOMS, DOORS, ...)
//   src/furniture.js — furniture parts geometry
//
// The state-blob embed/extract helpers live in src/main.js, which imports
// three.js; rather than import that module (and drag in WebGL/browser globals),
// the 6-line b64 + header helpers are reimplemented locally here and the
// round-trip is asserted against a sample state object — they are verbatim copies
// of the originals in main.js (STATE_TAG / b64enc / b64dec / fileScad / extractState).
//
// Run with:  node --test tests/   (project is "type":"module", no flags needed)

import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveWallGraph, splitWall, deleteNode, weldGroup,
  insertInLoops, remapLoops,
  exportRooms, exportDoors, exportWindows,
  collinearNodes, wallNormal,
} from "../src/walls.ts";
import { roomsToScad } from "../src/scad.ts";
import { ROOMS, DOORS, ROOF, STAIRS, FURNITURE } from "../src/rooms.ts";
import { furnitureParts, FURNITURE_TYPES } from "../src/furniture.ts";

// ----------------------------------------------------------------------------
// helpers shared by several cases
// ----------------------------------------------------------------------------

// every node index referenced by a wall / loop must exist in `nodes`.
function assertNoDangling(graph, roomLoops) {
  const N = graph.nodes.length;
  for (const w of graph.walls) {
    assert.ok(Number.isInteger(w.a) && w.a >= 0 && w.a < N, `wall.a ${w.a} out of range (N=${N})`);
    assert.ok(Number.isInteger(w.b) && w.b >= 0 && w.b < N, `wall.b ${w.b} out of range (N=${N})`);
  }
  for (let i = 0; i < roomLoops.length; i++) {
    for (const ni of roomLoops[i]) {
      assert.ok(Number.isInteger(ni) && ni >= 0 && ni < N, `roomLoop[${i}] node ${ni} out of range (N=${N})`);
    }
  }
}

// ----------------------------------------------------------------------------
// (a) deriveWallGraph(ROOMS) integrity
// ----------------------------------------------------------------------------

test("(a) deriveWallGraph(ROOMS) has no dangling node indices", () => {
  const graph = deriveWallGraph(ROOMS);
  assert.ok(graph.nodes.length > 0, "expected some nodes");
  assert.ok(graph.walls.length > 0, "expected some walls");
  assert.equal(graph.roomLoops.length, ROOMS.length, "one loop per room");
  assertNoDangling(graph, graph.roomLoops);
  // walls never connect a node to itself
  for (const w of graph.walls) assert.notEqual(w.a, w.b, "degenerate self-wall");
  // a wall's two nodes share the wall's level
  for (const w of graph.walls) {
    assert.equal(graph.nodes[w.a].level, w.level);
    assert.equal(graph.nodes[w.b].level, w.level);
  }
});

// ----------------------------------------------------------------------------
// (b) splitWall + deleteNode + weldGroup round-trip keeps loop integrity
// ----------------------------------------------------------------------------

test("(b) splitWall + deleteNode + weldGroup keep loop integrity", () => {
  const g0 = deriveWallGraph(ROOMS);
  let doors = []; // operate on an empty door set; the ops thread doors through
  let roomLoops = g0.roomLoops.map((l) => [...l]);
  let graph = { nodes: g0.nodes, walls: g0.walls };

  // --- splitWall: insert a control point mid-wall ---
  const wi = 0;
  const sp = splitWall(graph, doors, wi, 0.5);
  graph = { nodes: sp.nodes, walls: sp.walls };
  doors = sp.doors;
  // mirror the split into the loops the way main.js does (insertInLoops)
  roomLoops = insertInLoops(roomLoops, sp.splitA, sp.splitB, sp.ni);
  assertNoDangling(graph, roomLoops);
  assert.equal(graph.nodes.length, g0.nodes.length + 1, "split adds exactly one node");

  // --- deleteNode: remove the node we just created ---
  const del = deleteNode(graph, doors, sp.ni);
  // delete returns a nodeMap (old -> new, -1 if removed). Remap loops like main.js.
  graph = { nodes: del.nodes, walls: del.walls };
  doors = del.doors;
  roomLoops = remapLoops(roomLoops, del.nodeMap);
  assertNoDangling(graph, roomLoops);

  // --- weldGroup: merge two distinct nodes that exist ---
  // pick two same-level nodes to weld
  const lvl = graph.nodes[0].level;
  const sameLevel = graph.nodes
    .map((n, i) => ({ n, i }))
    .filter((o) => o.n.level === lvl)
    .slice(0, 2)
    .map((o) => o.i);
  assert.equal(sameLevel.length, 2, "need two nodes to weld");
  const weld = weldGroup(graph, doors, sameLevel);
  graph = { nodes: weld.nodes, walls: weld.walls };
  doors = weld.doors;
  roomLoops = remapLoops(roomLoops, weld.nodeMap);
  assertNoDangling(graph, roomLoops);
  assert.ok(graph.nodes.length <= del.nodes.length, "weld does not grow node count");
});

// ----------------------------------------------------------------------------
// (b2) collinearNodes / wallNormal — the wall-PUSH selection set
// ----------------------------------------------------------------------------

test("(b2) collinearNodes finds the whole colinear run, pushing it keeps it straight", () => {
  // Two rooms sharing a vertical seam. The left + right exterior edges and the
  // shared seam are each vertical lines; a wall on one should pick up every node
  // exactly on that line (split off by the perpendicular walls meeting it).
  const rooms = [
    { name: "A", level: 0, x: 0, y: 0, w: 10, d: 8 },
    { name: "B", level: 0, x: 10, y: 0, w: 10, d: 8 },   // abuts A at x=10
  ];
  const g = deriveWallGraph(rooms);

  // find a vertical wall (a.x === b.x) to push
  const vi = g.walls.findIndex((w) => Math.abs(g.nodes[w.a].x - g.nodes[w.b].x) < 1e-6);
  assert.ok(vi >= 0, "expected a vertical wall");

  const ids = collinearNodes(g, vi);
  assert.ok(ids.length >= 2, "run includes at least the wall's own endpoints");
  // every returned node lies on the wall's infinite line (perp distance ~0)
  const w = g.walls[vi], a = g.nodes[w.a];
  const [nx, ny] = wallNormal(g, vi);
  for (const ni of ids) {
    const n = g.nodes[ni];
    assert.equal(n.level, w.level, "same level only");
    assert.ok(Math.abs((n.x - a.x) * nx + (n.y - a.y) * ny) < 1e-6, "node is colinear");
  }
  // the wall's own endpoints are in the set
  assert.ok(ids.includes(w.a) && ids.includes(w.b), "endpoints included");

  // PUSH: translate the run by the perpendicular offset; it stays colinear.
  const off = 2.5, before = ids.map((ni) => ({ ...g.nodes[ni] }));
  ids.forEach((ni, k) => { g.nodes[ni].x = before[k].x + nx * off; g.nodes[ni].y = before[k].y + ny * off; });
  const a2 = g.nodes[g.walls[vi].a];
  for (const ni of ids) {
    const n = g.nodes[ni];
    assert.ok(Math.abs((n.x - a2.x) * nx + (n.y - a2.y) * ny) < 1e-6, "still colinear after push");
  }
});

// ----------------------------------------------------------------------------
// (c) roomsToScad output structure
// ----------------------------------------------------------------------------

test("(c) roomsToScad output contains MODE, LVL, every table header, balanced braces", () => {
  // feed exported (edited) data, exactly the path the app uses.
  const graph = deriveWallGraph(ROOMS);
  const rooms = exportRooms(ROOMS, graph, graph.roomLoops);
  const doors = exportDoors(graph, []);
  const windows = exportWindows(graph, []);
  const scad = roomsToScad(rooms, doors, windows, ROOF, STAIRS, FURNITURE);

  // MODE / LVL preamble
  assert.match(scad, /^\s*MODE = \d+;/m, "MODE assignment present");
  assert.match(scad, /^\s*LVL\s+= -?\d+;/m, "LVL assignment present");

  // every data table header emitted by scad.js
  const tableHeaders = [
    "ROOMS = [", "COLS = [", "POLYS = [", "DOORS = [", "WINDOWS = [",
    "ROOF_CUTS = [", "SKYLIGHTS = [", "STAIRS = [",
    "STAIR_WALL_CUTS = [", "STAIR_FLOOR_CUTS = [", "FURN_PARTS = [",
    // Phase 3 door tables
    "DOOR_LEAVES = [", "DOOR_LEAF_PARTS = [", "CASINGS = [",
    // Phase 4 moulding table
    "MLD_RUNS = [",
    // Phase 5 cabinet table
    "CAB_PARTS = [",
  ];
  for (const h of tableHeaders) assert.ok(scad.includes(h), `missing table header: ${h}`);

  // balanced braces and brackets
  const count = (s, ch) => (s.match(new RegExp("\\" + ch, "g")) || []).length;
  assert.equal(count(scad, "{"), count(scad, "}"), "unbalanced braces");
  assert.equal(count(scad, "["), count(scad, "]"), "unbalanced brackets");
  assert.equal(count(scad, "("), count(scad, ")"), "unbalanced parens");
});

// ----------------------------------------------------------------------------
// (d) state-blob embed/extract round-trip
//     (verbatim reimplementation of the helpers in src/main.js so we never
//      import main.js, which pulls in three.js)
// ----------------------------------------------------------------------------

test("(d) state blob embed/extract round-trip", () => {
  const STATE_TAG = "KIRKHAM-STATE-V1";
  const b64enc = (s) => btoa(unescape(encodeURIComponent(s)));
  const b64dec = (s) => decodeURIComponent(escape(atob(s)));
  // fileScad(): state header comment + (here) a stub geometry body
  const embed = (state, body = "") =>
    `/* ${STATE_TAG}\n${b64enc(JSON.stringify(state))}\n${STATE_TAG} */\n` + body;
  const extractState = (text) => {
    const re = new RegExp("/\\*\\s*" + STATE_TAG + "\\s*\\n([\\s\\S]*?)\\n" + STATE_TAG + "\\s*\\*/");
    const m = (text || "").match(re);
    if (!m) return null;
    try { return JSON.parse(b64dec(m[1].replace(/\s+/g, ""))); }
    catch (e) { return null; }
  };

  // a sample state object incl. a room name with characters that would break a
  // naive comment-embed (the b64 layer is what makes it safe).
  const sample = {
    v: 1,
    nodes: [{ x: 0, y: 0, level: 1 }, { x: 5.5, y: 0, level: 1 }],
    walls: [{ a: 0, b: 1, level: 1 }],
    roomLoops: [[0, 1]],
    doors: [{ wall: 0, t: 0.5, w: 2.6 }],
    windows: [],
    note: 'tricky */ comment-closer and unicode café — ✓',
    wallH: 8, sunAz: 135.25,
  };

  const text = embed(sample, "MODE = 2;\nLVL = -1;\n");
  const out = extractState(text);
  assert.deepEqual(out, sample, "round-tripped state must equal the original");

  // a header-less file yields null (defensive)
  assert.equal(extractState("MODE = 2;\nLVL = -1;\n"), null);
  assert.equal(extractState(""), null);
});

// ----------------------------------------------------------------------------
// (e) furnitureParts boxes stay inside the footprint ± documented overhangs
// ----------------------------------------------------------------------------

test("(e) furnitureParts boxes stay within footprint ± documented overhang", () => {
  // documented overhangs (from src/furniture.js): cabinet countertop 0.1,
  // island countertop 0.15. Other types are inset, so 0 overhang is allowed but
  // we give a tiny epsilon for float math.
  const OVERHANG = { cabinet: 0.1, island: 0.15, bed: 0, couch: 0 };
  const EPS = 1e-6;

  // exercise the seed furniture plus one of every type in every facing dir.
  const samples = [...FURNITURE];
  for (const type of Object.keys(FURNITURE_TYPES)) {
    for (const dir of ["+x", "-x", "+y", "-y"]) {
      const d = FURNITURE_TYPES[type];
      samples.push({ type, level: 1, x: 10, y: 10, w: d.w, d: d.d, h: d.h, dir });
    }
  }

  for (const f of samples) {
    const over = (OVERHANG[f.type] ?? 0) + EPS;
    const x0 = f.x - over, x1 = f.x + f.w + over;
    const y0 = f.y - over, y1 = f.y + f.d + over;
    for (const p of furnitureParts(f)) {
      const px0 = p.cx - p.sx / 2, px1 = p.cx + p.sx / 2;
      const py0 = p.cy - p.sy / 2, py1 = p.cy + p.sy / 2;
      assert.ok(px0 >= x0 - EPS && px1 <= x1 + EPS,
        `${f.type}/${f.dir}: box X [${px0.toFixed(3)},${px1.toFixed(3)}] outside [${x0.toFixed(3)},${x1.toFixed(3)}]`);
      assert.ok(py0 >= y0 - EPS && py1 <= y1 + EPS,
        `${f.type}/${f.dir}: box Y [${py0.toFixed(3)},${py1.toFixed(3)}] outside [${y0.toFixed(3)},${y1.toFixed(3)}]`);
      assert.ok(p.sz >= -EPS, `${f.type}: negative height box`);
    }
  }
});
