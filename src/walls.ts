// Explicit WALL GRAPH model + helpers (no three.js, so unit-testable in Node and
// shared by the viewer).
//
// Walls are SEGMENTS between NODES (endpoints). Editing drags a node; every wall
// sharing it follows. Doors are placed on a specific wall at a parameter t along
// it (0..1) with a clear width — see placeDoor / doorPoint.
//
// The graph is DERIVED once from the rooms so the model starts identical to the
// measured plan, then becomes the editable source of truth for walls.

import type {
  Room, AbsDoor, AbsWindow, WallDoor, WallWindow, WallNode, Wall, WallGraph,
  Stair, StairStep, DoorFrame, Vec2,
} from "./types.ts";

const SNAP = 0.7;     // merge endpoints within this many feet into one node
const ROOM_MIN = 1.5;

// ---- derive the initial graph from rooms -------------------------------
// Unified model: every room is a LOOP of shared node indices, walls are the loop
// edges, and floors are the loop polygons (src/main.js). Because walls and floors
// reference the SAME nodes, moving a node moves both — floors always match walls.
// Returns { nodes, walls, roomLoops } where roomLoops[i] is room i's node loop.
export function deriveWallGraph(rooms: Room[]): WallGraph {
  const nodes: WallNode[] = [], walls: Wall[] = [], seen = new Set<string>(), roomLoops: number[][] = [];
  const node = (x: number, y: number, level: number): number => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.level === level && Math.abs(n.x - x) <= SNAP && Math.abs(n.y - y) <= SNAP) return i;
    }
    return nodes.push({ x, y, level }) - 1;
  };
  const addWall = (a: number, b: number, level: number) => {
    if (a === b) return;
    const key = level + ":" + Math.min(a, b) + "-" + Math.max(a, b);
    if (seen.has(key)) return;
    seen.add(key);
    walls.push({ a, b, level });
  };
  rooms.forEach((r) => {
    const pts = r.poly || [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.d], [r.x, r.y + r.d]];
    let loop = pts.map(([x, y]) => node(x, y, r.level));
    loop = loop.filter((n, i) => n !== loop[(i + 1) % loop.length]);   // drop consecutive dupes
    roomLoops.push(loop);
    for (let k = 0; k < loop.length; k++) addWall(loop[k], loop[(k + 1) % loop.length], r.level);
  });
  return { nodes, walls, roomLoops };
}

// Remap room loops through a node index map (old -> new, or -1 if removed), used
// after weld/delete reindex nodes. Drops consecutive dupes and dead loops.
export function remapLoops(roomLoops: number[][], nodeMap: number[]): number[][] {
  return roomLoops.map((loop) => {
    const m = loop.map((n) => nodeMap[n]).filter((n) => n >= 0);
    return m.filter((n, i) => m.length > 0 && n !== m[(i + 1) % m.length]);
  });
}

// walls resolved to coordinate tuples [ax,ay,bx,by,level] (what the SCAD needs)
export function resolveWalls(graph: WallGraph): number[][] {
  return graph.walls.map((w) => {
    const a = graph.nodes[w.a], b = graph.nodes[w.b];
    return [a.x, a.y, b.x, b.y, w.level];
  });
}

// ---- doors on walls ----------------------------------------------------
// A door = { wall: index, t: 0..1 along wall, w: clear width }.
export function doorPoint(graph: WallGraph, door: { wall: number; t: number }) {
  const a = graph.nodes[graph.walls[door.wall].a], b = graph.nodes[graph.walls[door.wall].b];
  return { x: a.x + (b.x - a.x) * door.t, y: a.y + (b.y - a.y) * door.t,
    level: graph.walls[door.wall].level };
}

// nearest wall (on a level) to a point, with the projected parameter t.
export function nearestWall(
  graph: WallGraph, x: number, y: number, level: number,
): { wall: number; t: number; dist: number; len: number } | null {
  let best: { wall: number; t: number; dist: number; len: number } | null = null;
  graph.walls.forEach((w, i) => {
    if (w.level !== level) return;
    const a = graph.nodes[w.a], b = graph.nodes[w.b];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1e-6;
    let t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + dx * t, py = a.y + dy * t;
    const d = Math.hypot(x - px, y - py);
    if (!best || d < best.dist) best = { wall: i, t, dist: d, len: Math.sqrt(len2) };
  });
  return best;
}

// seed doors from the legacy auto-detected DOORS (rooms.js) by snapping each to
// its nearest wall, so the model keeps its doorways until the user edits them.
export function seedDoors(graph: WallGraph, legacyDoors: AbsDoor[]): WallDoor[] {
  const out: WallDoor[] = [];
  for (const d of legacyDoors) {
    const nw = nearestWall(graph, d.x, d.y, d.level);
    if (nw && nw.dist < 2.5 && nw.len > d.w) out.push({ wall: nw.wall, t: nw.t, w: d.w });
  }
  return out;
}

// ---- node editing ------------------------------------------------------
// Walls connected to a node (for moving / highlighting).
export function wallsAtNode(graph: WallGraph, ni: number) {
  return graph.walls.map((w, i) => ({ w, i })).filter((o) => o.w.a === ni || o.w.b === ni);
}

// Unit normal of a wall (perpendicular to its A→B direction). [0,0] if degenerate.
export function wallNormal(graph: WallGraph, wi: number): [number, number] {
  const w = graph.walls[wi]; if (!w) return [0, 0];
  const a = graph.nodes[w.a], b = graph.nodes[w.b]; if (!a || !b) return [0, 0];
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  return len < 1e-9 ? [0, 0] : [-dy / len, dx / len];
}

// Node indices COLINEAR with wall `wi`: on the same level and within `eps` feet
// of the wall's INFINITE line. This is the set that moves together when you PUSH
// the wall — the whole straight run (every segment split off the wall by a
// T-junction) shifts as one, and the perpendicular walls meeting it stretch to
// follow. Includes the wall's own two endpoints. Pure / unit-testable.
export function collinearNodes(graph: WallGraph, wi: number, eps = 0.15): number[] {
  const w = graph.walls[wi]; if (!w) return [];
  const a = graph.nodes[w.a], b = graph.nodes[w.b]; if (!a || !b) return [];
  const [nx, ny] = wallNormal(graph, wi);
  if (nx === 0 && ny === 0) return [];
  const out: number[] = [];
  graph.nodes.forEach((n, i) => {
    if (n.level !== w.level) return;
    if (Math.abs((n.x - a.x) * nx + (n.y - a.y) * ny) <= eps) out.push(i);
  });
  return out;
}

export const snap = (v: number, g: number): number => (g > 0 ? Math.round(v / g) * g : v);

// Nearest OTHER node on the same level within tol; -1 if none.
export function nearestNode(graph: WallGraph, x: number, y: number, level: number, exclude: number, tol: number): number {
  let best = -1, bd = tol;
  graph.nodes.forEach((n, i) => {
    if (i === exclude || n.level !== level) return;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d <= bd) { bd = d; best = i; }
  });
  return best;
}

// Weld node `from` into node `to`: repoint walls, drop degenerate/duplicate
// walls, remove the node and reindex, and remap door wall references. Returns a
// fresh { nodes, walls, doors }. Pure — caller swaps the results in.
export function weldNodes(graph: WallGraph, doors: WallDoor[], from: number, to: number) {
  if (from === to) return { nodes: graph.nodes, walls: graph.walls, doors, nodeMap: graph.nodes.map((_, i) => i) };
  const rep = (i: number) => (i === from ? to : i);
  const wallMap: number[] = [], newWalls: Wall[] = [], seen = new Map<string, number>();
  graph.walls.forEach((w, oi) => {
    const a = rep(w.a), b = rep(w.b);
    if (a === b) { wallMap[oi] = -1; return; }                 // collapsed
    const key = w.level + ":" + Math.min(a, b) + "-" + Math.max(a, b);
    if (seen.has(key)) { wallMap[oi] = seen.get(key)!; return; } // duplicate
    wallMap[oi] = newWalls.length; seen.set(key, newWalls.length);
    newWalls.push({ a, b, level: w.level });
  });
  const newNodes = graph.nodes.filter((_, i) => i !== from);
  const shift = (i: number) => (i > from ? i - 1 : i);
  const walls = newWalls.map((w) => ({ a: shift(w.a), b: shift(w.b), level: w.level }));
  const newDoors = doors.map((d) => ({ ...d, wall: wallMap[d.wall] })).filter((d) => d.wall >= 0);
  const nodeMap = graph.nodes.map((_, i) => (i === from ? shift(to) : shift(i)));
  return { nodes: newNodes, walls, doors: newDoors, nodeMap };
}

// Insert node `ni` into any room loop that traverses edge (a,b), so floors track
// a wall split.
export function insertInLoops(roomLoops: number[][], a: number, b: number, ni: number): number[][] {
  return roomLoops.map((loop) => {
    const out = [];
    for (let k = 0; k < loop.length; k++) {
      out.push(loop[k]);
      const n = loop[(k + 1) % loop.length];
      if ((loop[k] === a && n === b) || (loop[k] === b && n === a)) out.push(ni);
    }
    return out;
  });
}

// Insert a new control point on a wall at parameter t (0..1), splitting it into
// two walls that share the new node (Figma-style: click a segment to add an
// anchor). Doors on the wall are reassigned to the correct half with rescaled t.
// Returns a fresh { nodes, walls, doors } and the new node index.
export function splitWall(graph: WallGraph, doors: WallDoor[], wi: number, t: number) {
  const w = graph.walls[wi], a = graph.nodes[w.a], b = graph.nodes[w.b];
  const nx = a.x + (b.x - a.x) * t, ny = a.y + (b.y - a.y) * t;
  const ni = graph.nodes.length;
  const nodes = [...graph.nodes.map((n) => ({ ...n })), { x: nx, y: ny, level: w.level }];
  const walls = graph.walls.map((x) => ({ ...x }));
  const sub2 = walls.length;
  walls[wi] = { a: w.a, b: ni, level: w.level };     // a → new
  walls.push({ a: ni, b: w.b, level: w.level });      // new → b
  const newDoors = doors.map((d) => {
    if (d.wall !== wi) return { ...d };
    return d.t < t ? { ...d, wall: wi, t: d.t / t } : { ...d, wall: sub2, t: (d.t - t) / (1 - t) };
  });
  return { nodes, walls, doors: newDoors, ni, splitA: w.a, splitB: w.b };
}

// Delete a control point: remove the node and every wall segment touching it,
// leaving a hole in the wall where those segments were. Also prunes any nodes
// orphaned by the deletion, reindexes, and drops doors on removed walls.
export function deleteNode(graph: WallGraph, doors: WallDoor[], ni: number) {
  const wallMap: number[] = [], tmp: Wall[] = [];
  graph.walls.forEach((w, i) => {
    if (w.a === ni || w.b === ni) wallMap[i] = -1;
    else { wallMap[i] = tmp.length; tmp.push({ ...w }); }
  });
  const used = new Set<number>();
  tmp.forEach((w) => { used.add(w.a); used.add(w.b); });
  const nodeMap: number[] = [], keep: WallNode[] = [];
  graph.nodes.forEach((n, i) => {
    if (i !== ni && used.has(i)) { nodeMap[i] = keep.length; keep.push({ ...n }); } else nodeMap[i] = -1;
  });
  const walls = tmp.map((w) => ({ a: nodeMap[w.a], b: nodeMap[w.b], level: w.level }));
  const newDoors = doors.map((d) => ({ ...d, wall: wallMap[d.wall] })).filter((d) => d.wall >= 0);
  return { nodes: keep, walls, doors: newDoors, nodeMap };
}

// Extract the bounded FACES (rooms) of the planar wall graph for a level, so
// floors always match the walls. Standard planar-subdivision face traversal:
// sort each node's edges by angle, then walk half-edges taking the next-clockwise
// edge at each node. Interior faces come out CCW (positive area); the single
// unbounded outer face comes out CW (negative) and is dropped. Returns
// [{ poly: [[x,y],…], area }].
export function wallFaces(graph: WallGraph, level: number): { poly: number[][]; area: number }[] {
  const nodes = graph.nodes;
  const adj = new Map<number, number[]>();
  for (const w of graph.walls) {
    if (w.level !== level || w.a === w.b) continue;
    if (!nodes[w.a] || !nodes[w.b]) continue;
    (adj.get(w.a) || adj.set(w.a, []).get(w.a))!.push(w.b);
    (adj.get(w.b) || adj.set(w.b, []).get(w.b))!.push(w.a);
  }
  const ang = (f: number, t: number) => Math.atan2(nodes[t].y - nodes[f].y, nodes[t].x - nodes[f].x);
  for (const [n, nb] of adj) { nb.sort((p, q) => ang(n, p) - ang(n, q)); }
  const next = (u: number, v: number): number => {  // arriving at v from u, take next edge clockwise
    const nb = adj.get(v)!; const i = nb.indexOf(u);
    return nb[(i - 1 + nb.length) % nb.length];
  };
  const seen = new Set<string>(), faces: { poly: number[][]; area: number }[] = [];
  const area = (pts: number[][]) => { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
  for (const w of graph.walls) {
    if (w.level !== level || !adj.has(w.a) || !adj.has(w.b)) continue;
    for (const [a0, b0] of [[w.a, w.b], [w.b, w.a]]) {
      if (seen.has(a0 + ">" + b0)) continue;
      const face: number[][] = []; let u = a0, v = b0, guard = 0;
      do {
        seen.add(u + ">" + v); face.push([nodes[u].x, nodes[u].y]);
        const nv = next(u, v); u = v; v = nv;
      } while (!(u === a0 && v === b0) && ++guard < 100000);
      const A = area(face);
      if (A > 0.5) faces.push({ poly: face, area: A });   // bounded interior face
    }
  }
  return faces;
}

// Build a planar ARRANGEMENT of a level's walls and return every bounded face,
// so each wall-enclosed region gets a floor — even where walls meet at
// T-junctions or cross (which plain face-traversal can't handle). We split every
// segment at all points where another segment's endpoint or crossing lands on
// it, then trace faces. Returns [{ poly:[[x,y]…], area }] (bounded faces).
export function floorFaces(graph: WallGraph, level: number): { poly: number[][]; area: number }[] {
  const EPS = 0.06;
  const segs: number[][][] = [];
  for (const w of graph.walls) {
    if (w.level !== level) continue;
    const a = graph.nodes[w.a], b = graph.nodes[w.b];
    if (a && b && (a.x !== b.x || a.y !== b.y)) segs.push([[a.x, a.y], [b.x, b.y]]);
  }
  // collect break points: all endpoints + proper crossings
  const pts: number[][] = [];
  for (const s of segs) { pts.push(s[0], s[1]); }
  const cross = (p1: number[], p2: number[], p3: number[], p4: number[]): number[] | null => {
    const rx = p2[0] - p1[0], ry = p2[1] - p1[1], sx = p4[0] - p3[0], sy = p4[1] - p3[1];
    const d = rx * sy - ry * sx; if (Math.abs(d) < 1e-9) return null;
    const t = ((p3[0] - p1[0]) * sy - (p3[1] - p1[1]) * sx) / d;
    const u = ((p3[0] - p1[0]) * ry - (p3[1] - p1[1]) * rx) / d;
    if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6) return [p1[0] + t * rx, p1[1] + t * ry];
    return null;
  };
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const p = cross(segs[i][0], segs[i][1], segs[j][0], segs[j][1]); if (p) pts.push(p);
  }
  // shared node pool
  const nodes: number[][] = [];
  const nid = (p: number[]): number => { for (let k = 0; k < nodes.length; k++) if (Math.abs(nodes[k][0] - p[0]) <= EPS && Math.abs(nodes[k][1] - p[1]) <= EPS) return k; return nodes.push([p[0], p[1]]) - 1; };
  // split each segment at every break point lying on it
  const edges = new Set<string>();
  for (const s of segs) {
    const [a, b] = s, dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
    const ts: number[] = [0, 1];
    for (const p of pts) {
      const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
      if (t < -1e-6 || t > 1 + 1e-6) continue;
      const px = a[0] + t * dx, py = a[1] + t * dy;
      if (Math.hypot(p[0] - px, p[1] - py) <= EPS) ts.push(Math.max(0, Math.min(1, t)));
    }
    ts.sort((x, y) => x - y);
    for (let k = 0; k < ts.length - 1; k++) {
      if (ts[k + 1] - ts[k] < 1e-3) continue;
      const A = nid([a[0] + dx * ts[k], a[1] + dy * ts[k]]);
      const B = nid([a[0] + dx * ts[k + 1], a[1] + dy * ts[k + 1]]);
      if (A !== B) edges.add(Math.min(A, B) + ":" + Math.max(A, B));
    }
  }
  // adjacency, sorted CCW by angle
  const adj = new Map<number, number[]>();
  for (const e of edges) { const [a, b] = e.split(":").map(Number); (adj.get(a) || adj.set(a, []).get(a))!.push(b); (adj.get(b) || adj.set(b, []).get(b))!.push(a); }
  const ang = (f: number, t: number) => Math.atan2(nodes[t][1] - nodes[f][1], nodes[t][0] - nodes[f][0]);
  for (const [n, nb] of adj) nb.sort((p, q) => ang(n, p) - ang(n, q));
  const nextHE = (u: number, v: number): number => { const nb = adj.get(v)!; const i = nb.indexOf(u); return nb[(i - 1 + nb.length) % nb.length]; };
  const area = (poly: number[][]) => { let s = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
  const seen = new Set<string>(), faces: { poly: number[][]; area: number }[] = [];
  for (const e of edges) {
    const [n0, n1] = e.split(":").map(Number);
    for (const [a0, b0] of [[n0, n1], [n1, n0]]) {
      if (seen.has(a0 + ">" + b0)) continue;
      const loop: number[][] = []; let u = a0, v = b0, guard = 0;
      do { seen.add(u + ">" + v); loop.push(nodes[u]); const nv = nextHE(u, v); u = v; v = nv; } while (!(u === a0 && v === b0) && ++guard < 100000);
      const A = area(loop);
      if (A > 0.4) faces.push({ poly: loop, area: A });
    }
  }
  return faces;
}

// Weld a SET of nodes into one (at their centroid). Generalizes weldNodes for
// multi-select. Returns { nodes, walls, doors, nodeMap, target }.
export function weldGroup(graph: WallGraph, doors: WallDoor[], indices: number[]) {
  const set = [...new Set(indices)];
  if (set.length < 2) return { nodes: graph.nodes, walls: graph.walls, doors, nodeMap: graph.nodes.map((_, i) => i), target: set[0] };
  const keep = Math.min(...set);
  const remove = new Set(set.filter((i) => i !== keep));
  const cx = set.reduce((s, i) => s + graph.nodes[i].x, 0) / set.length;
  const cy = set.reduce((s, i) => s + graph.nodes[i].y, 0) / set.length;
  const rep = (i: number) => (remove.has(i) ? keep : i);
  const wallMap: number[] = [], newWalls: Wall[] = [], seen = new Map<string, number>();
  graph.walls.forEach((w, oi) => {
    const a = rep(w.a), b = rep(w.b);
    if (a === b) { wallMap[oi] = -1; return; }
    const key = w.level + ":" + Math.min(a, b) + "-" + Math.max(a, b);
    if (seen.has(key)) { wallMap[oi] = seen.get(key)!; return; }
    wallMap[oi] = newWalls.length; seen.set(key, newWalls.length);
    newWalls.push({ a, b, level: w.level });
  });
  const below = (i: number) => [...remove].filter((r) => r < i).length;
  const shift = (i: number) => i - below(i);
  const newNodes = graph.nodes.filter((_, i) => !remove.has(i));
  const walls = newWalls.map((w) => ({ a: shift(w.a), b: shift(w.b), level: w.level }));
  newNodes[shift(keep)] = { ...newNodes[shift(keep)], x: cx, y: cy };
  const newDoors = doors.map((d) => ({ ...d, wall: wallMap[d.wall] })).filter((d) => d.wall >= 0);
  const nodeMap = graph.nodes.map((_, idx) => (remove.has(idx) ? shift(keep) : shift(idx)));
  return { nodes: newNodes, walls, doors: newDoors, nodeMap, target: shift(keep) };
}

// ---- door geometry -----------------------------------------------------
// Resolve a door to its hinge/leaf/swing data for rendering a real door + arc.
// Two INDEPENDENT mirror axes give all four real door configurations:
//   • side (door.side, default +1) — which side of the wall the leaf swings into
//     (mirror ACROSS the wall).
//   • hand (door.hand, default +1) — which jamb the leaf is hinged on: +1 hinges
//     at the A-end of the opening, -1 at the B-end (mirror ALONG the wall).
export function doorFrame(graph: WallGraph, door: WallDoor, openDeg = 80): DoorFrame {
  const w = graph.walls[door.wall], a = graph.nodes[w.a], b = graph.nodes[w.b];
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1e-6;
  const ux = dx / len, uy = dy / len;
  const h = (door.w / 2) / len;
  const hand = (door.hand ?? 1) >= 0 ? 1 : -1;
  // hinge sits on the chosen jamb; the closed leaf spans back across the opening
  // [t-h, t+h] either way, so only its hinge end + base direction change.
  const ht = hand > 0 ? door.t - h : door.t + h;
  const hinge = { x: a.x + dx * ht, y: a.y + dy * ht };
  const baseAngle = Math.atan2(uy, ux) + (hand > 0 ? 0 : Math.PI);  // leaf points along the opening
  const bx = Math.cos(baseAngle), by = Math.sin(baseAngle);
  // Couple the swing sign to hand so that flipping the hinge is a pure mirror
  // ALONG the wall (swaps jamb, keeps the leaf swinging into the SAME room);
  // flipping side stays a pure mirror ACROSS the wall. Together → all 4 configs.
  const A = (door.side ?? 1) * hand * openDeg * Math.PI / 180;  // signed open angle
  const cosA = Math.cos(A), sinA = Math.sin(A);
  const openDir = { x: bx * cosA - by * sinA, y: bx * sinA + by * cosA };
  return { hinge, dir: { x: ux, y: uy }, openDir, A, leaf: door.w, level: w.level, baseAngle };
}

// ---- shared utilities --------------------------------------------------
// A wall SEGMENT is the shared boundary between two adjacent rectangular rooms;
// used to derive interior centerline walls above.
interface WallSegment {
  axis: "x" | "y"; coord: number; lo: number; hi: number; level: number;
  members: { i: number; key: string }[];
}
export function enumerateWallSegments(rooms: Room[]): WallSegment[] {
  const GAP_MAX = 1.6, GAP_MIN = -0.8, SPAN_MIN = 1.5;
  const segs: WallSegment[] = [];
  for (const level of [0, 1]) {
    const idx = rooms.map((r, i) => ({ r, i })).filter((o) => o.r.level === level && !o.r.poly);
    for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) {
      const A = idx[a], B = idx[b];
      for (const [L, R] of [[A, B], [B, A]]) {
        const gap = R.r.x - (L.r.x + L.r.w);
        if (gap < GAP_MIN || gap > GAP_MAX) continue;
        const lo = Math.max(L.r.y, R.r.y), hi = Math.min(L.r.y + L.r.d, R.r.y + R.r.d);
        if (hi - lo < SPAN_MIN) continue;
        segs.push({ axis: "x", coord: (L.r.x + L.r.w + R.r.x) / 2, lo, hi, level,
          members: [{ i: L.i, key: "x1" }, { i: R.i, key: "x0" }] });
      }
      for (const [Lo, Up] of [[A, B], [B, A]]) {
        const gap = Up.r.y - (Lo.r.y + Lo.r.d);
        if (gap < GAP_MIN || gap > GAP_MAX) continue;
        const lo = Math.max(Lo.r.x, Up.r.x), hi = Math.min(Lo.r.x + Lo.r.w, Up.r.x + Up.r.w);
        if (hi - lo < SPAN_MIN) continue;
        segs.push({ axis: "y", coord: (Lo.r.y + Lo.r.d + Up.r.y) / 2, lo, hi, level,
          members: [{ i: Lo.i, key: "y1" }, { i: Up.i, key: "y0" }] });
      }
    }
  }
  return segs;
}

// ---- export the EDITED state to SCAD-ready data ------------------------
// Rooms become polygons from their (edited) node loops, so the exported geometry
// reflects every wall edit. Each gets a bbox for the cube fallback / labels.
export function exportRooms(roomsMeta: Room[], graph: WallGraph, roomLoops: number[][]) {
  return roomsMeta.map((r, i) => {
    const pts = (roomLoops[i] || []).map((ni) => graph.nodes[ni]).filter(Boolean);
    let { x, y, w, d } = r;
    let poly: number[][] | null = null;
    if (pts.length >= 3) {
      poly = pts.map((p) => [+p.x.toFixed(2), +p.y.toFixed(2)]);
      const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
      x = Math.min(...xs); y = Math.min(...ys); w = Math.max(...xs) - x; d = Math.max(...ys) - y;
    }
    return { name: r.name, color: r.color, level: r.level, open: r.open, x, y, w, d, poly };
  });
}
// Resolve wall-relative openings (doors / windows) to absolute
// {level, orient, x, y, w} on the current walls.
export function exportDoors(graph: WallGraph, doors: WallDoor[]): AbsDoor[] {
  return doors.map((dr): AbsDoor | null => {
    const w = graph.walls[dr.wall]; if (!w) return null;
    const a = graph.nodes[w.a], b = graph.nodes[w.b]; if (!a || !b) return null;
    const dx = b.x - a.x, dy = b.y - a.y;
    return {
      level: w.level,
      orient: Math.abs(dx) >= Math.abs(dy) ? "h" : "v",
      x: +(a.x + dx * dr.t).toFixed(2),
      y: +(a.y + dy * dr.t).toFixed(2),
      w: dr.w,
      // wall direction angle (A→B), so the SCAD export can place styled leaves +
      // casing along the actual wall (not just axis-aligned h/v).
      ang: +(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(3),
      // Door v2: style/color/casing carried through to the styled SCAD leaves.
      style: dr.style || "slab",
      color: dr.color || "#8a5a3c",
      casing: !!dr.casing,
      side: dr.side ?? 1,
      hand: dr.hand ?? 1,
    };
  }).filter((d): d is AbsDoor => d !== null);
}
// windows also carry sill (bottom height) + h (glass height)
export function exportWindows(graph: WallGraph, windows: WallWindow[]): AbsWindow[] {
  return windows.map((dr): AbsWindow | null => {
    const w = graph.walls[dr.wall]; if (!w) return null;
    const a = graph.nodes[w.a], b = graph.nodes[w.b]; if (!a || !b) return null;
    return {
      level: w.level,
      orient: Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? "h" : "v",
      x: +(a.x + (b.x - a.x) * dr.t).toFixed(2),
      y: +(a.y + (b.y - a.y) * dr.t).toFixed(2),
      w: dr.w, sill: dr.sill ?? 1.2, h: dr.h ?? 2.0,
    };
  }).filter((d): d is AbsWindow => d !== null);
}

// ---- stairs ------------------------------------------------------------
// A stair is a flight — or a CHAIN of flights joined by LANDINGS that turn the
// run — anchored at its level's floor (`floorZ`). It travels both ways from the
// floor: `up` feet ABOVE and `down` feet BELOW, so the run spans [floorZ - down,
// floorZ + up] over `steps` treads distributed across the flights in proportion
// to their length. Geometry comes from a CENTERLINE `path` (≥2 points, world
// feet) with a constant `width`; every straight segment is a flight, every
// INTERIOR vertex a square landing of side `width` sitting in the turn. A plain
// straight stair carries no `path`/`width`: stairPath() derives a two-point
// centerline from the legacy footprint {x,y,w,d} + ascent `dir`, so old files
// and the simple case round-trip unchanged.

// Centerline + width for a stair. With an explicit `path` it is returned as-is;
// otherwise a two-point centerline is derived from the legacy footprint so all
// downstream geometry has a single code path.
export function stairPath(s: Stair): { pts: number[][]; width: number } {
  if (Array.isArray(s.path) && s.path.length >= 2)
    return { pts: s.path.map((p) => [p[0], p[1]]), width: s.width ?? 3 };
  const x = s.x ?? 0, y = s.y ?? 0, w = s.w ?? 3, d = s.d ?? 4, dir = s.dir ?? "+y";
  if (dir === "+y") return { pts: [[x + w / 2, y], [x + w / 2, y + d]], width: w };
  if (dir === "-y") return { pts: [[x + w / 2, y + d], [x + w / 2, y]], width: w };
  if (dir === "+x") return { pts: [[x, y + d / 2], [x + w, y + d / 2]], width: d };
  return { pts: [[x + w, y + d / 2], [x, y + d / 2]], width: d };            // "-x"
}

// Corners of every flight rectangle (each segment grown by half-width
// PERPENDICULAR — not along its run, so end caps aren't over-extended). Their
// union bounds the whole footprint, landings included (a turn's landing square
// lies inside the two flights' corner span).
function stairCorners(pts: number[][], half: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1e-6;
    const px = (-dy / len) * half, py = (dx / len) * half;
    out.push([a[0] + px, a[1] + py], [a[0] - px, a[1] - py], [b[0] + px, b[1] + py], [b[0] - px, b[1] - py]);
  }
  return out;
}

// The footprint bounding box of a stair. The editor mirrors this into {x,y,w,d}
// so hit-testing, markers and the stairwell cuts keep working for turning stairs.
export function stairBBox(s: Stair) {
  const { pts, width } = stairPath(s), c = stairCorners(pts, width / 2);
  const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, d: Math.max(...ys) - y };
}

// Split `n` treads across flights weighted by run length, ≥1 per real flight,
// summing exactly to `n` (so heights stay continuous across landings).
function allocSteps(weights: number[], n: number): number[] {
  const pos = weights.map((w) => Math.max(0, w)), total = pos.reduce((a, b) => a + b, 0);
  if (total <= 1e-9) { const a = pos.map(() => 0); a[0] = n; return a; }     // all degenerate
  const alloc = pos.map((w) => (w > 1e-6 ? Math.max(1, Math.floor((n * w) / total)) : 0));
  let sum = alloc.reduce((a, b) => a + b, 0);
  while (sum > n) {                                  // shave from the flight with the most slack
    let bi = -1, bv = Infinity;
    pos.forEach((w, i) => { if (alloc[i] > 1) { const v = w / alloc[i]; if (v < bv) { bv = v; bi = i; } } });
    if (bi < 0) break; alloc[bi]--; sum--;
  }
  while (sum < n) {                                  // add to the hungriest flight
    let bi = -1, bv = -1;
    pos.forEach((w, i) => { if (w > 1e-6) { const v = w / (alloc[i] + 1); if (v > bv) { bv = v; bi = i; } } });
    if (bi < 0) break; alloc[bi]++; sum++;
  }
  return alloc;
}

// Shared layout pass: resolve the path into per-flight metadata, the tread
// allocation, the common base and per-riser height, and the cumulative height
// reached at each vertex. Pure; consumed by stairSteps() and stairVertexZs().
interface StairSeg {
  a: number[]; b: number[]; len: number; ang: number; ux: number; uy: number;
  r0: number; r1: number; usable: number;
}
function stairLayout(s: Stair, floorZ: number) {
  const { pts, width } = stairPath(s), half = width / 2;
  const up = s.up ?? 0, down = s.down ?? 0, span = up + down;
  const base = floorZ - down, nTotal = Math.max(1, s.steps | 0), riser = span / nTotal;
  const segs: StairSeg[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1e-6;
    segs.push({ a, b, len, ang: Math.atan2(dy, dx), ux: dx / len, uy: dy / len, r0: 0, r1: 0, usable: 0 });
  }
  const nSeg = segs.length;
  segs.forEach((sg, i) => {                          // reserve a landing (half) at each interior vertex
    sg.r0 = i === 0 ? 0 : half;
    sg.r1 = Math.max(sg.r0, (i === nSeg - 1 ? sg.len : sg.len - half));
    sg.usable = sg.r1 - sg.r0;
  });
  const counts = allocSteps(segs.map((sg) => sg.usable), nTotal);
  const vertexZ: number[] = [base - floorZ];          // height (rel. floor) reached at each vertex
  let gi = 0;
  counts.forEach((c) => { gi += c; vertexZ.push(base - floorZ + gi * riser); });
  return { pts, width, half, base, riser, segs, counts, vertexZ };
}

// Each step (and landing) as an ORIENTED box centered at (cx,cy), `l` deep along
// the flight, `w` wide across it, yawed `ang` radians, rising from the common
// base z0 to its tread top z1 (a solid "ziggurat", filled underneath). Landings
// carry landing:true and sit a full width square at the turn. Pure (floor passed
// in), so the three.js viewer and the SCAD export build identical geometry.
export function stairSteps(s: Stair, floorZ = 0): StairStep[] {
  const { base, riser, half, width, segs, counts } = stairLayout(s, floorZ);
  const out: StairStep[] = [];
  let gi = 0;
  for (let i = 0; i < segs.length; i++) {
    const sg = segs[i];
    if (i > 0 && half > 1e-6)                         // landing at this flight's start vertex
      out.push({ cx: sg.a[0], cy: sg.a[1], l: 2 * half, w: 2 * half,
        z0: base, z1: base + gi * riser, ang: sg.ang, landing: true });
    const m = counts[i];
    for (let j = 0; j < m; j++) {
      const f0 = sg.r0 + (sg.usable * j) / m, f1 = sg.r0 + (sg.usable * (j + 1)) / m;
      const mid = (f0 + f1) / 2;
      gi++;
      out.push({ cx: sg.a[0] + sg.ux * mid, cy: sg.a[1] + sg.uy * mid,
        l: f1 - f0, w: width, z0: base, z1: base + gi * riser, ang: sg.ang, landing: false });
    }
  }
  return out;
}

// World heights of the path vertices (foot … top), for placing the editor's
// per-vertex markers at the tread level they sit on.
export function stairVertexZs(s: Stair, floorZ = 0): number[] {
  return stairLayout(s, floorZ).vertexZ.map((z) => floorZ + z);
}

// The opening a stair needs in a floor slab it passes through. Unlike a wall cut
// (inset, so the shaft's own walls survive) the FLOOR must clear the WHOLE stair
// — the bounding box of its (possibly turning) run — plus a `headroom` extension
// at the top (high) end so a person can walk the final flight without the floor
// edge clipping their head. Extends along the LAST flight's direction.
export function stairFloorOpening(s: Stair, headroom = 2.0) {
  const { pts, width } = stairPath(s), c = stairCorners(pts, width / 2);
  const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (Math.abs(dx) >= Math.abs(dy)) { if (dx >= 0) x1 += headroom; else x0 -= headroom; }
  else if (dy >= 0) y1 += headroom; else y0 -= headroom;
  return { x0, y0, x1, y1 };
}

export function ftIn(ft: number): string {
  const sign = ft < 0 ? "-" : ""; ft = Math.abs(ft);
  let f = Math.floor(ft), inch = Math.round((ft - f) * 12);
  if (inch === 12) { f++; inch = 0; }
  return `${sign}${f}'${inch}"  (${ft.toFixed(2)} ft)`;
}
