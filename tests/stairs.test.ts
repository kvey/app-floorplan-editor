// Stairs with landings / turns (path-based geometry). These exercise the pure
// geometry in src/walls.js — the SAME stairSteps() the three.js viewer and the
// SCAD export consume — so a turning stair renders identically everywhere.
//   • a legacy straight stair {x,y,w,d,dir} still produces its old run (backward
//     compatible: no `path` needed);
//   • an L-shaped path stair distributes its treads across both flights, inserts
//     one landing at the turn, climbs monotonically to exactly `up`, and reports
//     a footprint bbox + floor opening that bound the whole (turning) run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stairSteps, stairFloorOpening, stairBBox, stairVertexZs, stairPath } from "../src/walls.ts";

const treads = (boxes) => boxes.filter((b) => !b.landing);
const landings = (boxes) => boxes.filter((b) => b.landing);
const near = (a, b, t = 1e-6) => Math.abs(a - b) <= t;

test("(st.a) legacy straight stair: one flight, no landing, climbs to up", () => {
  const s = { x: 0, y: 0, w: 3, d: 4, dir: "+y", steps: 4, up: 4, down: 0 };
  const boxes = stairSteps(s, 0);
  assert.equal(landings(boxes).length, 0, "a single flight has no landings");
  assert.equal(treads(boxes).length, 4, "one box per tread");
  assert.ok(boxes.every((b) => near(b.z0, 0)), "all treads share the base (floor - down)");
  assert.ok(boxes.every((b) => near(b.ang, Math.PI / 2)), "ascent along +y → yaw 90°");
  const tops = treads(boxes).map((b) => b.z1);
  for (let i = 1; i < tops.length; i++) assert.ok(tops[i] > tops[i - 1], "heights increase");
  assert.ok(near(tops.at(-1), 4), "last tread reaches floor + up");
});

test("(st.b) legacy straight stair: bbox + floor opening match the old footprint", () => {
  const s = { x: 1, y: 2, w: 3, d: 4, dir: "+y", steps: 6, up: 4.3, down: 0 };
  const bb = stairBBox(s);
  assert.deepEqual([bb.x, bb.y, bb.w, bb.d], [1, 2, 3, 4], "centerline ± half-width = original footprint");
  const o = stairFloorOpening(s, 2);
  assert.deepEqual([o.x0, o.y0, o.x1, o.y1], [1, 2, 4, 8], "footprint + 2ft headroom on the +y (top) end");
});

test("(st.c) L-shaped stair: treads split across flights, one landing at the turn", () => {
  const s = { level: 0, width: 3, steps: 8, up: 8, down: 0, path: [[0, 0], [0, 6], [6, 6]] };
  const boxes = stairSteps(s, 0);
  assert.equal(treads(boxes).length, 8, "every tread is emitted");
  assert.equal(landings(boxes).length, 1, "exactly one landing at the interior vertex");
  const L = landings(boxes)[0];
  assert.ok(near(L.cx, 0) && near(L.cy, 6), "landing sits on the turn vertex");
  assert.ok(near(L.l, 3) && near(L.w, 3), "landing is a width×width square");
  assert.ok(near(L.z1, 4), "landing is level with the top of the first flight (4 of 8 risers)");
});

test("(st.d) L-shaped stair: continuous monotonic climb to exactly up", () => {
  const s = { level: 0, width: 3, steps: 8, up: 8, down: 0, path: [[0, 0], [0, 6], [6, 6]] };
  const tops = treads(stairSteps(s, 0)).map((b) => b.z1);
  for (let i = 1; i < tops.length; i++)
    assert.ok(tops[i] - tops[i - 1] > 0, "each tread is one riser taller than the last");
  assert.ok(near(tops.at(-1), 8), "the final flight reaches floor + up");
  // flights run along +y then +x → yaws 90° then 0°
  const angs = new Set(treads(stairSteps(s, 0)).map((b) => +b.ang.toFixed(6)));
  assert.ok(angs.has(+(Math.PI / 2).toFixed(6)) && angs.has(0), "both flight directions present");
});

test("(st.e) L-shaped stair: vertex heights + footprint bound the whole run", () => {
  const s = { level: 0, width: 3, steps: 8, up: 8, down: 2, path: [[0, 0], [0, 6], [6, 6]] };
  const zs = stairVertexZs(s, 0);
  assert.equal(zs.length, 3, "one height per centerline vertex");
  assert.ok(near(zs[0], -2), "foot sits at floor - down");
  assert.ok(near(zs.at(-1), 8), "top sits at floor + up");
  assert.ok(zs[1] > zs[0] && zs[1] < zs[2], "the landing vertex is between foot and top");
  const o = stairFloorOpening(s, 2);
  // flights grow by half-width PERPENDICULAR only: +y flight → x∈[-1.5,1.5] y∈[0,6];
  // +x flight → x∈[0,6] y∈[4.5,7.5]; union y∈[0,7.5], then +2ft headroom past +x.
  assert.ok(near(o.x0, -1.5) && near(o.y0, 0) && near(o.y1, 7.5), "footprint bounds the turning run");
  assert.ok(near(o.x1, 8), "headroom extends past the +x top flight");
});

test("(st.f) stairPath round-trips an explicit path and derives the legacy case", () => {
  const p = stairPath({ width: 4, path: [[0, 0], [0, 5], [5, 5]] });
  assert.equal(p.width, 4);
  assert.deepEqual(p.pts, [[0, 0], [0, 5], [5, 5]]);
  const d = stairPath({ x: 0, y: 0, w: 3, d: 4, dir: "-x" });   // ascent along -x
  assert.equal(d.width, 4, "width is the across-ascent footprint dimension");
  assert.deepEqual(d.pts, [[3, 2], [0, 2]], "centerline runs from foot to top along -x");
});
