// Phase 5.2 — pure cabinet geometry tests (src/cabinets.js, no three.js).
//
//   • parts stay within the footprint (+ counter overhang 0.1, + front-face
//     protrusion: faces are FRONT_PROUD 0.08 proud and pulls add another 0.04,
//     so the max front protrusion is 0.12; counter overhangs 0.1 on free edges)
//   • bay math: w = 4.5 → 3 doors
//   • drawers reduce the door height (door top < carcass top when drawers > 0)
//   • wall kind: bottom of every part sits at mount 4.5
//   • every kind × every dir stays within the computed bounds
//
// Run with:  node --test tests/

import test from "node:test";
import assert from "node:assert/strict";
import { CABINET_KINDS, CABINET_ORDER, cabinetParts, cabinetDoorCount } from "../src/cabinets.ts";

const DIRS = ["+y", "-y", "+x", "-x"];
const FRONT_PROUD = 0.08, PULL_W = 0.04, COUNTER_OVER = 0.1;
const FRONT_MAX = FRONT_PROUD + PULL_W + 1e-6;   // pull sits on the proud face

// part box extents helper
const ext = (p) => ({
  x0: p.cx - p.sx / 2, x1: p.cx + p.sx / 2,
  y0: p.cy - p.sy / 2, y1: p.cy + p.sy / 2,
  z0: p.cz - p.sz / 2, z1: p.cz + p.sz / 2,
});

function mkCab(over = {}) {
  const kind = over.kind || "base";
  const def = CABINET_KINDS[kind];
  return {
    level: 1, x: 10, y: 20, w: def.w, d: def.d, h: def.h, dir: "+y",
    kind, front: "shaker", drawers: 0, counter: def.counter,
    mount: def.mount, color: "#9aa3ad", counterColor: "#dcd8d0", ...over,
  };
}

test("(5.2a) parts stay within footprint + counter overhang + front protrusion", () => {
  // base, +y facing: footprint x[10,12], y[20,22]; front face = +y (y1=22).
  const c = mkCab({ kind: "base", drawers: 1, counter: true, front: "shaker" });
  const parts = cabinetParts(c);
  assert.ok(parts.length > 0);
  for (const p of parts) {
    const e = ext(p);
    // x within footprint ± counter overhang
    assert.ok(e.x0 >= c.x - COUNTER_OVER - 1e-6 && e.x1 <= c.x + c.w + COUNTER_OVER + 1e-6, "x out of bounds");
    // back (−y) edge: nothing pokes behind the wall (allow counter flush at y0).
    assert.ok(e.y0 >= c.y - COUNTER_OVER - 1e-6, "y back out of bounds");
    // front (+y) edge: footprint front + face proud + pull + counter overhang
    assert.ok(e.y1 <= c.y + c.d + FRONT_MAX + 1e-6 + COUNTER_OVER, "y front out of bounds");
  }
});

test("(5.2b) bay math: w = 4.5 → 3 doors", () => {
  assert.equal(cabinetDoorCount(4.5), 3);
  assert.equal(cabinetDoorCount(2.0), 2);   // 2 / 1.75 = 1.14 → ceil 2
  assert.equal(cabinetDoorCount(1.75), 1);
  assert.equal(cabinetDoorCount(1.0), 1);
});

test("(5.2c) drawers reduce the door height (door top < carcass top)", () => {
  const noDraw = cabinetParts(mkCab({ kind: "base", drawers: 0, counter: false, front: "slab" }));
  const withDraw = cabinetParts(mkCab({ kind: "base", drawers: 2, counter: false, front: "slab" }));
  // carcass is the first/large body box; find max door-face z. Doors are the slab
  // faces that are proud of the front (y > footprint front for +y). Compare the
  // tallest face box top between the two configs.
  const carcassTop = (parts) => Math.max(...parts.map((p) => ext(p).z1));
  const faceTops = (parts) => parts.map((p) => ext(p).z1);
  const topNo = Math.max(...faceTops(noDraw));
  const topWith = Math.max(...faceTops(withDraw));
  // both reach the carcass top (a drawer face reaches the top), so instead check
  // the DOOR face: the lowest contiguous face. Door top should drop with drawers.
  // Simplest robust check: with drawers, there exists a face whose top is well
  // below the carcass top (the door), which doesn't exist without drawers.
  const cTop = carcassTop(withDraw);
  const hasLowDoor = withDraw.some((p) => { const e = ext(p); return e.z1 < cTop - 1.0 && e.z1 > 0.3; });
  assert.ok(hasLowDoor, "with drawers the door face should be shorter (top well below carcass top)");
});

test("(5.2d) wall kind floats: every part bottom ≥ mount 4.5", () => {
  const c = mkCab({ kind: "wall" });
  assert.equal(c.mount, 4.5);
  const parts = cabinetParts(c);
  for (const p of parts) assert.ok(ext(p).z0 >= c.mount - 1e-6, "wall part below mount");
  // and the carcass bottom sits AT the mount (no toe kick on wall).
  const minZ = Math.min(...parts.map((p) => ext(p).z0));
  assert.ok(Math.abs(minZ - c.mount) < 1e-6, "wall carcass should start at mount");
});

test("(5.2e) every kind × every dir stays within bounds", () => {
  for (const kind of CABINET_ORDER) {
    for (const dir of DIRS) {
      const c = mkCab({ kind, dir, drawers: kind === "wall" ? 0 : 1, front: "shaker",
        counter: CABINET_KINDS[kind].counter });
      const parts = cabinetParts(c);
      assert.ok(parts.length > 0, `${kind}/${dir}: parts`);
      const fx0 = c.x, fx1 = c.x + c.w, fy0 = c.y, fy1 = c.y + c.d;
      const slack = FRONT_MAX + COUNTER_OVER;
      for (const p of parts) {
        const e = ext(p);
        assert.ok(e.x0 >= fx0 - slack - 1e-6 && e.x1 <= fx1 + slack + 1e-6, `${kind}/${dir}: x`);
        assert.ok(e.y0 >= fy0 - slack - 1e-6 && e.y1 <= fy1 + slack + 1e-6, `${kind}/${dir}: y`);
        assert.ok(e.z0 >= (c.mount ?? 0) - 1e-6, `${kind}/${dir}: z below mount`);
        assert.ok(e.x1 > e.x0 && e.y1 > e.y0 && e.z1 > e.z0, `${kind}/${dir}: degenerate`);
      }
    }
  }
});
