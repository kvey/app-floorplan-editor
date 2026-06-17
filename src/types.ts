// Shared domain types for the floor-plan engine. Imported with `import type`
// everywhere, so this module is erased at runtime (no value exports) — it exists
// purely to give the engine modules (rooms/walls/scad/doors/…) and the viewer
// (main.ts) one source of truth for the model shapes.

// ---- geometry primitives ----------------------------------------------------
export type Dir = "+x" | "-x" | "+y" | "-y";
export type Vec2 = [number, number];
export type MouldKind = "base" | "chair" | "crown";

// A solid box in CENTER+SIZE form (furniture / cabinets output).
export interface PartBox {
  cx: number; cy: number; cz: number;
  sx: number; sy: number; sz: number;
  color: string;
}

// A solid box in MIN/MAX form (door leaves / moulding runs). `color` may be null
// (casing inherits the wall colour from the consumer).
export interface LocalBox {
  x0: number; x1: number;
  y0: number; y1: number;
  z0: number; z1: number;
  color: string | null;
}

// ---- rooms ------------------------------------------------------------------
export interface Room {
  name: string;
  x: number; y: number; w: number; d: number;
  level: number;
  color: string;
  open?: boolean;
  poly?: Vec2[];
}

// ---- doors / windows --------------------------------------------------------
// Absolute opening as stored in rooms.js DOORS and produced by exportDoors().
export interface AbsDoor {
  level: number;
  orient: "h" | "v";
  x: number; y: number; w: number;
  ang?: number;
  style?: string;
  color?: string;
  casing?: boolean;
  side?: number;
  hand?: number;
}

// Absolute window (exportWindows output): like a door plus sill/glass height.
export interface AbsWindow {
  level: number;
  orient: "h" | "v";
  x: number; y: number; w: number;
  sill?: number;
  h?: number;
}

// Wall-relative door — the editable working shape (sits on wall `wall` at param
// `t` along it). Door v2 carries style/colour/casing/side/hand.
export interface WallDoor {
  wall: number;
  t: number;
  w: number;
  style?: string;
  color?: string;
  casing?: boolean;
  side?: number;
  hand?: number;
}

// Wall-relative window.
export interface WallWindow {
  wall: number;
  t: number;
  w: number;
  sill?: number;
  h?: number;
}

// ---- stairs -----------------------------------------------------------------
export interface Stair {
  name?: string;
  level: number;
  x?: number; y?: number; w?: number; d?: number;
  dir?: Dir;
  steps: number;
  up?: number;
  down?: number;
  path?: Vec2[];
  width?: number;
  // legacy fields migrated away by migrateStair()
  top?: number;
  rise?: number;
}

// One oriented step/landing box produced by stairSteps().
export interface StairStep {
  cx: number; cy: number;
  l: number; w: number;
  z0: number; z1: number;
  ang: number;
  landing: boolean;
}

// ---- furniture / cabinets ---------------------------------------------------
export interface Furniture {
  type: string;
  level: number;
  x: number; y: number; w: number; d: number;
  h?: number;
  dir?: Dir;
  color?: string;
}

export interface Cabinet {
  kind?: string;
  level: number;
  x: number; y: number; w: number; d: number;
  h?: number;
  dir?: Dir;
  front?: string;
  drawers?: number;
  counter?: boolean;
  mount?: number;
  color?: string;
  counterColor?: string;
  wall?: number;   // transient: index of the wall this cabinet is snapped to
}

// ---- mouldings --------------------------------------------------------------
export interface Moulding {
  room: number;
  kind: MouldKind;
  profile?: string;
  h?: number;
  d?: number;
  color?: string;
}

// A precomputed moulding run row passed to roomsToScad():
//   [level, ax, ay, bx, by, z0, h, d, profileCode, crown(0|1), color]
export type MldRunRow = [
  number, number, number, number, number,
  number, number, number, number, number,
  string,
];

// A wall-run segment in world XY produced by mouldingRuns().
export interface MouldRun {
  ax: number; ay: number;
  bx: number; by: number;
}

// ---- labels -----------------------------------------------------------------
export interface Label {
  text: string;
  x: number; y: number;
  level: number;
}

// ---- roof -------------------------------------------------------------------
export interface RoofCut {
  poly?: Vec2[];
  x?: number; y?: number; w?: number; d?: number;
}
export interface Skylight {
  x: number; y: number; w: number; d: number;
}
export interface Roof {
  thickness?: number;
  color?: string;
  cuts?: RoofCut[];
  skylights?: Skylight[];
}

// ---- wall graph -------------------------------------------------------------
export interface WallNode {
  x: number; y: number;
  level: number;
}
export interface Wall {
  a: number; b: number;
  level: number;
}
export interface WallGraph {
  nodes: WallNode[];
  walls: Wall[];
  roomLoops: number[][];
}

// A door resolved to hinge/leaf/swing data (doorFrame output).
export interface DoorFrame {
  hinge: { x: number; y: number };
  dir: { x: number; y: number };
  openDir: { x: number; y: number };
  A: number;
  leaf: number;
  level: number;
  baseAngle: number;
}

// One leaf placement frame (doorLeafFrames output).
export interface LeafFrame {
  hx: number; hy: number;
  baseDeg: number;
  swingSign: number;
  w: number;
  leaf: string;
  mode?: "slide";
  slideSign?: number;
}
