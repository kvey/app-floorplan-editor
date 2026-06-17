// Phase 0.3 — OpenSCAD compile smoke test.
//
// Writes roomsToScad(...) output to a temp .scad file and asserts that the
// `openscad <file> -o <tmp>.stl` invocation exits 0 (the generated model is a
// valid, standalone OpenSCAD program). When the `openscad` binary is not on
// PATH the test SKIPS (t.skip) rather than failing, so CI without OpenSCAD stays
// green.
//
// Run with:  node --test tests/

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveWallGraph, exportRooms, exportDoors, exportWindows } from "../src/walls.ts";
import { roomsToScad } from "../src/scad.ts";
import { ROOMS, DOORS, ROOF, STAIRS, FURNITURE } from "../src/rooms.ts";
import { DOOR_STYLE_ORDER } from "../src/doors.ts";
import { mouldingRuns, mouldingZ, PROFILE_CODE, KIND_DEFAULTS } from "../src/moulding.ts";

// Build precomputed MLD_RUNS rows for a couple of moulded rooms (base + crown),
// the same way main.js's currentScad() does, so the export exercises the
// moulding module + its union into level_walls.
function mouldedRuns(graph, roomLoops, doors, windows, wallH) {
  const rows = [];
  const mlds = [
    { room: 0, kind: "base", profile: "stepped", h: KIND_DEFAULTS.base.h, d: KIND_DEFAULTS.base.d, color: "#f0ece4" },
    { room: 0, kind: "crown", profile: "cove", h: KIND_DEFAULTS.crown.h, d: KIND_DEFAULTS.crown.d, color: "#f0ece4" },
  ];
  for (const m of mlds) {
    const lvl = ROOMS[m.room]?.level ?? 1;
    const z0 = mouldingZ(m, wallH);
    for (const run of mouldingRuns(graph, roomLoops, doors, windows, m, wallH)) {
      rows.push([lvl, run.ax, run.ay, run.bx, run.by, z0, m.h, m.d, PROFILE_CODE[m.profile] ?? 0, m.kind === "crown" ? 1 : 0, m.color]);
    }
  }
  return rows;
}

// Place one door of EVERY style on distinct walls long enough to hold it, so the
// generated SCAD exercises every leaf-part path (panels, glazed grid, french
// pair, double, casing) — and asserts it all still compiles standalone.
function doorsOfEveryStyle(graph) {
  const out = [];
  let si = 0;
  for (let wi = 0; wi < graph.walls.length && si < DOOR_STYLE_ORDER.length; wi++) {
    const w = graph.walls[wi], a = graph.nodes[w.a], b = graph.nodes[w.b];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 3.6) continue;                       // need room for a ~2.6ft opening + jambs
    const style = DOOR_STYLE_ORDER[si++];
    out.push({ wall: wi, t: 0.5, w: 2.6, side: 1, hand: 1, style, color: "#8a5a3c", casing: si % 2 === 0 });
  }
  return out;
}

// is there an openscad binary on PATH?
function hasOpenscad() {
  try {
    execFileSync("openscad", ["--version"], { stdio: "ignore", timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

test("(0.3) roomsToScad output compiles in OpenSCAD", (t) => {
  if (!hasOpenscad()) {
    t.skip("openscad binary not found on PATH");
    return;
  }

  const graph = deriveWallGraph(ROOMS);
  const rooms = exportRooms(ROOMS, graph, graph.roomLoops);
  const doors = exportDoors(graph, doorsOfEveryStyle(graph));   // one door of every style
  const windows = exportWindows(graph, []);
  const mldRuns = mouldedRuns(graph, graph.roomLoops, [], [], 8.0);   // base + crown on room 0
  // Cabinets (Phase 5): one of every kind + a shaker base with drawers + counter,
  // so the export exercises toe-kicks, fronts, drawers, pulls, and the countertop.
  const cabinets = [
    { level: 1, x: 4, y: 4, w: 2, d: 2,     h: 3,   dir: "+y", kind: "base", front: "slab",   drawers: 0, counter: true,  mount: 0,   color: "#9aa3ad", counterColor: "#dcd8d0" },
    { level: 1, x: 7, y: 4, w: 2, d: 1.083, h: 2.5, dir: "+y", kind: "wall", front: "slab",   drawers: 0, counter: false, mount: 4.5, color: "#9aa3ad", counterColor: "#dcd8d0" },
    { level: 1, x: 10, y: 4, w: 2, d: 2,    h: 7,   dir: "+y", kind: "tall", front: "shaker", drawers: 0, counter: false, mount: 0,   color: "#9aa3ad", counterColor: "#dcd8d0" },
    { level: 1, x: 13, y: 4, w: 4.5, d: 2,  h: 3,   dir: "+y", kind: "base", front: "shaker", drawers: 2, counter: true,  mount: 0,   color: "#9aa3ad", counterColor: "#dcd8d0" },
  ];
  const scad = roomsToScad(rooms, doors, windows, ROOF, STAIRS, FURNITURE, mldRuns, cabinets);
  // sanity: every style actually placed (the fixture must exercise all six)
  assert.ok(doors.length >= 6, `expected one door of every style, got ${doors.length}`);
  assert.ok(mldRuns.length > 0, "expected moulding runs in the fixture");
  assert.ok(scad.includes("CAB_PARTS = ["), "cabinet table present");

  const dir = mkdtempSync(join(tmpdir(), "kirkham-scad-"));
  const scadFile = join(dir, "floorplan.scad");
  const stlFile = join(dir, "out.stl");
  try {
    writeFileSync(scadFile, scad);
    // generous timeout — CSG render of the full model can be slow.
    execFileSync("openscad", [scadFile, "-o", stlFile], {
      stdio: "pipe",
      timeout: 300000,
    });
    // execFileSync throws on non-zero exit, so reaching here means exit 0.
    assert.ok(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
