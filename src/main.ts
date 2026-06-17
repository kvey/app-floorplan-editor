// Browser viewer: a fully realtime floor-plan editor rendered with three.js.
// UNIFIED MODEL (src/walls.js): every room is a LOOP of shared node indices,
// walls are the loop edges, floors are the loop polygons, doors sit on walls.
// Because floors and walls reference the SAME nodes, floors always match walls.
// All geometry is rebuilt procedurally in three.js (no per-edit recompile);
// OpenSCAD (src/scad.js / floorplan.scad) remains the export format. Tools:
//   • Measure — click two points, get the distance in ft-in.
//   • Walls   — multi-select (marquee/shift) nodes; drag moves the selection;
//               drag a wall body to PUSH it (the whole colinear run shifts)
//     with live wall dimensions; double-click a node to PIN its dimensions and
//     click a label to type an exact ft-in distance; explicit Weld merges;
//     Delete punches holes.
//   • Doors   — click a wall to add; select/drag/Flip/Delete doors (no tap-delete).

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Sky } from "three/addons/objects/Sky.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { ROOMS, DOORS, CONST, LEVEL_Z, ROOF, STAIRS, FURNITURE } from "./rooms.ts";
import { roomsToScad } from "./scad.ts";
import { FURNITURE_TYPES, FURNITURE_ORDER, furnitureParts } from "./furniture.ts";
import { CABINET_KINDS, CABINET_ORDER, FRONT_ORDER, cabinetParts } from "./cabinets.ts";
import { DOOR_STYLES, DOOR_STYLE_ORDER, doorLeafParts, doorLeafFrames, casingParts } from "./doors.ts";
import { MOULDING_PROFILES, MOULDING_PROFILE_ORDER, PROFILE_CODE, KIND_DEFAULTS,
  mouldingRuns, mouldingRunParts, mouldingZ } from "./moulding.ts";
// Pure state normalizers/migrations (shared with tests/state-compat.test.mjs so
// the "legacy file loads" guarantee is exercised through THE SAME code).
import { normDoor, normFurn, normCab, migrateStair, normLabel, seedLabels } from "./normalize.ts";
import { parseFeet } from "./ui/ftparse";
import { deriveWallGraph, seedDoors, doorPoint, nearestWall, ftIn, floorFaces,
  nearestNode, weldNodes, weldGroup, doorFrame, snap, splitWall, deleteNode, remapLoops, insertInLoops,
  collinearNodes, wallNormal,
  exportRooms, exportDoors, exportWindows, stairSteps, stairFloorOpening,
  stairPath, stairBBox, stairVertexZs } from "./walls.ts";
import type {
  Room, AbsDoor, WallDoor, WallWindow, Cabinet, Furniture, Moulding, Label,
  Stair, Vec2, MldRunRow, RoofCut, Skylight, Dir, MouldKind,
} from "./types.ts";

// DOM helper: getElementById returns HTMLElement | null and the call sites poke
// at element-specific props (.value/.checked/.style/…). The viewer is the sole
// owner of its DOM, so `$` returns `any` — null-guards at the call sites still
// work; we just don't re-derive the element subtype 165 times.
const $ = (id: string): any => document.getElementById(id);
const qs = (sel: string, root: ParentNode = document): any => root.querySelector(sel);

const WALL_T = 0.5;          // wall thickness (matches scad.js)
let wallH = CONST.WALL_H;    // global wall height (live-adjustable via the HUD)
let doorOpenDeg = 80;        // global door swing: 0 = shut, ~110 = wide open
let gridSize = 1;            // endpoint snap grid (ft); 0 = off
let framingMode = false;     // render walls as stud framing instead of solid panels
// stick-framing dimensions (feet): studs ~1.5" faces at 16" on-center, ~1.5" plates
const FRAME_STUD = 0.125;    // stud face width along the wall (~1.5")
const FRAME_SPACING = 1.333; // studs 16" on-center
const FRAME_PLATE = 0.125;   // top/bottom plate thickness
const WELD_TOL = 1.0;        // weld endpoints within this distance (ft)

// When STACKED (unexploded), the main level sits with its floor slab resting
// directly on top of the lower level's walls. The lower walls rise to `wallH`,
// and the main floor was built at LEVEL_Z[1] with its slab bottom at
// LEVEL_Z[1] - SLAB, so shift the main group by this amount to make them flush.
// Derived from the LIVE wallH (ceiling height), so changing wall height keeps
// the floors flush instead of overlapping (taller) or floating (shorter).
const stackOffset = () => wallH - (LEVEL_Z[1] - CONST.SLAB);
function applyStack() { if (V.main) V.main.position.z = V.exploded ? 0 : stackOffset(); }

// ---- editable working state ----
// Unified graph: rooms are node LOOPS, walls are loop edges, floors are loop
// polygons — all sharing `graph.nodes`, so floors always match walls.
const rooms: Room[] = ROOMS.map((r) => ({ ...r, poly: r.poly ? r.poly.map((p) => [p[0], p[1]] as Vec2) : undefined }));
let graph = deriveWallGraph(rooms);     // { nodes, walls, roomLoops }
let roomLoops = graph.roomLoops;         // roomLoops[i] = node indices of room i's polygon
// Door v2 (Phase 3): each door carries a style/color/casing. normDoor (imported
// from src/normalize.js) migrates legacy doors (no style) to a plain SLAB with no
// casing so old files render identically. Applied wherever doors are loaded/
// restored/seeded/duplicated.
let doors: WallDoor[] = seedDoors(graph, DOORS).map(normDoor);   // [{ wall, t, w, style, color, casing }]
let doorStyle = "slab", doorColor = "#8a5a3c", doorCasing = false;   // defaults for NEW doors
let doorWidthDefault = 2.6;                                          // default clear width for NEW doors
let windows: WallWindow[] = [];          // [{ wall, t, w, sill, h }] — sill = bottom height, h = glass height
// ---- stairs: solid stepped blocks (front stoop + interior stair), absolute Z ----
const INTER_FLOOR = CONST.WALL_H + CONST.SLAB;        // one storey of travel (default)
// A stair travels `up` above and `down` below its level floor. Older saved stairs
// stored a single `rise` + absolute `top`; migrateStair (src/normalize.js) maps
// them to up/down (idempotent).
let stairs: Stair[] = STAIRS.map(migrateStair);
let stairW = 3.0, stairRun = 4.0, stairUp = INTER_FLOOR, stairDown = 0, stairCount = 6;  // defaults for new stairs
// ---- furniture: placeable pieces (cabinets, island, beds, couches) ----
// Each is a footprint {x,y,w,d} on a level with a type, height h, facing dir, and
// optional color. See src/furniture.js for the per-type geometry (shared with the
// SCAD export). `furnType` etc. are the defaults applied to newly-placed pieces.
let furniture: Furniture[] = FURNITURE.map(normFurn);   // normFurn from src/normalize.js
let furnType = "cabinet";
let furnW = FURNITURE_TYPES.cabinet.w, furnD = FURNITURE_TYPES.cabinet.d, furnH = FURNITURE_TYPES.cabinet.h;
// ---- mouldings: per-room, per-kind interior trim (base / chair / crown) ----
// Each is { room, kind, profile, h, d, color }; at most one per (room,kind).
// Geometry comes from src/moulding.js (mouldingRuns + mouldingRunParts), shared
// with the SCAD export. mld* are the defaults applied to newly-applied mouldings.
let mouldings: Moulding[] = [];
let mldKind = "base", mldProfile = KIND_DEFAULTS.base.profile;
let mldH = KIND_DEFAULTS.base.h, mldD = KIND_DEFAULTS.base.d, mldColor = "#f0ece4";
// ---- cabinets: first-class kitchen/storage cabinets (Phase 5) -------------
// Each is a footprint {x,y,w,d} on a level with a kind (base/wall/tall), a front
// style (slab/shaker), drawer rows, a counter flag, a mount height, and colors.
// Geometry comes from src/cabinets.js (cabinetParts), shared with the SCAD export.
// cab* are the defaults applied to newly-placed cabinets. normCab (imported from
// src/normalize.js) fills defaults for legacy/partial records.
let cabinets: Cabinet[] = [];
let cabKind = "base", cabFront = "shaker", cabDrawers = 0, cabCounter = CABINET_KINDS.base.counter;
let cabColor = "#9aa3ad", cabCounterColor = "#dcd8d0";
let cabW = CABINET_KINDS.base.w, cabD = CABINET_KINDS.base.d, cabH = CABINET_KINDS.base.h, cabMount = CABINET_KINDS.base.mount;
// ---- labels: positionable text annotations in the scene (Phase 7) ----------
// Each is { text, x, y, level } in world feet at the label anchor. `labels` starts
// NULL as a sentinel meaning "legacy state, needs seeding": when a saved blob
// carries no labels array, we derive one label per named room from seedLabels()
// the first time `rooms` exists (a silent migration; the next auto-save persists
// it). normLabel (src/normalize.js) coerces partial/legacy records.
let labels: Label[] | null = null;
// ---- roof state ----
// Roof openings live in main-level (XY) coords. cuts open to sky; skylights are
// glazed. Both are centered rects {x,y,w,d}; a cut may instead carry a `poly`.
let roofCuts: RoofCut[] = (ROOF.cuts || []).map((c) => ({ ...c, poly: c.poly ? c.poly.map((p) => [p[0], p[1]] as Vec2) : undefined }));
let skylights: Skylight[] = (ROOF.skylights || []).map((s) => ({ ...s }));
let roofThickness = ROOF.thickness ?? 0.4;
let roofShown = false;                    // view toggle: false = hidden (shadow-only), true = solid
let skyW = 3.0, skyD = 3.0;               // default size for new skylights/cuts (ft)
// ---- sun (directional key light) position, as compass azimuth + elevation ----
let sunAz = 235;                          // azimuth (deg): compass direction the light comes FROM
let sunEl = 45;                           // elevation (deg): height above the horizon (90 = straight down)
// ---- reference plan underlay ("onion skin") ---------------------------------
// An uploaded image rendered translucently over the top-down Plan view so a
// reference floor plan can be traced against the model. The image is kept as a
// data URL in the saved state (downscaled at upload so the floorplan.scad
// header stays a manageable size). It is a VIEW AID: edits to it save but never
// enter the undo history. w = image width in world ft (0 → auto-fit the model);
// x/y = center offset from the model center (ft).
let refPlan = { img: null, opacity: 0.5, w: 0, x: 0, y: 0, shown: true };
let winWidth = 3.0, winSill = 1.2, winHeight = 2.0;   // defaults for new windows (ft)
const WIN_SILL = 1.2, WIN_H = 2.0;       // fallback sill / height
const DOOR_HEAD = 1.2;                   // solid wall left above each doorway
const DOOR_HEADER_LAP = 0.03;            // hide raster/merge seams at the lintel
const doorTop = () => Math.max(0.3, wallH - Math.min(DOOR_HEAD, wallH - 0.3));
// vertical band [z0,z1] of a window, clamped into the wall
function winBand(win: any) {
  const z0 = Math.max(0, Math.min(win.sill ?? WIN_SILL, wallH - 0.3));
  let z1 = Math.min(wallH, z0 + (win.h ?? WIN_H));
  if (z1 - z0 < 0.3) z1 = Math.min(wallH, z0 + 0.3);
  return { z0, z1 };
}

// ---- A/B scenario state (declared early so persistence can capture it) ----
// The home is modeled as an ORDERED LIST OF STATES, each independently editable
// with its own undo/redo history:
//   states[0]    = A  (the as-built home)
//   states[last] = B  (the proposed home)
//   states[k]    = intermediate modification step k
// `cur` is the active state. `history`/`hi` ALIAS states[cur] — every edit's
// commit() lands in the active state's own history, so you can jump to ANY state
// (including A) and keep editing it, with per-state undo. Each state entry is
// { label, history:[{label,snap}], hi }.
let states: any[] = [];
let cur = 0;
let history: any[] = [];   // === states[cur].history (re-aliased on every state switch)
let hi = -1;        // === states[cur].hi      (mirrored back into states[cur])
let syncSteps = false;   // when on, an edit propagates to the same object in every other step

// ---- persistence: the on-disk floorplan.scad IS the source of truth. --------
// The full editable state is embedded as a base64 block-comment HEADER at the top
// of floorplan.scad (so the file is still a valid, openable OpenSCAD model), and
// every committed edit / slider change AUTO-SAVES by POSTing the regenerated file
// to the server, which overwrites floorplan.scad. On load we read that file back
// (GET /api/floorplan-scad) and restore the embedded state. No localStorage.
const STATE_TAG = "KIRKHAM-STATE-V1";
let restored = false;      // set by the async boot before build()
let booting = true;        // suppress auto-save while restoring at boot
// The complete editable state as a plain object (same shape as the old LS blob).
function stateBlob() {
  return {
    v: 1, nodes: graph.nodes, walls: graph.walls, roomLoops, doors, windows, stairs, furniture, mouldings, cabinets, labels, wallH, doorOpenDeg, winWidth, winSill, winHeight, framingMode,
    stairW, stairRun, stairUp, stairDown, stairCount, furnType, furnW, furnD, furnH,
    doorStyle, doorColor, doorCasing,
    mldKind, mldProfile, mldH, mldD, mldColor,
    cabKind, cabFront, cabDrawers, cabCounter, cabColor, cabCounterColor, cabW, cabD, cabH, cabMount,
    roofCuts, skylights, roofThickness, roofShown, skyW, skyD, sunAz, sunEl, refPlan,
    states, cur, syncSteps,
  };
}
// base64 (UTF-8 safe) so the embedded JSON can never contain a `*/` that would
// close the comment early — the header survives any room name / label.
const b64enc = (s: any) => btoa(unescape(encodeURIComponent(s)));
const b64dec = (s: any) => decodeURIComponent(escape(atob(s)));
// the exact bytes written to disk: state header comment + the generated geometry.
function fileScad() {
  const blob = b64enc(JSON.stringify(stateBlob()));
  return `/* ${STATE_TAG}\n${blob}\n${STATE_TAG} */\n` + currentScad();
}
// pull the embedded state back out of a floorplan.scad's header (null if absent).
function extractState(text: any) {
  const re = new RegExp("/\\*\\s*" + STATE_TAG + "\\s*\\n([\\s\\S]*?)\\n" + STATE_TAG + "\\s*\\*/");
  const m = (text || "").match(re);
  if (!m) return null;
  try { return JSON.parse(b64dec(m[1].replace(/\s+/g, ""))); }
  catch (e: any) { return null; }
}
function applyState(s: any) {
  if (!(s && Array.isArray(s.nodes) && Array.isArray(s.walls))) return false;
  graph.nodes = s.nodes; graph.walls = s.walls;
  if (s.roomLoops) roomLoops = s.roomLoops;
  if (s.doors) doors = s.doors.map(normDoor);
  if (s.windows) windows = s.windows;
  if (Array.isArray(s.stairs)) stairs = s.stairs.map(migrateStair);
  if (Array.isArray(s.furniture)) furniture = s.furniture.map(normFurn);
  if (Array.isArray(s.mouldings)) mouldings = s.mouldings.map((m: any) => ({ ...m }));
  if (Array.isArray(s.cabinets)) cabinets = s.cabinets.map(normCab);
  // labels: a saved array loads normalized; ABSENCE leaves `labels` null so the
  // boot path seeds them once from the room names (silent migration, §7).
  if (Array.isArray(s.labels)) labels = s.labels.map(normLabel);
  if (typeof s.cabKind === "string") cabKind = s.cabKind;
  if (typeof s.cabFront === "string") cabFront = s.cabFront;
  if (typeof s.cabDrawers === "number") cabDrawers = s.cabDrawers;
  if (typeof s.cabCounter === "boolean") cabCounter = s.cabCounter;
  if (typeof s.cabColor === "string") cabColor = s.cabColor;
  if (typeof s.cabCounterColor === "string") cabCounterColor = s.cabCounterColor;
  if (typeof s.cabW === "number") cabW = s.cabW;
  if (typeof s.cabD === "number") cabD = s.cabD;
  if (typeof s.cabH === "number") cabH = s.cabH;
  if (typeof s.cabMount === "number") cabMount = s.cabMount;
  if (typeof s.mldKind === "string") mldKind = s.mldKind;
  if (typeof s.mldProfile === "string") mldProfile = s.mldProfile;
  if (typeof s.mldH === "number") mldH = s.mldH;
  if (typeof s.mldD === "number") mldD = s.mldD;
  if (typeof s.mldColor === "string") mldColor = s.mldColor;
  if (typeof s.furnType === "string") furnType = s.furnType;
  if (typeof s.furnW === "number") furnW = s.furnW;
  if (typeof s.furnD === "number") furnD = s.furnD;
  if (typeof s.furnH === "number") furnH = s.furnH;
  if (typeof s.doorStyle === "string") doorStyle = s.doorStyle;
  if (typeof s.doorColor === "string") doorColor = s.doorColor;
  if (typeof s.doorCasing === "boolean") doorCasing = s.doorCasing;
  if (typeof s.stairW === "number") stairW = s.stairW;
  if (typeof s.stairRun === "number") stairRun = s.stairRun;
  if (typeof s.stairUp === "number") stairUp = s.stairUp;
  else if (typeof s.stairRise === "number") stairUp = s.stairRise;   // legacy key
  if (typeof s.stairDown === "number") stairDown = s.stairDown;
  if (typeof s.stairCount === "number") stairCount = s.stairCount;
  if (typeof s.wallH === "number") wallH = s.wallH;
  if (typeof s.doorOpenDeg === "number") doorOpenDeg = s.doorOpenDeg;
  if (typeof s.winWidth === "number") winWidth = s.winWidth;
  if (typeof s.winSill === "number") winSill = s.winSill;
  if (typeof s.winHeight === "number") winHeight = s.winHeight;
  if (typeof s.framingMode === "boolean") framingMode = s.framingMode;
  if (Array.isArray(s.roofCuts)) roofCuts = s.roofCuts;
  if (Array.isArray(s.skylights)) skylights = s.skylights;
  if (typeof s.roofThickness === "number") roofThickness = s.roofThickness;
  if (typeof s.roofShown === "boolean") roofShown = s.roofShown;
  if (typeof s.skyW === "number") skyW = s.skyW;
  if (typeof s.skyD === "number") skyD = s.skyD;
  if (typeof s.sunAz === "number") sunAz = s.sunAz;
  if (typeof s.sunEl === "number") sunEl = s.sunEl;
  if (s.refPlan && typeof s.refPlan === "object") refPlan = { ...refPlan, ...s.refPlan };
  if (Array.isArray(s.states) && s.states.length) {
    states = s.states;
    cur = typeof s.cur === "number" && s.cur >= 0 && s.cur < states.length ? s.cur : 0;
  }
  if (typeof s.syncSteps === "boolean") syncSteps = s.syncSteps;
  return true;
}
// Read floorplan.scad from the server and restore its embedded state.
async function loadStateFromServer() {
  try {
    const res = await fetch("/api/floorplan-scad", { cache: "no-store" });
    if (!res.ok) return false;
    const j = await res.json();
    const s = extractState(j.scad || "");
    return s ? applyState(s) : false;
  } catch (e: any) { return false; }   // server down / no file → start from the measured plan
}
// ---- auto-save: debounced overwrite of floorplan.scad through the server -----
const setSaveStatus = (t: any) => { const el = $("saved"); if (el) el.textContent = t; };
let saveTimer: any = null, saveSeq = 0;
function saveState() {                 // called on every committed edit / slider change
  if (booting) return;                 // don't write while restoring at boot
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 450);   // coalesce rapid edits (slider drags) into one write
}
async function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const my = ++saveSeq;
  setSaveStatus("Saving…");
  try {
    const res = await fetch("/api/save-scad", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scad: fileScad() }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || res.statusText);
    if (my === saveSeq) setSaveStatus(`Saved to floorplan.scad (${j.bytes} bytes).`);
  } catch (e: any) {
    if (my === saveSeq) setSaveStatus("Save failed: " + e.message + " (is server.py running?)");
  }
}

// ---- edit history (undo/redo + jump-to-any-state) ----
// Each entry snapshots the editable state (node positions + doors). Wall
// topology (a/b pairs) doesn't change under the current edits, so snapshotting
// node coords + doors is sufficient and cheap. `history`/`hi` are declared above
// (they alias the ACTIVE state's history; see the A/B scenario notes).
const clone = (arr: any) => arr.map((o: any) => ({ ...o }));
// Snapshot the FULL editable graph — nodes AND walls (topology changes under
// split/weld/delete) plus doors. Missing walls here was a bug: undo across a
// topology edit left walls referencing deleted nodes.
const snapshot = () => ({ nodes: clone(graph.nodes), walls: clone(graph.walls), doors: clone(doors),
  windows: clone(windows), stairs: clone(stairs), furniture: clone(furniture),
  mouldings: clone(mouldings), cabinets: clone(cabinets), labels: clone(labels || []),
  roomLoops: roomLoops.map((l) => [...l]),
  roofCuts: roofCuts.map((c) => ({ ...c, poly: c.poly ? c.poly.map((p) => [...p]) : undefined })),
  skylights: clone(skylights) });
// ---- live model index (§5.2): a cheap listing of every domain object for the
// Layers panel. Dispatched as a `kirkham:model` CustomEvent after every commit,
// applySnap, and switchState (and once at boot). Indices are array positions —
// the same `i` the per-tool select(i) APIs and V.selectObject(kind,i) consume.
function modelIndex() {
  const lvlName = (l: any) => (l === 1 ? "Main" : "Lower");
  const wallLevel = (wi: any) => { const w = graph.walls[wi]; return w ? w.level : 1; };
  return {
    rooms: rooms.map((r, i) => ({ i, name: r.name || "Room", color: r.color, level: r.level })),
    doors: doors.map((d, i) => ({ i, label: `Door ${ftIn(d.w).split("  ")[0]}`, level: wallLevel(d.wall), style: d.style || "slab" })),
    windows: windows.map((w, i) => ({ i, label: `Window ${ftIn(w.w).split("  ")[0]}`, level: wallLevel(w.wall) })),
    mouldings: mouldings.map((m, i) => {
      const r = rooms[m.room];
      const kindLbl = m.kind ? m.kind[0].toUpperCase() + m.kind.slice(1) : "Moulding";
      return { i, label: `${kindLbl} · ${m.profile} — ${r ? (r.name || "Room") : "?"}`, level: r ? r.level : 1 };
    }),
    cabinets: cabinets.map((c, i) => {
      const kindLbl = CABINET_KINDS[c.kind ?? "base"]?.label || "Cabinet";
      const wAlong = (c.dir === "+x" || c.dir === "-x") ? c.d : c.w;
      return { i, label: `${kindLbl} ${ftIn(wAlong).split("  ")[0]} — ${c.front || "shaker"}`, level: c.level };
    }),
    furniture: furniture.map((f, i) => ({ i, label: (FURNITURE_TYPES[f.type]?.label || f.type || "Piece"), level: f.level })),
    stairs: stairs.map((s, i) => ({ i, label: s.name || "Stair", level: s.level })),
    labels: labels ? labels.map((lb, i) => ({ i, label: lb.text || "Label", level: lb.level })) : [],
    roof: [
      ...skylights.map((s, i) => ({ i, kind: "sky", label: "Skylight" })),
      ...roofCuts.map((c, i) => ({ i, kind: "cut", label: "Roof cut" })),
    ],
  };
}
function dispatchModel() {
  try { window.dispatchEvent(new CustomEvent("kirkham:model", { detail: modelIndex() })); } catch (e: any) {}
}

function commit(label: any) {
  const pre = history[hi] ? history[hi].snap : null;   // tip BEFORE this edit (for cross-step sync)
  const snap = snapshot();
  history.length = hi + 1;                 // drop any redo tail
  history.push({ label, snap });
  hi = history.length - 1;
  if (states[cur]) states[cur].hi = hi;    // mirror cursor into the active state
  // Sync this edit to the SAME object in every other scenario step (where the
  // object is consistent). Runs only when the toggle is on and there's >1 state.
  if (syncSteps && pre && states.length > 1) propagateEdit(pre, snap, label);
  renderHistory();
  saveState();                             // auto-save every edit
  dispatchModel();                         // refresh the live Layers panel (§5.2)
}

// ---- cross-step edit propagation ("apply across all steps") ----------------
// A scenario step is a FORK of its predecessor, so right after forking every
// object lines up by index across states. This lets an edit made in one step
// apply to the SAME object in all other steps — but only where that object is
// still "consistent": the collection is aligned (same length) and the object at
// that index passes an identity check (a door on the same wall, furniture of the
// same type, a stair of the same name; node/loop edits require identical wall
// topology). Structural divergence (mismatched lengths) is left per-step.
// Property edits, single appends, and single deletes propagate; anything more
// divergent is skipped. Edits land as a new "⇄ …" entry in each affected step's
// own history (so they stay per-step undoable). Globals (wall height, sun, room
// colors) are already shared, so they need no syncing.
const jeq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const SYNC_COLL = {
  nodes:     { topo: true },                 // node positions — gated on equal wall topology
  roomLoops: { topo: true },
  doors:     { needTopo: true, id: (o: any) => o.wall },
  windows:   { needTopo: true, id: (o: any) => o.wall },
  stairs:    { id: (o: any) => o.name ?? null },
  furniture: { id: (o: any) => o.type },
  mouldings: { id: (o: any) => o.room + ":" + o.kind },
  cabinets:  { id: (o: any) => o.kind },
  labels:    { id: (o: any) => o.text },
  roofCuts:  { id: () => "*" },
  skylights: { id: () => "*" },
};
function idMatch(cfg: any, a: any, b: any) {
  if (cfg.topo) return true;                 // topology gate already ensured correspondence
  if (a == null || b == null) return false;
  return (cfg.id || (() => "*"))(a) === (cfg.id || (() => "*"))(b);
}
function propagateEdit(pre: any, post: any, label: any) {
  let affected = 0;
  for (let k = 0; k < states.length; k++) {
    if (k === cur || !states[k]) continue;
    const st = states[k], tip = st.history[st.hi]; if (!tip) continue;
    const topoOK = jeq(tip.snap.walls, pre.walls);   // target's topology == source's pre-edit topology
    let next: any = null;                                  // lazily-cloned target snapshot
    const ensure = () => (next || (next = structuredClone(tip.snap)));
    for (const [key, cfg] of Object.entries(SYNC_COLL)) {
      const A = pre[key], B = post[key], T = tip.snap[key];
      if (!Array.isArray(A) || !Array.isArray(B) || !Array.isArray(T)) continue;
      if (((cfg as any).topo || (cfg as any).needTopo) && !topoOK) continue;
      if (A.length === B.length) {                    // ---- property edit ----
        if (T.length !== A.length) continue;
        for (let i = 0; i < A.length; i++) {
          if (jeq(A[i], B[i])) continue;              // this element didn't change
          if (idMatch(cfg, T[i], A[i])) { ensure()[key][i] = structuredClone(B[i]); next._t = 1; }
        }
      } else if (B.length === A.length + 1) {         // ---- single append ----
        ensure()[key].push(structuredClone(B[B.length - 1])); next._t = 1;
      } else if (B.length === A.length - 1) {         // ---- single delete ----
        if (T.length !== A.length) continue;
        let r = A.length - 1;                          // removed index
        for (let i = 0; i < B.length; i++) if (!jeq(A[i], B[i])) { r = i; break; }
        const removed = A[r], arr = ensure()[key];
        let idx = idMatch(cfg, arr[r], removed) ? r : arr.findIndex((e: any) => jeq(e, removed));
        if (idx >= 0) { arr.splice(idx, 1); next._t = 1; } else if (!next._t) next = null;  // nothing removed → drop empty clone
      }
    }
    if (next && next._t) {
      delete next._t;
      st.history.length = st.hi + 1;
      st.history.push({ label: "⇄ " + label, snap: next });
      st.hi = st.history.length - 1;
      affected++;
    }
  }
  if (affected) {
    const s = $("saved");
    if (s) s.textContent = `Synced “${label}” to ${affected} other step${affected > 1 ? "s" : ""}.`;
  }
  return affected;
}

// The CURRENT edited model as OpenSCAD text (clean CSG shell from the edited room
// loops, so edits are reflected). Shared by the download + the server save.
// Precompute moulding RUN rows for the SCAD export (scad.js stays dumb): one row
// per run, z0 LOCAL to the level (0..wallH), so the SCAD draws them inside the
// per-level translate exactly like the casing/leaf tables.
//   [level, ax, ay, bx, by, z0, h, d, profileCode, crown(0|1), "color"]
function exportMouldingRuns() {
  const rows = [];
  for (const m of mouldings) {
    const r = rooms[m.room]; if (!r) continue;                 // unresolved room → skip
    if (!roomLoops[m.room] || roomLoops[m.room].length < 3) continue;
    const z0 = mouldingZ(m, wallH);
    const code = PROFILE_CODE[m.profile ?? "square"] ?? 0;
    const crown = m.kind === "crown" ? 1 : 0;
    const color = m.color || mldColor;
    for (const run of mouldingRuns(graph, roomLoops, doors, windows, m, wallH)) {
      rows.push([r.level, run.ax, run.ay, run.bx, run.by, z0, m.h ?? 0.3, m.d ?? 0.06, code, crown, color]);
    }
  }
  return rows;
}
function currentScad() {
  return roomsToScad(exportRooms(rooms, graph, roomLoops) as Room[], exportDoors(graph, doors), exportWindows(graph, windows),
    { thickness: roofThickness, color: ROOF.color, cuts: roofCuts, skylights }, stairs, furniture, exportMouldingRuns() as MldRunRow[], cabinets);
}
function exportScad() {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([currentScad()], { type: "text/plain" }));
  a.download = "floorplan.scad"; a.click();
  URL.revokeObjectURL(a.href);
}

// Export the live three.js model to a binary glTF (.glb) for Blender / any PBR
// renderer. glTF carries the geometry AND physically-based materials (metalness/
// roughness, vertex colors, transmissive glass) so Blender imports it straight
// into Principled BSDF nodes — real-time PBR in Eevee/Cycles with no rebuild.
// We bake each mesh's world matrix into a clone so the export is correct whether
// the levels are exploded or stacked, skip editor helpers + swing-arc lines, and
// force the roof solid + upgrade glass to true transmission for the export only.
const GLB_NAMES: Record<string, string> = { "0-floor": "Lower-Floor", "0-wall": "Lower-Walls", "0-door": "Lower-Doors", "0-doorglass": "Lower-DoorGlass", "0-glass": "Lower-Glass", "0-stair": "Lower-Stairs", "0-furn": "Lower-Furniture", "0-mld": "Lower-Moulding", "0-cab": "Lower-Cabinets",
  "1-floor": "Main-Floor", "1-wall": "Main-Walls", "1-door": "Main-Doors", "1-doorglass": "Main-DoorGlass", "1-glass": "Main-Glass", "1-stair": "Main-Stairs", "1-furn": "Main-Furniture", "1-mld": "Main-Moulding", "1-cab": "Main-Cabinets",
  "1-roof": "Roof", "1-roofglass": "Skylights-Glass" };
// Build a binary glTF (.glb) ArrayBuffer of the live model. Resolves with the
// bytes; shared by the file download AND the server render. Bakes world matrices
// (correct exploded or stacked), skips helpers/arc lines, uses an opaque roof
// slab, upgrades glass to true transmission, and carries the sun as a directional
// light. With `filter` true the export MATCHES the on-screen view — only the
// floor(s) the floor-filter shows, and the skylight glass only when the roof is
// shown. The roof slab itself is ALWAYS included (opaque) so it can cast shadows;
// when the roof is hidden the caller flags it shadow-only in Blender, so the
// main level is still lit through the skylights/patio (lighting preserved).
function buildGlb(filter = false) {
  return new Promise((resolve, reject) => {
    const root = new THREE.Group(); root.name = "FloorPlan";
    // thin-walled transmissive glass: transmission + ior, but NO thickness, so the
    // export omits KHR_materials_volume (whose default infinite attenuation trips
    // Blender's glTF importer). Renders as clean clear glass in Eevee/Cycles.
    const glassMat = new THREE.MeshPhysicalMaterial({ name: "Glass", color: 0xbfe6f2, roughness: 0.05, metalness: 0.0,
      transmission: 1.0, ior: 1.45, thickness: 0.0, transparent: true, side: THREE.DoubleSide });
    // opaque roof material for the export (the live roofMat may be transparent for
    // the "hidden" view; an opaque slab casts reliable shadows in Blender).
    const roofMat = new THREE.MeshStandardMaterial({ name: "Roof", color: ROOF.color, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide });
    const glassKeys = new Set(["0-glass", "1-glass", "0-doorglass", "1-doorglass", "1-roofglass"]);
    for (const [k, m] of (Object.entries(V.meshes) as [string, any][])) {
      if (k.includes("arc")) continue;                               // skip line-segment swing arcs
      if (!m.geometry || (m.geometry.attributes.position?.count ?? 0) === 0) continue;   // skip empties
      const lvl = +k[0];
      if (filter && !levelVisible(lvl)) continue;                    // honor the floor filter
      if (k === "1-roofglass" && filter && !roofShown) continue;     // hide skylight glass with the roof
      m.updateWorldMatrix(true, false);
      const geo = m.geometry.clone(); geo.applyMatrix4(m.matrixWorld);  // bake world transform
      const mat = glassKeys.has(k) ? glassMat : (k === "1-roof" ? roofMat : m.material);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = GLB_NAMES[k] || k; root.add(mesh);
    }
    // carry the sun across as a directional light matching the editor's sun.
    const sunReal = V.scene.children.find((c: any) => c.isDirectionalLight);
    if (sunReal && V.center) {
      // glTF directional intensity is in LUX; Blender's importer divides by 683
      // (lm/W) for its sun energy (W/m²). Pre-multiply for a ~3.5 W/m² daylight sun.
      const sun = new THREE.DirectionalLight(0xfff4e6, 3.5 * 683); sun.name = "Sun";
      sun.position.copy(sunReal.position);
      // CRITICAL: a glTF directional light shines along its NODE's local -Z. three's
      // GLTFExporter reads the node orientation, NOT light.target — so we must
      // orient the node itself. lookAt() points a light's -Z at the target, so the
      // exported sun direction matches the editor's azimuth/elevation exactly.
      sun.lookAt(V.center); sun.updateMatrixWorld(true);
      root.add(sun);
    }
    const cleanup = () => { glassMat.dispose(); roofMat.dispose(); root.traverse((o: any) => o.geometry && o.geometry.dispose()); };
    new GLTFExporter().parse(root, (glb) => { cleanup(); resolve(glb); },
      (err) => { cleanup(); reject(err); }, { binary: true, onlyVisible: false });
  });
}
function exportGlb() {
  buildGlb(false).then((glb: any) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([glb], { type: "model/gltf-binary" }));
    a.download = "floorplan.glb"; a.click(); URL.revokeObjectURL(a.href);
    const s = $("saved"); if (s) s.textContent = "Exported floorplan.glb — import into Blender.";
  }).catch((err) => { console.error(err); fail("glTF export failed: " + (err?.message || err)); });
}

// ---- backend integration (server.py): save .scad + Blender render modal ----
const b64FromBuffer = (buf: any) => {
  const bytes = new Uint8Array(buf); let bin = ""; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as any);
  return btoa(bin);
};
// The 💾 button forces an IMMEDIATE save (otherwise edits auto-save, debounced).
// flushSave() writes the full file (state header + geometry) to floorplan.scad.
function saveScadToServer() { return flushSave(); }
// The active 3D camera state, in the world coords the .glb uses.
function cameraState() {
  const cam = V.pcam, tgt = V.pctrl.target, cv = V.renderer.domElement;
  return {
    pos: [cam.position.x, cam.position.y, cam.position.z],
    target: [tgt.x, tgt.y, tgt.z],
    up: [0, 0, 1],
    fov: cam.fov,
    width: cv.clientWidth || 960,
    height: cv.clientHeight || 640,
  };
}
// Export the model + send the current camera to the backend, which runs Blender
// and returns a PNG of exactly this view; show it in a modal.
async function renderOnServer() {
  openRenderModal();
  try {
    setRenderProgress(3, "Building model (.glb)…");
    const glb = await buildGlb(true);                              // filtered: match the on-screen view
    const cam = cameraState();
    // when the roof is hidden but the main level is shown, render the roof as a
    // SHADOW-ONLY object so it still lights the main floor through the openings.
    const shadowOnly = (!roofShown && levelVisible(1)) ? ["Roof"] : [];
    setRenderProgress(6, "Uploading to server…");
    const res = await fetch("/api/render", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ glb: b64FromBuffer(glb), camera: { pos: cam.pos, target: cam.target, up: cam.up, fov: cam.fov },
        width: cam.width, height: cam.height, shadowOnly }) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((j.error || "render failed") + (j.log ? "\n\n" + j.log : ""));
    }
    const { jobId } = await res.json();
    // poll the job for live, specific progress (phase label + bar) until it finishes
    for (;;) {
      await new Promise((r) => setTimeout(r, 350));
      let st;
      try { st = await fetch("/api/render-status?id=" + jobId).then((r) => r.json()); }
      catch (e: any) { continue; }                                      // transient network blip — keep polling
      if (st.error) throw new Error(st.error + (st.log ? "\n\n" + st.log : ""));
      setRenderProgress(st.progress, st.label);
      if (st.done) break;
    }
    setRenderProgress(99, "Fetching image…");
    const blob = await fetch("/api/render-result?id=" + jobId).then((r) => r.blob());
    showRenderImage(URL.createObjectURL(blob));
  } catch (e: any) {
    setRenderStatus("Render failed:\n" + e.message + "\n\n(Start the backend with ./serve.sh and ensure Blender is installed.)", true);
  }
}
// --- render modal (created lazily, reused) ---
let renderModalEls: any = null;
function ensureRenderModal() {
  if (renderModalEls) return renderModalEls;
  const back = document.createElement("div"); back.id = "render-modal";
  back.innerHTML =
    '<div class="rm-box">' +
    '<div class="rm-head"><b>Blender render</b><span class="rm-x" title="Close">✕</span></div>' +
    '<div class="rm-body">' +
    '<div class="rm-prog"><div class="rm-label"></div><div class="rm-bar"><i></i></div><div class="rm-pct">0%</div></div>' +
    '<div class="rm-status"></div><img class="rm-img" alt="" /></div>' +
    '<div class="rm-foot"><a class="tool rm-dl" download="kirkham-render.png">⬇ Save PNG</a></div>' +
    '</div>';
  document.body.appendChild(back);
  const close = () => { back.style.display = "none"; };
  qs(".rm-x", back).onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  addEventListener("keydown", (e) => { if (e.key === "Escape" && back.style.display === "flex") close(); });
  renderModalEls = { back, status: back.querySelector(".rm-status"), img: back.querySelector(".rm-img"),
    dl: back.querySelector(".rm-dl"), prog: back.querySelector(".rm-prog"), bar: back.querySelector(".rm-bar > i"),
    pct: back.querySelector(".rm-pct"), label: back.querySelector(".rm-label") };
  return renderModalEls;
}
function openRenderModal() {
  const m = ensureRenderModal();
  m.back.style.display = "flex"; m.img.style.display = "none"; m.img.src = ""; m.dl.style.display = "none";
  m.status.classList.remove("err"); m.status.textContent = "";
  m.prog.style.display = "block"; m.bar.style.width = "0%"; m.pct.textContent = "0%"; m.label.textContent = "";
}
// live progress bar + phase label while the server renders
function setRenderProgress(pct: any, label: any) {
  const m = ensureRenderModal();
  const p = Math.max(0, Math.min(100, pct || 0));
  m.prog.style.display = "block";
  m.bar.style.width = p + "%"; m.pct.textContent = Math.round(p) + "%";
  if (label != null) m.label.textContent = label;
  m.status.classList.remove("err"); m.status.textContent = "";
  m.img.style.display = "none"; m.dl.style.display = "none";
}
function setRenderStatus(text: any, isErr: any) {
  const m = ensureRenderModal(); m.status.textContent = text; m.status.classList.toggle("err", !!isErr);
  m.prog.style.display = "none";
  m.img.style.display = "none"; m.dl.style.display = "none";
}
function showRenderImage(url: any) {
  const m = ensureRenderModal(); m.status.textContent = ""; m.prog.style.display = "none";
  m.img.src = url; m.img.style.display = "block";
  m.dl.href = url; m.dl.style.display = "inline-block";
}
// Reset = discard edits and return to the measured plan. We reload with a flag so
// boot SKIPS the embedded state (builds the seed model), then the first auto-save
// overwrites floorplan.scad with that clean default.
function resetState() {
  try { sessionStorage.setItem("kirkham-reset", "1"); } catch (e: any) {}
  location.reload();
}
// Load a snapshot into the live editable model (shared by undo/redo history AND
// the A/B scenario player). Rebuilds editors + walls; does NOT touch history.
function applySnap(snap: any) {
  graph.nodes = clone(snap.nodes);
  graph.walls = clone(snap.walls);
  doors = clone(snap.doors).map(normDoor);
  if (snap.windows) windows = clone(snap.windows);
  if (snap.stairs) stairs = clone(snap.stairs).map(migrateStair);
  if (snap.furniture) furniture = clone(snap.furniture).map(normFurn);
  if (snap.mouldings) mouldings = clone(snap.mouldings);
  if (snap.cabinets) cabinets = clone(snap.cabinets).map(normCab);
  if (snap.labels) labels = clone(snap.labels).map(normLabel);
  roomLoops = snap.roomLoops.map((l: any) => [...l]);
  if (snap.roofCuts) roofCuts = snap.roofCuts.map((c: any) => ({ ...c, poly: c.poly ? c.poly.map((p: any) => [...p]) : undefined }));
  if (snap.skylights) skylights = clone(snap.skylights);
  if (V.refreshEditors) V.refreshEditors();   // rebuild handles/markers to the restored counts FIRST
  rebuildWalls();
  dispatchModel();                            // model changed wholesale (§5.2)
}
function restore(i: any) {
  if (i < 0 || i >= history.length || i === hi) return;
  applySnap(history[i].snap);
  hi = i;
  if (states[cur]) states[cur].hi = hi;    // per-state undo cursor
  renderHistory();
}
const undo = () => restore(hi - 1);
const redo = () => restore(hi + 1);
function renderHistory() {
  const el = $("history");
  if (!el) return;
  // History is PER STATE: this list is the active state's own undo stack.
  const tag = states[cur] ? `${cur === 0 ? "A" : cur === states.length - 1 ? "B" : cur + 1}` : "";
  const head = states[cur] ? `<div class="h-state">history of <b>${tag}</b> · ${esc(states[cur].label)}</div>` : "";
  el.innerHTML = head + history.map((h, i) =>
    `<div class="h ${i === hi ? "cur" : ""} ${i > hi ? "future" : ""}" data-i="${i}">` +
    `${i === hi ? "▶ " : ""}${esc(h.label)}<span class="t">#${i}</span></div>`).join("");
  el.querySelectorAll(".h").forEach((d: any) => (d.onclick = () => restore(+d.dataset.i)));
  $("undo")?.classList.toggle("disabled", hi <= 0);
  $("redo")?.classList.toggle("disabled", hi >= history.length - 1);
}

// ---- A/B scenario: the home as an ordered list of independently-editable STATES,
// from the AS-BUILT home (A = states[0]) to the PROPOSED home (B = states[last]),
// with modification steps in between. Each state carries its OWN undo/redo history;
// switching states swaps the active editing context (history/hi) so you can jump to
// ANY state — including A — and keep editing it, with that state's own undo.
let scnTimer: any = null;              // play-loop interval handle
function scnStop() { if (scnTimer) { clearInterval(scnTimer); scnTimer = null; } }
// Switch the active editing state. Re-aliases history/hi to states[j] and morphs
// the live model to that state's current model; later edits commit into state j.
// (commit/restore mirror hi into states[cur] continuously, so the outgoing state
// is already saved — nothing to flush before leaving it.)
function switchState(j: any) {
  if (j < 0 || j >= states.length || !states[j]) return;
  scnStop();
  cur = j;
  history = states[cur].history;
  hi = states[cur].hi;
  if (hi < 0 || hi >= history.length) hi = history.length - 1;
  if (V.clearSelections) V.clearSelections();      // selections belong to the old model
  if (history[hi]) applySnap(history[hi].snap);
  renderHistory(); renderScenario(); saveState();
  dispatchModel();                                 // switching state swaps the whole model (§5.2)
}
// Add a new modification step AFTER the current state, seeded with a COPY of the
// current model (its own fresh history), and switch to it so you can edit it.
function scnAddStep(label: any) {
  const at = cur + 1;
  const lbl = label && label.trim() ? label.trim() : `Step ${states.length}`;
  states.splice(at, 0, { label: lbl, history: [{ label: "Start", snap: snapshot() }], hi: 0 });
  switchState(at);
}
function scnRemoveStep(i: any) {
  if (states.length <= 1) return;                  // keep at least one state (A==B)
  if (i < 0 || i >= states.length) return;
  states.splice(i, 1);
  // Resolve cur onto a valid neighbour: clamp past the end, shift left if we
  // removed a state before it, otherwise stay put and land on the step that
  // slid into i's place (the deleted step's successor, or the new last/A).
  if (cur >= states.length) cur = states.length - 1;
  else if (cur > i) cur -= 1;
  switchState(cur);                                // re-alias history/hi + repaint
}
function scnRename(i: any, label: any) {
  if (label == null) return;
  const t = label.trim(); if (!t) return;
  if (states[i]) states[i].label = t;
  renderScenario(); saveState();
}
// Play the walkthrough A → … → B, pausing on each state. Rewinds to A if at B.
function scnPlay() {
  if (scnTimer) { scnStop(); renderScenario(); return; }
  if (states.length < 2) return;
  if (cur >= states.length - 1) switchState(0);    // at/after B → rewind to A first
  renderScenario();
  scnTimer = setInterval(() => {
    if (cur >= states.length - 1) { scnStop(); renderScenario(); return; }
    switchState(cur + 1);
  }, 1100);
}
function scnNext() { scnStop(); if (cur < states.length - 1) switchState(cur + 1); }
function scnPrev() { scnStop(); if (cur > 0) switchState(cur - 1); }
// Render the A → B strip + state list into the left panel (#scenario).
function renderScenario() {
  const el = $("scenario");
  if (!el) return;
  const n = states.length, last = n - 1, playing = !!scnTimer;
  const tagOf = (i: any) => i === 0 ? "A" : i === last ? "B" : `${i + 1}`;
  // readout: "A — As-built" · "Step 2 of 5 · Widen kitchen door" · "B — Proposed"
  let readout = "—";
  if (states[cur]) {
    readout = cur === 0 ? `<b>A</b> — ${esc(states[0].label)}`
      : cur === last ? `<b>B</b> — ${esc(states[cur].label)}`
      : `<b>Step ${cur + 1}</b> of ${n} · ${esc(states[cur].label)}`;
  }
  const chip = (i: any) =>
    `<div class="scn-chip ${i === cur ? "on" : ""}" data-i="${i}" title="double-click to rename">` +
    `<span class="scn-tag">${tagOf(i)}</span><span class="scn-lbl">${esc(states[i].label)}</span>` +
    (n > 1 ? `<span class="scn-del" data-del="${i}" title="remove state">✕</span>` : "") + `</div>`;
  el.innerHTML =
    `<div id="scn-readout" class="scn-readout">${readout}</div>` +
    `<div class="scn-track">${states.map((_, i) => chip(i)).join("")}</div>` +
    `<div class="scn-controls">` +
      `<button id="scn-prev" class="scn-btn" ${cur <= 0 ? "disabled" : ""}>◀ Prev</button>` +
      `<button id="scn-play" class="scn-btn primary" ${n < 2 ? "disabled" : ""}>${playing ? "❚❚ Pause" : "▶ Play"}</button>` +
      `<button id="scn-next" class="scn-btn" ${cur >= last ? "disabled" : ""}>Next ▶</button>` +
    `</div>` +
    `<div class="scn-controls">` +
      `<button id="scn-add" class="scn-btn">＋ Add step after this</button>` +
    `</div>` +
    `<label class="scn-sync ${syncSteps ? "on" : ""}" title="Apply each edit to the same object in every other step (where it's consistent)">` +
      `<input type="checkbox" id="scn-sync" ${syncSteps ? "checked" : ""}/>` +
      `<span>🔗 Sync edits across steps</span></label>` +
    `<div class="scn-help">Select any state to edit it — each keeps its own undo history. “Add step” forks the current model into a new editable state (the last is <b>B</b>).` +
      (syncSteps
        ? ` <b>Sync is on:</b> moving, resizing, retyping, recoloring, adding or removing a shared object applies to every step where that object is consistent (matching wall, furniture type, stair, etc.). Diverged steps are left untouched.`
        : ``) + `</div>`;
  // wiring
  // Inline rename (§5.4): double-clicking a chip swaps its label span for an
  // <input> (commit on Enter/blur, Escape cancels). No prompt().
  function beginRename(chip: any, i: any) {
    const lblSpan = chip.querySelector(".scn-lbl"); if (!lblSpan) return;
    const inp = document.createElement("input");
    inp.className = "scn-rename"; inp.value = states[i] ? states[i].label : "";
    lblSpan.replaceWith(inp); inp.focus(); inp.select();
    let done = false;
    const finish = (commit: any) => {
      if (done) return; done = true;
      if (commit) scnRename(i, inp.value);   // scnRename re-renders; ignores blanks
      else renderScenario();                 // cancel → repaint original
    };
    inp.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    };
    inp.onblur = () => finish(true);
    inp.onclick = (ev) => ev.stopPropagation();   // don't switchState while editing
  }
  el.querySelectorAll(".scn-chip").forEach((d: any) => {
    d.onclick = (e: any) => { if (e.target.dataset.del !== undefined) return; if (e.target.classList.contains("scn-rename")) return; switchState(+d.dataset.i); };
    d.ondblclick = (e: any) => { e.preventDefault(); beginRename(d, +d.dataset.i); };
  });
  // Two-click delete confirm (§5.4): first click turns ✕ into "Sure?" for 2.5s.
  el.querySelectorAll(".scn-del").forEach((d: any) => {
    let armed = false, t: any = null;
    d.onclick = (e: any) => {
      e.stopPropagation();
      const i = +d.dataset.del;
      if (!armed) {
        armed = true; d.textContent = "Sure?"; d.classList.add("arm");
        t = setTimeout(() => { armed = false; d.textContent = "✕"; d.classList.remove("arm"); }, 2500);
        return;
      }
      if (t) clearTimeout(t);
      scnRemoveStep(i);   // re-renders
    };
  });
  $("scn-prev").onclick = scnPrev;
  $("scn-next").onclick = scnNext;
  $("scn-play").onclick = scnPlay;
  // Add step with a default name (no prompt); rename inline afterward.
  $("scn-add").onclick = () => scnAddStep("");
  const sync = $("scn-sync");
  if (sync) sync.onchange = (e: any) => { syncSteps = e.target.checked; saveState(); renderScenario(); };
}
const esc = (s: any) => String(s).replace(/[&<>"]/g, (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c]));

const WALL_COLOR = "#ede9e1";
const MID_Z = LEVEL_Z[1] / 2;
const statusEl = $("status");
const setStatus = (text: any, pct?: any) => {
  if (!text) { statusEl.style.display = "none"; return; }
  statusEl.style.display = "block";
  statusEl.innerHTML = `<div>${text}</div><div class="bar"><i style="width:${pct ?? 30}%"></i></div>`;
};
const fail = (m: any) => { statusEl.style.display = "block"; statusEl.innerHTML = `<div id="err"><b>Error.</b><br>${m}</div>`; };

// ---- realtime FLOOR geometry: one slab per ENCLOSED FACE of the wall graph ----
// floorFaces() returns every wall-bounded region (planar arrangement), so no
// enclosed area is ever missing a floor and floors always match the walls.
// Each face is tinted by the smallest original room that contains its centroid.
const roomPoly = (r: any) => r.poly || [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.d], [r.x, r.y + r.d]];
const polyArea = (p: any) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s / 2); };
const inPoly = (pt: any, p: any) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const a = p[i], b = p[j]; if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / ((b[1] - a[1]) || 1e-9) + a[0]) c = !c; } return c; };
const polyCentroid = (p: any) => {
  let x = 0, y = 0, a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length], f = q[0] * r[1] - r[0] * q[1]; x += (q[0] + r[0]) * f; y += (q[1] + r[1]) * f; a += f; }
  if (Math.abs(a) < 1e-6) return [p.reduce((s: any, q: any) => s + q[0], 0) / p.length, p.reduce((s: any, q: any) => s + q[1], 0) / p.length];
  return [x / (3 * a), y / (3 * a)];
};
function faceColor(poly: any, level: any) {
  const c = polyCentroid(poly); let best = "#cfcfd2", bestA = Infinity;
  for (const r of rooms) {
    if (r.level !== level) continue;
    const rp = roomPoly(r);
    if (inPoly(c, rp)) { const a = polyArea(rp); if (a < bestA) { bestA = a; best = r.color; } }
  }
  return best;
}
function floorSlab(parts: any, poly2: any, color: any, z: any, holes: any[] = []) {
  if (poly2.length < 3) return;
  const c = new THREE.Color(color);
  const shape = new THREE.Shape(poly2.map((p: any) => new THREE.Vector2(p[0], p[1])));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map((p: any) => new THREE.Vector2(p[0], p[1]))));
  const g = new THREE.ShapeGeometry(shape);
  g.translate(0, 0, z);
  const n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) { col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b; }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  parts.push(g);
}

// ---- stairwell cuts: a stair carves holes in the walls AND floors it passes ----
// through. Detection is in the REAL (stacked) frame — floors spaced wallH + SLAB
// apart, independent of the exploded view — so a stair on level L spans
// [floor(L) - down, floor(L) + up]. A wall band on level `lvl` is
// [floor(lvl), floor(lvl) + wallH]; a floor slab sits at floor(lvl). Where the
// stair's span overlaps a wall band (and its footprint crosses the wall) we cut
// that height range out; where a floor slab lies strictly within the span we punch
// the footprint through it (so a stair drops down through, and climbs up into, the
// levels it reaches). Footprints are inset so the shaft's own perimeter walls stay.
const STAIR_INSET = 0.5;       // keep walls coincident with the footprint edge (the shaft) intact
const realFloorZ = (level: any) => level * (wallH + CONST.SLAB);
const stairInsetRect = (s: any) => ({ x0: s.x + STAIR_INSET, y0: s.y + STAIR_INSET, x1: s.x + s.w - STAIR_INSET, y1: s.y + s.d - STAIR_INSET });
// Liang–Barsky: parameter span [t0,t1] of segment a→b clipped to an axis rect, or null.
function segRectSpan(ax: any, ay: any, bx: any, by: any, x0: any, y0: any, x1: any, y1: any) {
  const dx = bx - ax, dy = by - ay; let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
    if (Math.abs(p) < 1e-9) { if (q < 0) return null; continue; }   // parallel & outside
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return t1 - t0 > 1e-3 ? [t0, t1] : null;
}
// remove cut intervals (each [s,e]) from a list of spans
function subtractSpans(spans: any, cuts: any) {
  if (!cuts.length) return spans;
  let out = spans;
  for (const [cs, ce] of cuts) {
    const next = [];
    for (const [s, e] of out) {
      if (ce <= s || cs >= e) { next.push([s, e]); continue; }
      if (cs > s) next.push([s, cs]);
      if (ce < e) next.push([ce, e]);
    }
    out = next;
  }
  return out.filter(([s, e]: number[]) => e - s > 1e-3);
}
// Per-wall stairwell cuts on a level: Map wallIndex -> [{ s, e, h0, h1 }] (the
// param span the stair crosses + the local height band to remove, 0..wallH).
function stairWallCuts(level: any) {
  const byWall = new Map();
  const wb0 = realFloorZ(level), wb1 = wb0 + wallH;
  for (const s of stairs) {
    const sf = realFloorZ(s.level);
    const cb = Math.max(sf - (s.down ?? 0), wb0), ct = Math.min(sf + (s.up ?? 0), wb1);
    if (ct - cb < 0.1) continue;                         // stair span misses this level's walls
    const h0 = cb - wb0, h1 = ct - wb0, r = stairInsetRect(s);
    if (r.x1 - r.x0 < 0.05 || r.y1 - r.y0 < 0.05) continue;
    graph.walls.forEach((w, wi) => {
      if (w.level !== level) return;
      const a = graph.nodes[w.a], b = graph.nodes[w.b]; if (!a || !b) return;
      const span = segRectSpan(a.x, a.y, b.x, b.y, r.x0, r.y0, r.x1, r.y1);
      if (span) (byWall.get(wi) || byWall.set(wi, []).get(wi)).push({ s: span[0], e: span[1], h0, h1 });
    });
  }
  return byWall;
}
// Holes to punch in a level's FLOOR slab: every stair whose vertical span passes
// through this floor (strictly above its base, at or below its top). The opening
// clears the stair's WHOLE footprint plus headroom at the top (stairFloorOpening),
// so a person can walk the full flight — not just the slice where it intersects.
// Each hole carries its footprint centroid `fc`, so it's only applied to a slab the
// stair actually sits over — an exterior stair meeting a threshold (its footprint
// outside the building) won't punch the floor its headroom extension reaches into.
function stairFloorHoles(level: any) {
  const z = realFloorZ(level), holes = [];
  for (const s of stairs) {
    const sf = realFloorZ(s.level), top = sf + (s.up ?? 0), base = sf - (s.down ?? 0);
    if (z > base + 0.05 && z <= top + 0.01) {
      const r = stairFloorOpening(s);
      if (r.x1 - r.x0 > 0.05 && r.y1 - r.y0 > 0.05)
        holes.push({ ring: [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]], fc: [s.x! + s.w! / 2, s.y! + s.d! / 2] });
    }
  }
  return holes;
}
// Two edit-following layers so NO enclosed area is ever unfloored:
//   • base  = each room's node loop  (fills every room, incl. thin slivers)
//   • top   = the wall-enclosed faces (match walls exactly; cover non-room regions)
function buildFloorGeo(level: any) {
  const parts: any = [];
  const holes = stairFloorHoles(level);                  // stairwell openings through this floor
  // apply a hole only to the slab the stair actually sits over (footprint centroid)
  const holesIn = (poly: any) => holes.filter((h) => inPoly(h.fc, poly)).map((h) => h.ring);
  rooms.forEach((r, i) => {
    if (r.level !== level) return;
    const pts = (roomLoops[i] || []).map((ni) => graph.nodes[ni]).filter(Boolean).map((p) => [p.x, p.y]);
    floorSlab(parts, pts, r.color, LEVEL_Z[level] - 0.10, holesIn(pts));
  });
  for (const f of floorFaces(graph, level)) floorSlab(parts, f.poly, faceColor(f.poly, level), LEVEL_Z[level] - 0.06, holesIn(f.poly));
  const merged = parts.length ? mergeGeometries(parts, false) : new THREE.BufferGeometry();
  parts.forEach((g: any) => g.dispose());
  return merged;
}

// ---- realtime wall geometry, straight from the wall graph + doors/windows ----
// solid spans of a wall (0..1) after removing the supplied openings
function solidSpans(wallIndex: any, len: any, openings = doors.concat(windows)) {
  let spans = [[0, 1]];
  for (const d of openings) {
    if (d.wall !== wallIndex) continue;
    const h = (d.w / 2) / len, ds = Math.max(0, d.t - h), de = Math.min(1, d.t + h);
    const next = [];
    for (const [s, e] of spans) {
      if (de <= s || ds >= e) { next.push([s, e]); continue; }
      if (ds > s) next.push([s, ds]);
      if (de < e) next.push([de, e]);
    }
    spans = next;
  }
  return spans.filter(([s, e]) => e - s > 1e-3);
}

// a box across an opening (sill/header), oriented to the wall
function bandBox(parts: any, w: any, t: any, ww: any, level: any, z0: any, z1: any) {
  const a = graph.nodes[w.a], b = graph.nodes[w.b];
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1e-6;
  const cx = a.x + dx * t, cy = a.y + dy * t, ang = Math.atan2(dy, dx);
  const g = new THREE.BoxGeometry(ww, WALL_T, z1 - z0);
  g.applyMatrix4(new THREE.Matrix4().makeRotationZ(ang).setPosition(cx, cy, LEVEL_Z[level] + (z0 + z1) / 2));
  parts.push(g);
}

// push a box of (len along wall × WALL_T across × height) centered at (cx,cy,cz),
// rotated so its length runs along the wall direction `ang`.
function pushWallBox(parts: any, len: any, height: any, cx: any, cy: any, cz: any, ang: any) {
  const g = new THREE.BoxGeometry(len, WALL_T, height);
  g.applyMatrix4(new THREE.Matrix4().makeRotationZ(ang).setPosition(cx, cy, cz));
  parts.push(g);
}

// stud-framing version of a wall span: bottom + top plates with evenly-spaced
// vertical studs between them (instead of one solid panel).
function framingSpan(parts: any, sx: any, sy: any, ex: any, ey: any, ang: any, level: any, segLen: any) {
  const z0 = LEVEL_Z[level];
  const ux = Math.cos(ang), uy = Math.sin(ang);
  const mx = (sx + ex) / 2, my = (sy + ey) / 2;
  pushWallBox(parts, segLen, FRAME_PLATE, mx, my, z0 + FRAME_PLATE / 2, ang);          // bottom plate
  pushWallBox(parts, segLen, FRAME_PLATE, mx, my, z0 + wallH - FRAME_PLATE / 2, ang);  // top plate
  const studH = Math.max(0.1, wallH - 2 * FRAME_PLATE), zc = z0 + FRAME_PLATE + studH / 2;
  const n = Math.max(1, Math.round(segLen / FRAME_SPACING));                           // studs at both ends + on-center
  for (let i = 0; i <= n; i++) {
    const d = Math.max(FRAME_STUD / 2, Math.min(segLen - FRAME_STUD / 2, (segLen * i) / n));
    pushWallBox(parts, FRAME_STUD, studH, sx + ux * d, sy + uy * d, zc, ang);
  }
}

function buildWallGeo(level: any) {
  const parts: any = [];
  const wallCuts = stairWallCuts(level);                 // stairwell openings cut into walls
  graph.walls.forEach((w, wi) => {
    if (w.level !== level) return;
    const a = graph.nodes[w.a], b = graph.nodes[w.b];
    if (!a || !b) return;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1e-6;
    const ux = dx / len, uy = dy / len, ang = Math.atan2(dy, dx);
    const addSpan = (s: any, e: any, height: any, cz: any) => {
      const capS = s <= 1e-6 ? WALL_T / 2 : 0, capE = e >= 1 - 1e-6 ? WALL_T / 2 : 0;  // overlap joints at nodes only
      const sx = a.x + dx * s - ux * capS, sy = a.y + dy * s - uy * capS;
      const ex = a.x + dx * e + ux * capE, ey = a.y + dy * e + uy * capE;
      const segLen = Math.hypot(ex - sx, ey - sy);
      if (framingMode && Math.abs(height - wallH) < 1e-6) { framingSpan(parts, sx, sy, ex, ey, ang, level, segLen); return; }
      pushWallBox(parts, segLen, height, (sx + ex) / 2, (sy + ey) / 2, cz, ang);
    };
    // a stairwell removes a height band [h0,h1] over its span: drop those spans
    // from the normal build, then add back the wall kept below/above the opening.
    const cuts = wallCuts.get(wi) || [];
    const cutSpans = cuts.map((c: any) => [c.s, c.e]);
    const mc = (spans: any) => subtractSpans(spans, cutSpans);
    const remnants = () => {
      for (const c of cuts) {
        if (c.h0 > 0.02) addSpan(c.s, c.e, c.h0, LEVEL_Z[level] + c.h0 / 2);                       // below the opening
        if (c.h1 < wallH - 0.02) addSpan(c.s, c.e, wallH - c.h1, LEVEL_Z[level] + (c.h1 + wallH) / 2); // above it
      }
    };
    const top = doorTop();
    const upperZ0 = Math.max(0, top - DOOR_HEADER_LAP);
    // Door leaves are capped at a standard height (≤6.8 ft), but the opening is
    // cut to `top` (= doorTop). On tall walls (wallH>8) those diverge, leaving a
    // gap over a shut door. Fill the wall from the leaf top up to `top` over each
    // door span so the opening seals around the leaf (windows handle this via
    // their own sill/header bands). Slight overlap below the leaf hides the seam.
    const doorClearH = Math.min(top, 6.8);
    const fillDoorHeaders = () => {
      if (doorClearH >= top - 1e-3) return;
      const z0f = Math.max(0, doorClearH - DOOR_HEADER_LAP);
      for (const d of doors) {
        if (d.wall !== wi) continue;
        const h = (d.w / 2) / len, ds = Math.max(0, d.t - h), de = Math.min(1, d.t + h);
        for (const [s, e] of subtractSpans([[ds, de]], cutSpans)) {
          addSpan(s, e, top - z0f, LEVEL_Z[level] + (z0f + top) / 2);
        }
      }
    };
    if (framingMode) {
      for (const [s, e] of mc(solidSpans(wi, len, doors.concat(windows)))) {
        addSpan(s, e, wallH, LEVEL_Z[level] + wallH / 2);
      }
      if (upperZ0 < wallH - 0.01) {
        for (const [s, e] of mc(solidSpans(wi, len, windows))) {
          addSpan(s, e, wallH - upperZ0, LEVEL_Z[level] + (upperZ0 + wallH) / 2);
        }
      }
      fillDoorHeaders();
      remnants();
      return;
    }
    for (const [s, e] of mc(solidSpans(wi, len, doors.concat(windows)))) {
      addSpan(s, e, top, LEVEL_Z[level] + top / 2);
    }
    if (upperZ0 < wallH - 0.01) {
      for (const [s, e] of mc(solidSpans(wi, len, windows))) {
        addSpan(s, e, wallH - upperZ0, LEVEL_Z[level] + (upperZ0 + wallH) / 2);
      }
    }
    fillDoorHeaders();
    remnants();
  });
  // windows keep a sill below + header above the glass
  for (const win of windows) {
    const w = graph.walls[win.wall]; if (!w || w.level !== level || !graph.nodes[w.a] || !graph.nodes[w.b]) continue;
    const { z0, z1 } = winBand(win);
    if (z0 > 0.01) bandBox(parts, w, win.t, win.w, level, 0, z0);                // sill
    if (z1 < wallH - 0.01) bandBox(parts, w, win.t, win.w, level, z1, wallH);    // header
  }
  // door casing trim (Phase 3): when door.casing, surround the opening on both
  // wall faces. casingParts gives WALL-LOCAL boxes (x along wall centered on the
  // opening, y across, z up); orient them by the wall angle into the wall mesh.
  const doorH = Math.min(doorTop(), 6.8);
  for (const d of doors) {
    if (!d.casing) continue;
    const w = graph.walls[d.wall]; if (!w || w.level !== level || !graph.nodes[w.a] || !graph.nodes[w.b]) continue;
    const a = graph.nodes[w.a], b = graph.nodes[w.b];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1e-6;
    const ang = Math.atan2(dy, dx);
    const cx = a.x + dx * d.t, cy = a.y + dy * d.t;    // opening center on the wall
    const m = new THREE.Matrix4().makeRotationZ(ang).setPosition(cx, cy, LEVEL_Z[level]);
    for (const cb of casingParts(d.w, doorH, WALL_T)) {
      const sx = cb.x1 - cb.x0, sy = cb.y1 - cb.y0, sz = cb.z1 - cb.z0;
      if (sx <= 1e-4 || sy <= 1e-4 || sz <= 1e-4) continue;
      const g = new THREE.BoxGeometry(sx, sy, sz);
      g.translate((cb.x0 + cb.x1) / 2, (cb.y0 + cb.y1) / 2, (cb.z0 + cb.z1) / 2);   // wall-local center
      g.applyMatrix4(m);
      parts.push(g);
    }
  }
  const merged = parts.length ? mergeGeometries(parts, false) : new THREE.BufferGeometry();
  parts.forEach((g: any) => g.dispose());
  return merged;
}

// glass panes filling each window's opening (translucent)
function buildGlassGeo(level: any) {
  const parts = [];
  for (const win of windows) {
    const w = graph.walls[win.wall]; if (!w || w.level !== level || !graph.nodes[w.a] || !graph.nodes[w.b]) continue;
    const { z0, z1 } = winBand(win); if (z1 - z0 < 0.05) continue;
    const a = graph.nodes[w.a], b = graph.nodes[w.b];
    const dx = b.x - a.x, dy = b.y - a.y, ang = Math.atan2(dy, dx);
    const cx = a.x + dx * win.t, cy = a.y + dy * win.t;
    const g = new THREE.BoxGeometry(win.w, 0.1, z1 - z0);
    g.applyMatrix4(new THREE.Matrix4().makeRotationZ(ang).setPosition(cx, cy, LEVEL_Z[level] + (z0 + z1) / 2));
    parts.push(g);
  }
  const merged = parts.length ? mergeGeometries(parts, false) : new THREE.BufferGeometry();
  parts.forEach((g) => g.dispose());
  return merged;
}

// ---- realtime ROOF geometry --------------------------------------------
// The roof is a flat slab on top of the MAIN walls (z = LEVEL_Z[1] + wallH).
// It is tiled from the wall-enclosed faces (floorFaces) of the main level so it
// is SEAMLESS (faces share wall centerlines — no gaps). Two kinds of opening:
//   • cut      — the whole face is open to the sky (e.g. the central patio).
//   • skylight — a hole punched in the slab + a translucent pane.
// Even when the roof material is invisible, this mesh stays in the scene with
// castShadow=true, so the main level is lit through every opening.
const roofZBottom = () => LEVEL_Z[1] + wallH;
const signedArea = (p: any) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
const rectPoly = (x: any, y: any, w: any, d: any) => { const hw = w / 2, hd = d / 2; return [[x - hw, y - hd], [x + hw, y - hd], [x + hw, y + hd], [x - hw, y + hd]]; };
// unify cuts + skylights into { poly, kind, area }
function roofOpenings() {
  const out = [];
  for (const c of roofCuts) out.push({ kind: "cut", poly: c.poly || rectPoly(c.x, c.y, c.w, c.d) });
  for (const s of skylights) out.push({ kind: "sky", poly: rectPoly(s.x, s.y, s.w, s.d) });
  return out;
}
function buildRoofGeo() {
  const parts = [], z0 = roofZBottom(), ops = roofOpenings();
  for (const f of floorFaces(graph, 1)) {
    let outline = f.poly;
    const fArea = polyArea(outline);
    // openings centered in this face punch holes; cuts AND skylights both cut the
    // slab (skylights additionally get glass, built separately).
    const here = ops.filter((o) => inPoly(polyCentroid(o.poly), outline));
    // a single opening that covers ~the whole face leaves it fully open (the
    // central patio): skip the face rather than punch a degenerate same-size hole.
    if (here.some((o) => polyArea(o.poly) >= 0.85 * fArea)) continue;
    if (signedArea(outline) < 0) outline = [...outline].reverse();   // shape outline CCW
    const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p[0], p[1])));
    for (const h of here) {
      let hp = h.poly;
      if (signedArea(hp) > 0) hp = [...hp].reverse();                // hole CW (opposite outline)
      shape.holes.push(new THREE.Path(hp.map((p) => new THREE.Vector2(p[0], p[1]))));
    }
    const g = new THREE.ExtrudeGeometry(shape, { depth: roofThickness, bevelEnabled: false });
    g.translate(0, 0, z0);
    parts.push(g);
  }
  const merged = parts.length ? mergeGeometries(parts, false) : new THREE.BufferGeometry();
  parts.forEach((g) => g.dispose());
  return merged;
}
// translucent panes filling each skylight opening
function buildRoofGlass() {
  const parts = [], zc = roofZBottom() + roofThickness / 2;
  for (const s of skylights) {
    const g = new THREE.BoxGeometry(s.w, s.d, Math.max(0.06, roofThickness * 0.5));
    g.translate(s.x, s.y, zc);
    parts.push(g);
  }
  const merged = parts.length ? mergeGeometries(parts, false) : new THREE.BufferGeometry();
  parts.forEach((g) => g.dispose());
  return merged;
}

// ---- realtime STAIR geometry -------------------------------------------
// Each stair is a solid stepped block (treads rising to the served floor). They
// live in their level's group, so they ride the stack offset / floor filter and
// use the same absolute Z as that level's walls. See walls.js stairSteps().
function buildStairsGeo(level: any) {
  const parts = [];
  for (const s of stairs) {
    if (s.level !== level) continue;
    for (const st of stairSteps(s, LEVEL_Z[level])) {
      const h = st.z1 - st.z0;
      if (st.l <= 1e-4 || st.w <= 1e-4 || h <= 1e-4) continue;
      const g = new THREE.BoxGeometry(st.l, st.w, h);   // oriented: l along the flight, w across
      g.translate(0, 0, h / 2);
      if (Math.abs(st.ang) > 1e-6) g.rotateZ(st.ang);
      g.translate(st.cx, st.cy, st.z0);
      parts.push(g);
    }
  }
  const merged = parts.length ? mergeGeometries(parts, false) : new THREE.BufferGeometry();
  parts.forEach((g) => g.dispose());
  return merged;
}

// ---- realtime FURNITURE geometry ---------------------------------------
// Each piece is a set of colored boxes (furnitureParts, shared with the SCAD
// export). Boxes carry per-vertex color so cabinets/counters/cushions read in a
// single merged mesh (like the floor slabs). Pieces live in their level group, so
// they ride the stack offset + floor filter; their local Z is measured from the
// level floor (LEVEL_Z[level]).
function buildFurnitureGeo(level: any) {
  const parts = [];
  for (const f of furniture) {
    if (f.level !== level) continue;
    for (const p of furnitureParts(f)) {
      if (p.sx <= 1e-4 || p.sy <= 1e-4 || p.sz <= 1e-4) continue;
      const g = new THREE.BoxGeometry(p.sx, p.sy, p.sz);
      g.translate(p.cx, p.cy, LEVEL_Z[level] + p.cz);
      const c = new THREE.Color(p.color), n = g.attributes.position.count, col = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) { col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b; }
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      parts.push(g);
    }
  }
  const merged = parts.length ? mergeGeometries(parts, false) : new THREE.BufferGeometry();
  parts.forEach((g) => g.dispose());
  return merged;
}

// ---- realtime CABINET geometry (Phase 5) -------------------------------
// Each cabinet is a set of colored boxes (cabinetParts, shared with the SCAD
// export). Boxes carry per-vertex color so carcass/fronts/pulls/counter read in a
// single merged mesh. Cabinets live in their level group, so they ride the stack
// offset + floor filter; their local Z is measured from the level floor (the
// mount offset is already baked into cabinetParts' z).
function buildCabinetGeo(level: any) {
  const parts = [];
  for (const c of cabinets) {
    if (c.level !== level) continue;
    for (const p of cabinetParts(c)) {
      if (p.sx <= 1e-4 || p.sy <= 1e-4 || p.sz <= 1e-4) continue;
      const g = new THREE.BoxGeometry(p.sx, p.sy, p.sz);
      g.translate(p.cx, p.cy, LEVEL_Z[level] + p.cz);
      const col2 = new THREE.Color(p.color), n = g.attributes.position.count, col = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) { col[k * 3] = col2.r; col[k * 3 + 1] = col2.g; col[k * 3 + 2] = col2.b; }
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      parts.push(g);
    }
  }
  const merged = parts.length ? mergeGeometries(parts, false) : new THREE.BufferGeometry();
  parts.forEach((g) => g.dispose());
  return merged;
}

// ---- realtime MOULDING geometry (Phase 4) ------------------------------
// Each moulding paints a room's interior perimeter with a stacked profile. The
// runs (mouldingRuns) are world-XY segments displaced inward and split at the
// openings this kind cares about; mouldingRunParts gives the profile's sub-boxes
// in the RUN-LOCAL frame (x along run, y across centered, z 0..h). We rotate each
// box by the run angle and lift it to the kind's base Z (mouldingZ). Crown reads
// the LIVE wallH (so it rides the wall-height slider). A moulding whose room no
// longer resolves is skipped silently (guards wall edits that drop a room/loop).
function buildMouldingGeo(level: any) {
  const parts = [];
  for (const m of mouldings) {
    const r = rooms[m.room];
    if (!r || r.level !== level) continue;             // skip unresolved / off-level
    if (!roomLoops[m.room] || roomLoops[m.room].length < 3) continue;
    const zBase = LEVEL_Z[level] + mouldingZ(m, wallH);
    const color = m.color || mldColor;
    const c = new THREE.Color(color);
    for (const run of mouldingRuns(graph, roomLoops, doors, windows, m, wallH)) {
      const dx = run.bx - run.ax, dy = run.by - run.ay, len = Math.hypot(dx, dy);
      if (len < 1e-3) continue;
      const ang = Math.atan2(dy, dx);
      const cosA = Math.cos(ang), sinA = Math.sin(ang);
      for (const b of mouldingRunParts(m.profile || "square", m.kind, len, m.h ?? 0.3, m.d ?? 0.06, color)) {
        const sx = b.x1 - b.x0, sy = b.y1 - b.y0, sz = b.z1 - b.z0;
        if (sx <= 1e-4 || sy <= 1e-4 || sz <= 1e-4) continue;
        const g = new THREE.BoxGeometry(sx, sy, sz);
        const lcx = (b.x0 + b.x1) / 2, lcy = (b.y0 + b.y1) / 2, lcz = (b.z0 + b.z1) / 2;
        // run-local (lcx along run, lcy across) → world: rotate by ang, offset to run start.
        g.applyMatrix4(new THREE.Matrix4().makeRotationZ(ang).setPosition(
          run.ax + cosA * lcx - sinA * lcy,
          run.ay + sinA * lcx + cosA * lcy,
          zBase + lcz));
        const n = g.attributes.position.count, col = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) { col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b; }
        g.setAttribute("color", new THREE.BufferAttribute(col, 3));
        parts.push(g);
      }
    }
  }
  const merged = parts.length ? mergeGeometries(parts, false) : new THREE.BufferGeometry();
  parts.forEach((g) => g.dispose());
  return merged;
}

// ---- Door v2 leaf placement (Phase 3) --------------------------------------
// For each door, doorLeaves(style, w) gives the leaf descriptors; for each leaf
// we resolve a HINGE point on its jamb + an open ANGLE, then transform each
// doorLeafParts box (LEAF-LOCAL: x along leaf from hinge, y thickness, z up) by
// makeRotationZ(ang).setPosition(hinge). The leaf color is per-vertex; glass
// boxes go to the separate <lvl>-doorglass mesh (window glass material).
//
// The second leaf of a pair hinges at the OPPOSITE jamb and swings mirrored —
// derived from doorFrame's frame data the same way Flip hinge works: the leaf's
// base direction points along the opening from its hinge, and its swing sign
// couples to which jamb it's on (so both leaves swing into the SAME room).
function doorLeafPlacements(d: any) {
  const wl = graph.walls[d.wall], a = graph.nodes[wl.a], b = graph.nodes[wl.b];
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1e-6;
  const cx = a.x + dx * d.t, cy = a.y + dy * d.t;       // opening center on the wall
  const wallDeg = Math.atan2(dy, dx) * 180 / Math.PI;
  const open = doorOpenDeg * Math.PI / 180;
  // doorLeafFrames is the SHARED placement math (also used by the SCAD export), so
  // the viewer and export swing identically. Returns hinge + base angle (deg) +
  // swing sign per leaf; the rendered angle = base + sign*DOOR_OPEN. Sliding
  // frames (mode "slide") never rotate: the leaf translates along its base axis
  // by slideSign * leafW * (DOOR_OPEN/110) — the swing slider doubles as slide.
  const frac = Math.max(0, Math.min(1, doorOpenDeg / 110));
  return doorLeafFrames(d.style || "slab", cx, cy, d.w, wallDeg, d.side ?? 1, d.hand ?? 1).map((fr) => {
    const base = fr.baseDeg * Math.PI / 180;
    if (fr.mode === "slide") {
      const s = (fr.slideSign || 0) * fr.w * frac;
      return { hinge: { x: fr.hx + Math.cos(base) * s, y: fr.hy + Math.sin(base) * s },
               h0: { x: fr.hx, y: fr.hy },              // closed position (track drawing)
               base, ang: base, w: fr.w, leaf: fr.leaf, style: d.style || "slab",
               mode: "slide", slideSign: fr.slideSign || 0 };
    }
    return {
      hinge: { x: fr.hx, y: fr.hy },
      base,                                             // closed angle (along the opening)
      ang: base + fr.swingSign * open,                  // open angle
      w: fr.w, leaf: fr.leaf, style: d.style || "slab", mode: "swing",
    };
  });
}

// Transform a LEAF-LOCAL box (x along leaf, y across, z up) into a positioned
// BoxGeometry at hinge, rotated by `ang` about Z, lifted to absolute z `baseZ`.
function leafBoxGeo(b: any, hinge: any, ang: any, baseZ: any) {
  const sx = b.x1 - b.x0, sy = b.y1 - b.y0, sz = b.z1 - b.z0;
  if (sx <= 1e-4 || sy <= 1e-4 || sz <= 1e-4) return null;
  const g = new THREE.BoxGeometry(sx, sy, sz);
  const lcx = (b.x0 + b.x1) / 2, lcy = (b.y0 + b.y1) / 2, lcz = (b.z0 + b.z1) / 2;
  // place at leaf-local center, then rotate+translate to the hinge
  g.applyMatrix4(new THREE.Matrix4().makeRotationZ(ang).setPosition(
    hinge.x + Math.cos(ang) * lcx - Math.sin(ang) * lcy,
    hinge.y + Math.sin(ang) * lcx + Math.cos(ang) * lcy,
    baseZ + lcz));
  return g;
}
function paintGeo(g: any, color: any) {
  const c = new THREE.Color(color), n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) { col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b; }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
}

// Door leaves (thin styled panels swung open) for a level, as one merged
// geometry with per-vertex leaf color. Glass goes to buildDoorGlass.
function buildDoorLeaves(level: any) {
  const H = Math.min(doorTop(), 6.8), parts = [], baseZ = LEVEL_Z[level];
  for (const d of doors) {
    const wl = graph.walls[d.wall]; if (!wl || wl.level !== level || !graph.nodes[wl.a] || !graph.nodes[wl.b]) continue;
    const color = d.color || "#8a5a3c";
    for (const pl of doorLeafPlacements(d)) {
      const { solids } = doorLeafParts(pl.style, pl.w, H, color);
      for (const b of solids) {
        const g = leafBoxGeo(b, pl.hinge, pl.ang, baseZ);
        if (!g) continue;
        paintGeo(g, b.color || color);
        parts.push(g);
      }
    }
  }
  const merged = parts.length ? mergeGeometries(parts, false) : new THREE.BufferGeometry();
  parts.forEach((g) => g.dispose());
  return merged;
}

// Door glass lites (glazed/french styles) for a level — window glass material.
function buildDoorGlass(level: any) {
  const H = Math.min(doorTop(), 6.8), parts = [], baseZ = LEVEL_Z[level];
  for (const d of doors) {
    const wl = graph.walls[d.wall]; if (!wl || wl.level !== level || !graph.nodes[wl.a] || !graph.nodes[wl.b]) continue;
    for (const pl of doorLeafPlacements(d)) {
      const { glass } = doorLeafParts(pl.style, pl.w, H, d.color || "#8a5a3c");
      for (const b of glass) {
        const g = leafBoxGeo(b, pl.hinge, pl.ang, baseZ);
        if (g) parts.push(g);
      }
    }
  }
  const merged = parts.length ? mergeGeometries(parts, false) : new THREE.BufferGeometry();
  parts.forEach((g) => g.dispose());
  return merged;
}

// Swing arcs (quarter-circle, on the floor) for a level, as line segments — one
// arc per LEAF (a pair draws two mirrored arcs), from the leaf's closed position
// to its open angle, at radius = leaf width.
function buildDoorArcs(level: any) {
  const pts = [], z = LEVEL_Z[level] + 0.06, N = 10;
  if (Math.abs(doorOpenDeg) < 2) return new THREE.BufferGeometry();   // shut: no swing arc
  for (const d of doors) {
    const wl = graph.walls[d.wall]; if (!wl || wl.level !== level || !graph.nodes[wl.a] || !graph.nodes[wl.b]) continue;
    // one arc per leaf, swept from its closed base to its open angle (radius = w).
    // Sliding leaves get a straight TRACK line over their full travel instead
    // (fixed patio panels draw nothing).
    for (const pl of doorLeafPlacements(d)) {
      if (pl.mode === "slide") {
        if (!pl.slideSign) continue;
        const ux = Math.cos(pl.base), uy = Math.sin(pl.base);
        const s0 = Math.min(0, pl.slideSign * pl.w), s1 = Math.max(pl.w, pl.w + pl.slideSign * pl.w);
        pts.push(new THREE.Vector3(pl.h0.x + ux * s0, pl.h0.y + uy * s0, z),
                 new THREE.Vector3(pl.h0.x + ux * s1, pl.h0.y + uy * s1, z));
        continue;
      }
      let prev = null;
      for (let i = 0; i <= N; i++) {
        const ang = pl.base + (pl.ang - pl.base) * (i / N);
        const p = new THREE.Vector3(pl.hinge.x + Math.cos(ang) * pl.w, pl.hinge.y + Math.sin(ang) * pl.w, z);
        if (prev) pts.push(prev, p);
        prev = p;
      }
    }
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

// swap in freshly-built floor + wall + door geometry (cheap; called live)
function rebuildWalls() {
  for (const lvl of [0, 1]) {
    V.meshes[`${lvl}-floor`].geometry.dispose(); V.meshes[`${lvl}-floor`].geometry = buildFloorGeo(lvl);
    const wm = V.meshes[`${lvl}-wall`];
    wm.geometry.dispose(); wm.geometry = buildWallGeo(lvl);
    // reset to the shared source material; focus dimming is re-applied below.
    if (V.wallMat && V.frameMat) { wm.material = framingMode ? V.frameMat : V.wallMat; wm.userData.srcMat = null; }
    V.meshes[`${lvl}-door`].geometry.dispose(); V.meshes[`${lvl}-door`].geometry = buildDoorLeaves(lvl);
    V.meshes[`${lvl}-doorglass`].geometry.dispose(); V.meshes[`${lvl}-doorglass`].geometry = buildDoorGlass(lvl);
    V.meshes[`${lvl}-arc`].geometry.dispose(); V.meshes[`${lvl}-arc`].geometry = buildDoorArcs(lvl);
    V.meshes[`${lvl}-glass`].geometry.dispose(); V.meshes[`${lvl}-glass`].geometry = buildGlassGeo(lvl);
    V.meshes[`${lvl}-stair`].geometry.dispose(); V.meshes[`${lvl}-stair`].geometry = buildStairsGeo(lvl);
    V.meshes[`${lvl}-furn`].geometry.dispose(); V.meshes[`${lvl}-furn`].geometry = buildFurnitureGeo(lvl);
    V.meshes[`${lvl}-cab`].geometry.dispose(); V.meshes[`${lvl}-cab`].geometry = buildCabinetGeo(lvl);
    V.meshes[`${lvl}-mld`].geometry.dispose(); V.meshes[`${lvl}-mld`].geometry = buildMouldingGeo(lvl);
  }
  if (V.meshes["1-roof"]) {
    V.meshes["1-roof"].geometry.dispose(); V.meshes["1-roof"].geometry = buildRoofGeo();
    V.meshes["1-roofglass"].geometry.dispose(); V.meshes["1-roofglass"].geometry = buildRoofGlass();
  }
  // re-apply focus dimming (the wall material was just reset to its source above).
  if (V.meshes && currentFocus && Object.keys(currentFocus).length) applyFocus(currentFocus);
  // labels are annotations carried by `labels`; rebuild their divs whenever the
  // model is rebuilt (covers applySnap/applyState restores + tool edits, §7).
  if (V.labelHost) buildLabels();
}

// ---- scene (built once; geometries swapped on recompile) ----
// The viewer's scene-object registry: groups/meshes/materials are added by name
// as the scene is built and swapped on recompile, so this is an open `any` bag.
const V: any = {};

// ---- cursor-radius reveal for drag handles ----
// Instead of showing every drag handle (the spheres) at once, each handle group
// reveals only the markers within HANDLE_RADIUS_PX of the cursor in 2D screen
// space. Registered groups are swept once per frame (after updateOverlays, so the
// per-frame place*() passes have already set base level/data visibility); we only
// *further* hide — never re-show — so level filtering still wins.
const HANDLE_RADIUS_PX = 150;
const handleGroups: any = [];                         // sphere drag-handle groups (not measure)
const cursorPx = { x: 0, y: 0, inside: false };  // last canvas pointer position
function registerHandles(group: any) { handleGroups.push(group); return group; }
const _handleNDC = new THREE.Vector3();
function applyHandleRadius() {
  const rect = V.renderer.domElement.getBoundingClientRect();
  const r2 = HANDLE_RADIUS_PX * HANDLE_RADIUS_PX;
  for (const group of handleGroups) {
    if (!group.visible) continue;
    for (const m of group.children) {
      if (!m.visible) continue;                  // respect level/data hiding from place*()
      if (!cursorPx.inside) { m.visible = false; continue; }
      _handleNDC.copy(m.position).project(V.camera);
      const sx = rect.left + (_handleNDC.x * 0.5 + 0.5) * rect.width;
      const sy = rect.top + (-_handleNDC.y * 0.5 + 0.5) * rect.height;
      const dx = sx - cursorPx.x, dy = sy - cursorPx.y;
      if (_handleNDC.z > 1 || dx * dx + dy * dy > r2) m.visible = false;  // off-screen or too far
    }
  }
}

function build() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#9ec7ef");          // sky-blue fallback (the Sky dome covers it)
  // --- realistic clear blue sky (Preetham atmospheric model, no clouds) ---
  // The Sky shader forces its depth to the far plane, so it always renders behind
  // the model from any orbit angle and from inside in first-person. It's Z-up here
  // (`up`), and its sun tracks the editor's sun angle (see V.setSun below).
  const sky = new Sky(); sky.scale.setScalar(10000);
  const skyU = sky.material.uniforms;
  skyU.turbidity.value = 2.2;          // low haze → clean, clear air
  skyU.rayleigh.value = 1.8;           // saturated blue
  skyU.mieCoefficient.value = 0.004;   // small, soft sun glow (no haze halo)
  skyU.mieDirectionalG.value = 0.8;
  skyU.up.value.set(0, 0, 1);          // world is Z-up
  // NOTE: added to the scene AFTER the model bounding box is measured (below), so
  // its 10000-unit dome doesn't inflate the camera framing / ortho fit / sun dist.
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  $("app").appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.5, 4000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  // Deliberate orbit (Figma-style): LEFT-drag does NOT orbit by default — it's for
  // selecting. Orbit happens with MIDDLE-drag (always), or LEFT-drag while in the
  // Orbit tool / holding Space. updateOrbit() flips LEFT between ROTATE and "none".
  controls.mouseButtons = { LEFT: -1 as any, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };

  scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x3a3a40, 0.5));
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));
  const key = new THREE.DirectionalLight(0xfff4e6, 2.0);
  key.position.set(-40, -55, 90); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0006; scene.add(key);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.35); fill.position.set(60, 40, 30); scene.add(fill);

  const floorMat = new THREE.MeshStandardMaterial({ name: "Floor", vertexColors: true, roughness: 0.9 });
  const wallMat = new THREE.MeshStandardMaterial({ name: "Wall", color: WALL_COLOR, roughness: 0.95, side: THREE.DoubleSide });
  const frameMat = new THREE.MeshStandardMaterial({ name: "Framing", color: 0xc8a06a, roughness: 0.85, side: THREE.DoubleSide });  // lumber tone for framing mode
  const doorMat = new THREE.MeshStandardMaterial({ name: "Door", vertexColors: true, roughness: 0.7, side: THREE.DoubleSide });
  const arcMat = new THREE.LineBasicMaterial({ color: 0x9a6a4a, transparent: true, opacity: 0.7 });
  const glassMat = new THREE.MeshStandardMaterial({ name: "Glass", color: 0x9fd0e0, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
  const stairMat = new THREE.MeshStandardMaterial({ name: "Stairs", color: 0xb9a487, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide });
  const furnMat = new THREE.MeshStandardMaterial({ name: "Furniture", vertexColors: true, roughness: 0.75, metalness: 0.0, side: THREE.DoubleSide });
  const cabMat = new THREE.MeshStandardMaterial({ name: "Cabinets", vertexColors: true, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide });
  const mldMat = new THREE.MeshStandardMaterial({ name: "Moulding", vertexColors: true, roughness: 0.8, metalness: 0.0, side: THREE.DoubleSide });
  const lower = new THREE.Group(), main = new THREE.Group(), meshes: Record<string, any> = {};
  for (const [grp, lvl] of [[lower, 0], [main, 1]] as [THREE.Group, number][]) {  // floor, walls, door leaves, arcs, glass, stairs
    const fm = new THREE.Mesh(new THREE.BufferGeometry(), floorMat); fm.receiveShadow = true;
    meshes[`${lvl}-floor`] = fm; grp.add(fm);
    const wm = new THREE.Mesh(new THREE.BufferGeometry(), wallMat); wm.castShadow = wm.receiveShadow = true;
    meshes[`${lvl}-wall`] = wm; grp.add(wm);
    const dm = new THREE.Mesh(new THREE.BufferGeometry(), doorMat); dm.castShadow = true;
    meshes[`${lvl}-door`] = dm; grp.add(dm);
    const dgm = new THREE.Mesh(new THREE.BufferGeometry(), glassMat); dgm.castShadow = true;
    meshes[`${lvl}-doorglass`] = dgm; grp.add(dgm);
    const ar = new THREE.LineSegments(new THREE.BufferGeometry(), arcMat);
    meshes[`${lvl}-arc`] = ar; grp.add(ar);
    const gm = new THREE.Mesh(new THREE.BufferGeometry(), glassMat);
    meshes[`${lvl}-glass`] = gm; grp.add(gm);
    const sm = new THREE.Mesh(new THREE.BufferGeometry(), stairMat); sm.castShadow = sm.receiveShadow = true;
    meshes[`${lvl}-stair`] = sm; grp.add(sm);
    const fm2 = new THREE.Mesh(new THREE.BufferGeometry(), furnMat); fm2.castShadow = fm2.receiveShadow = true;
    meshes[`${lvl}-furn`] = fm2; grp.add(fm2);
    const cm = new THREE.Mesh(new THREE.BufferGeometry(), cabMat); cm.castShadow = cm.receiveShadow = true;
    meshes[`${lvl}-cab`] = cm; grp.add(cm);
    const mm = new THREE.Mesh(new THREE.BufferGeometry(), mldMat); mm.castShadow = mm.receiveShadow = true;
    meshes[`${lvl}-mld`] = mm; grp.add(mm);
    for (const k of ["floor", "wall", "door", "doorglass", "arc", "glass", "stair", "furn", "cab", "mld"]) meshes[`${lvl}-${k}`].userData.level = lvl;
  }
  // --- ROOF: lives in the MAIN group so it rides the walls (and the stack
  // offset). It is ALWAYS in the scene and ALWAYS castShadow=true, so it lights
  // the main level through its openings even when its material is invisible. ---
  const roofMat = new THREE.MeshStandardMaterial({ name: "Roof", color: ROOF.color, roughness: 0.9, metalness: 0.0,
    side: THREE.DoubleSide, transparent: true, opacity: 0, depthWrite: false });
  const roofGlassMat = new THREE.MeshStandardMaterial({ color: 0xbfe6f2, roughness: 0.08, metalness: 0.1,
    transparent: true, opacity: 0.4, side: THREE.DoubleSide });
  const roofMesh = new THREE.Mesh(new THREE.BufferGeometry(), roofMat);
  roofMesh.castShadow = true; roofMesh.userData.level = 1; meshes["1-roof"] = roofMesh; main.add(roofMesh);
  const roofGlass = new THREE.Mesh(new THREE.BufferGeometry(), roofGlassMat);
  roofGlass.userData.level = 1; meshes["1-roofglass"] = roofGlass; main.add(roofGlass);
  Object.assign(V, { meshes, wallMat, frameMat, roofMat, roofGlassMat });
  // Reflect roof view state into the roof material (opacity drives visibility;
  // the mesh stays in the scene so shadows persist regardless). `ghost` is the
  // translucent state used while editing the roof so openings stay legible.
  V.setRoofView = (state: any) => {
    const o = state === "solid" ? 1.0 : state === "ghost" ? 0.42 : 0.0;
    roofMat.opacity = o; roofMat.transparent = o < 0.999; roofMat.depthWrite = o >= 0.999;
    roofMat.needsUpdate = true;
    roofGlass.visible = o > 0.001;                 // panes only read when the roof is visible
  };
  rebuildWalls();                                                     // fill geometry from the graph
  V.setRoofView(roofShown ? "solid" : "hidden");                      // reflect restored roof toggle
  scene.add(lower, main);

  const box = new THREE.Box3().setFromObject(scene);
  const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) || 60;
  scene.add(sky);                                  // safe now: box is measured from the model only
  controls.target.copy(center);
  camera.position.set(center.x - radius * 0.9, center.y - radius * 1.05, center.z + radius * 1.15);
  controls.update();
  // initial perspective framing distance = 100% zoom reference (§5.4)
  V.fitDist3d = camera.position.distanceTo(controls.target);
  // remember the initial 3D framing so Shift+1 can restore it exactly
  V.fit3dPos = camera.position.clone(); V.fit3dTarget = controls.target.clone();

  // --- top-down orthographic ("plan") camera, looking straight down -Z ---
  const ocam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  ocam.up.set(0, 1, 0);                         // +Y (back of house) points up in plan
  ocam.position.set(center.x, center.y, center.z + radius * 3);
  ocam.lookAt(center.x, center.y, center.z);
  const octrl = new OrbitControls(ocam, renderer.domElement);
  octrl.enableDamping = true; octrl.dampingFactor = 0.08;
  octrl.enableRotate = false;                   // lock to top-down; pan + zoom only
  octrl.target.copy(center); octrl.enabled = false;
  V.size = size; V.center = center;
  function fitOrtho() {
    const a = innerWidth / innerHeight, W = size.x * 1.08, H = size.y * 1.08;
    const halfH = (W / H > a) ? (W / a) / 2 : H / 2, halfW = halfH * a;
    ocam.left = -halfW; ocam.right = halfW; ocam.top = halfH; ocam.bottom = -halfH;
    ocam.updateProjectionMatrix();
  }
  fitOrtho();
  V.fitOrtho = fitOrtho;

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(radius * 6, radius * 6),
    new THREE.ShadowMaterial({ opacity: 0.28 }));
  ground.position.set(center.x, center.y, box.min.z - 0.5); ground.receiveShadow = true; scene.add(ground);

  // --- reference plan underlay: the uploaded image, onion-skinned over Plan ---
  // Drawn with depth testing off and a late renderOrder so the translucent image
  // always reads as a tracing overlay above the model; visible ONLY in the
  // top-down plan view (refreshRef() is re-run from V.setView).
  const refMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: refPlan.opacity,
    depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const refMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), refMat);
  refMesh.renderOrder = 998; refMesh.visible = false;
  scene.add(refMesh);
  let refAspect = 1;                              // image height / width
  function refreshRef() {                         // size + place + show/hide the overlay
    const w = Math.max(1, refPlan.w || size.x * 1.05);
    refMesh.scale.set(w, w * refAspect, 1);
    // z: comfortably above the (possibly exploded) model, still inside the ortho
    // frustum — the plan camera sits at center.z + radius*3 looking down.
    refMesh.position.set(center.x + refPlan.x, center.y + refPlan.y, center.z + radius * 2);
    refMat.opacity = refPlan.opacity;
    // octrl.enabled IS "plan view active" (set by setView) — safer than V.view,
    // which callers update separately.
    refMesh.visible = !!(refMat.map && refPlan.shown && octrl.enabled);
  }
  function setRefImage(dataUrl: any) {                 // data URL, or null to remove
    refPlan.img = dataUrl;
    if (refMat.map) { refMat.map.dispose(); refMat.map = null; refMat.needsUpdate = true; }
    if (!dataUrl) { refreshRef(); return; }
    const img = new Image();
    img.onload = () => {
      if (refPlan.img !== dataUrl) return;        // superseded while decoding
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.needsUpdate = true;
      refMat.map = tex; refMat.needsUpdate = true;
      refAspect = img.height / img.width;
      if (!refPlan.w) refPlan.w = Math.round(size.x * 1.05 * 2) / 2;   // auto-fit the model width
      refreshRef(); updateRefUI();
    };
    img.src = dataUrl;
  }

  key.target.position.copy(center); scene.add(key.target);
  const sunDist = radius * 1.9;                  // how far the sun orbits the model
  const sc = key.shadow.camera;
  sc.left = -radius; sc.right = radius; sc.top = radius; sc.bottom = -radius;
  sc.near = 1; sc.far = sunDist + radius * 2.5; sc.updateProjectionMatrix();
  // Position the sun from a compass AZIMUTH (direction it shines from) + ELEVATION
  // (height above the horizon). It always aims at the model center, so moving it
  // sweeps the shadows — including the roof's, which lights the main level.
  V.setSun = (az: any, el: any) => {
    sunAz = az; sunEl = el;
    const a = az * Math.PI / 180, e = Math.max(2, Math.min(89, el)) * Math.PI / 180;
    const ce = Math.cos(e);
    key.position.set(
      center.x + sunDist * ce * Math.sin(a),
      center.y + sunDist * ce * Math.cos(a),
      center.z + sunDist * Math.sin(e));
    key.target.position.copy(center); key.target.updateMatrixWorld();
    // keep the sky's sun (glow + blue tint) aimed where the editor's sun is
    skyU.sunPosition.value.set(ce * Math.sin(a), ce * Math.cos(a), Math.sin(e));
  };
  V.setSun(sunAz, sunEl);                         // apply restored / default sun position

  Object.assign(V, { scene, renderer, meshes, lower, main, exploded: true, rooms, graph, sky,
    pcam: camera, pctrl: controls, ocam, octrl, camera, controls });   // camera/controls = active
  (window as any).viewer = V;
  // world (x,y,z) → screen pixel (for overlays / tests)
  V.project = (x: any, y: any, z: any) => {
    const v = new THREE.Vector3(x, y, z).project(V.camera);
    const r = V.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height, z: v.z };
  };
  V.setView = (mode: any) => {                        // "persp" (3D) or "plan" (top-down ortho)
    const plan = mode === "plan";
    V.camera = plan ? ocam : camera; V.controls = plan ? octrl : controls;
    octrl.enabled = plan; controls.enabled = !plan;
    if (plan) fitOrtho();
    refreshRef();                                 // reference underlay is plan-only
  };

  // ---- zoom (§5.4) ---------------------------------------------------------
  // Percent: plan = ocam.zoom*100 (the fitted frustum is zoom 1 = 100%);
  // 3D = (initial framing distance / current distance)*100.
  V.zoomPct = () => {
    if (V.view === "plan") return Math.round(ocam.zoom * 100);
    const d = camera.position.distanceTo(controls.target) || 1;
    return Math.round((V.fitDist3d / d) * 100);
  };
  // Zoom-to-fit: plan re-fits the ortho frustum + resets zoom/pan; 3D reframes the
  // camera to the model bounds exactly as build() did initially.
  V.zoomToFit = () => {
    if (V.view === "plan") {
      fitOrtho(); ocam.zoom = 1; octrl.target.copy(center);
      ocam.position.set(center.x, center.y, ocam.position.z);
      ocam.updateProjectionMatrix(); octrl.update();
    } else {
      camera.position.copy(V.fit3dPos); controls.target.copy(V.fit3dTarget); controls.update();
    }
  };
  // Frame a world-space Box3 (selection). Falls back to fit when empty.
  V.frameBox = (box: any) => {
    if (!box || box.isEmpty()) { V.zoomToFit(); return; }
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const r = Math.max(s.x, s.y, s.z, 2);
    if (V.view === "plan") {
      const a = innerWidth / innerHeight, W = s.x * 1.5 + 4, H = s.y * 1.5 + 4;
      const halfH = (W / H > a) ? (W / a) / 2 : H / 2, halfW = halfH * a;
      ocam.left = -halfW; ocam.right = halfW; ocam.top = halfH; ocam.bottom = -halfH; ocam.zoom = 1;
      octrl.target.set(c.x, c.y, center.z); ocam.position.set(c.x, c.y, ocam.position.z);
      ocam.updateProjectionMatrix(); octrl.update();
    } else {
      const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
      const dist = r * 2.4;
      controls.target.copy(c); camera.position.copy(c).addScaledVector(dir, dist); controls.update();
    }
  };
  V.zoomToSelection = () => { const b = V.selectionBox ? V.selectionBox() : null; V.frameBox(b); };
  // Pan-only recenter on a world point (Phase 7): preserves zoom/orbit, just slides
  // the camera so (x,y,z) sits at the view center. Plan moves the ortho cam + target
  // in XY; 3D shifts both camera and target by the same delta. Animated (~280ms
  // ease) so a short pan is perceivable — an instant jump can read as "nothing
  // happened". Used by the Layers panel jump-to-selection.
  let centerAnim = 0;                       // bumping this cancels an in-flight glide
  V.centerOn = (x: any, y: any, z: any) => {
    const id = ++centerAnim;
    const isPlan = V.view === "plan";
    const cam = isPlan ? ocam : camera, ctl = isPlan ? octrl : controls;
    const t0 = ctl.target.clone();
    const t1 = isPlan ? new THREE.Vector3(x, y, center.z) : new THREE.Vector3(x, y, z);
    const p0 = cam.position.clone();
    const p1 = isPlan ? new THREE.Vector3(x, y, cam.position.z)
                      : p0.clone().add(new THREE.Vector3().subVectors(t1, t0));
    const start = performance.now(), DUR = 280;
    const ease = (u: any) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
    (function step(now) {
      if (id !== centerAnim) return;        // superseded by a newer centerOn
      const u = Math.min(1, (now - start) / DUR), k = ease(u);
      cam.position.lerpVectors(p0, p1, k);
      ctl.target.lerpVectors(t0, t1, k);
      ctl.update();
      if (u < 1) requestAnimationFrame(step);
    })(start);
  };
  // Active-state undo/redo (operates on the CURRENT scenario state's own history).
  V.history = { undo, redo, jump: restore, labels: () => history.map((h) => h.label), index: () => hi };
  // A/B walkthrough API: states[0] = A, states[last] = B; goTo switches the active
  // EDITING state (each state has its own history) and morphs the live model.
  V.scenario = {
    addStep: scnAddStep, removeStep: scnRemoveStep, rename: scnRename,
    goTo: switchState, next: scnNext, prev: scnPrev, play: scnPlay, stop: scnStop,
    toA: () => switchState(0), toB: () => switchState(states.length - 1),
    states: () => states.map((s) => s.label), index: () => cur,
  };

  const labelHost = $("labels"); V.labelHost = labelHost;
  // Seed labels from the room names the first time `rooms` exists, IF a saved blob
  // didn't carry any (labels === null sentinel). Silent migration — no commit; the
  // next auto-save persists it. Must run before any buildLabels()/applySnap below.
  if (labels === null) labels = seedLabels(rooms);
  V.overlayHost = $("overlays");   // always-visible (independent of the labels toggle)
  labelHost.style.display = $("t-labels").checked ? "block" : "none";  // off by default
  $("t-walls").onchange = (e: any) => {
    for (const k of ["0-wall", "1-wall", "0-door", "1-door", "0-doorglass", "1-doorglass", "0-arc", "1-arc", "0-glass", "1-glass", "0-mld", "1-mld"]) meshes[k].visible = e.target.checked;
  };
  const framingBox = $("t-framing");
  framingBox.checked = framingMode;                              // reflect restored value
  framingBox.onchange = (e: any) => { framingMode = e.target.checked; rebuildWalls(); saveState(); };
  $("t-explode").onchange = (e: any) => { V.exploded = e.target.checked; applyStack(); };
  const roofBox = $("t-roof");
  roofBox.checked = roofShown;                                   // reflect restored value
  roofBox.onchange = (e: any) => {
    roofShown = e.target.checked;
    if (mode !== "roof") V.setRoofView(roofShown ? "solid" : "hidden");   // roof tool forces ghost
    saveState();
  };
  $("t-labels").onchange = (e: any) => { labelHost.style.display = e.target.checked ? "block" : "none"; };
  $("t-grid").onchange = (e: any) => { gridSize = e.target.checked ? 1 : 0; };
  const hVal = $("t-height-v"), hSlider = $("t-height");
  hSlider.value = wallH; hVal.textContent = wallH + " ft";        // reflect restored value
  hSlider.oninput = (e: any) => {
    wallH = +e.target.value; hVal.textContent = wallH + " ft";
    rebuildWalls(); applyStack();   // re-stack: keep main floor on top of the (now taller/shorter) lower walls
    if (V.refreshEditors) V.refreshEditors(); saveState();
  };
  const dVal = $("t-dooropen-v"), dSlider = $("t-dooropen");
  dSlider.value = doorOpenDeg; dVal.textContent = doorOpenDeg + "°";
  dSlider.oninput = (e: any) => {
    doorOpenDeg = +e.target.value; dVal.textContent = doorOpenDeg + "°";
    rebuildWalls(); saveState();                                  // door leaves + arcs swing live (0 = shut)
  };
  // --- sun position: azimuth (compass) + elevation (height above horizon) ---
  const azSlider = $("t-sunaz"), azVal = $("t-sunaz-v");
  const elSlider = $("t-sunel"), elVal = $("t-sunel-v");
  azSlider.value = sunAz; azVal.textContent = sunAz + "°";        // reflect restored values
  elSlider.value = sunEl; elVal.textContent = sunEl + "°";
  azSlider.oninput = (e: any) => { azVal.textContent = (+e.target.value) + "°"; V.setSun(+e.target.value, sunEl); saveState(); };
  elSlider.oninput = (e: any) => { elVal.textContent = (+e.target.value) + "°"; V.setSun(sunAz, +e.target.value); saveState(); };
  // --- reference plan (Scene tab): upload + onion-skin overlay controls -------
  const refStatus = $("ref-status");
  function updateRefUI() {
    if (refStatus) refStatus.textContent = refPlan.img
      ? "Shown in Plan view — set Width to the drawing's real-world width."
      : "No image loaded.";
    setNumField("t-refwidth", Math.round((refPlan.w || size.x * 1.05) * 2) / 2);
    setNumField("t-refx", refPlan.x); setNumField("t-refy", refPlan.y);
  }
  // Downscale an upload to ≤2048px on the long edge (re-encoded as JPEG) so the
  // data URL persisted in the floorplan.scad header stays a manageable size;
  // already-small files pass through untouched, keeping line-art PNGs crisp.
  function downscaleImage(dataUrl: any, cb: any) {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 2048 / Math.max(img.width, img.height));
      if (k === 1 && dataUrl.length < 1500000) return cb(dataUrl);
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(img.width * k));
      cv.height = Math.max(1, Math.round(img.height * k));
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);   // flatten alpha for JPEG
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      cb(cv.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => cb(null);                 // not a decodable image
    img.src = dataUrl;
  }
  const refFile = document.createElement("input");
  refFile.type = "file"; refFile.accept = "image/*"; refFile.style.display = "none";
  document.body.appendChild(refFile);
  $("ref-upload").onclick = () => refFile.click();
  refFile.onchange = () => {
    const f = refFile.files && refFile.files[0]; refFile.value = "";
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => downscaleImage(rd.result, (url: any) => {
      if (!url) { if (refStatus) refStatus.textContent = "Couldn't read that file — is it an image?"; return; }
      refPlan.w = 0;                              // auto-fit the width for the new image
      setRefImage(url); updateRefUI(); saveState();
      if (V.view !== "plan") setSaveStatus("Reference loaded — switch to Plan view to see it.");
    });
    rd.readAsDataURL(f);
  };
  $("ref-clear").onclick = () => {
    setRefImage(null); refPlan.w = 0; refPlan.x = refPlan.y = 0;
    updateRefUI(); saveState();
  };
  const refShow = $("t-refshow");
  refShow.checked = refPlan.shown;                                // reflect restored value
  refShow.onchange = (e: any) => { refPlan.shown = e.target.checked; refreshRef(); saveState(); };
  const refOp = $("t-refopacity"), refOpV = $("t-refopacity-v");
  refOp.value = Math.round(refPlan.opacity * 100); refOpV.textContent = Math.round(refPlan.opacity * 100) + "%";
  refOp.oninput = (e: any) => {
    refPlan.opacity = +e.target.value / 100; refOpV.textContent = e.target.value + "%";
    refreshRef(); saveState();
  };
  // width / offset NumFields — wired by hand (not numField()): the overlay is a
  // view aid, so edits refresh + auto-save but never enter the undo history.
  const refNum = (id: any, set: any) => {
    const el = $(id); if (!el) return;
    // NumField dispatches input/change with a DECIMAL value, but native typing
    // also fires `input` with partial text ("26' 6") — ignore non-finite reads.
    const apply = (e: any, save: any) => {
      const v = +e.target.value;
      if (!isFinite(v)) return;
      set(v); refreshRef(); if (save) saveState();
    };
    el.addEventListener("input", (e: any) => apply(e, false));
    el.addEventListener("change", (e: any) => apply(e, true));
  };
  refNum("t-refwidth", (v: any) => { refPlan.w = Math.max(1, v); });
  refNum("t-refx", (v: any) => { refPlan.x = v; });
  refNum("t-refy", (v: any) => { refPlan.y = v; });
  if (refPlan.img) setRefImage(refPlan.img);      // restore a saved reference at boot
  updateRefUI();
  V.refPlan = { get state() { return refPlan; }, mesh: refMesh, set: setRefImage, refresh: refreshRef };

  $("export").onclick = exportScad;
  $("export-glb").onclick = exportGlb;
  $("save-server").onclick = saveScadToServer;
  $("render-server").onclick = renderOnServer;
  $("reset").onclick = resetState;
  const savedEl = $("saved");
  if (savedEl) savedEl.textContent = restored ? "Loaded edits from floorplan.scad." : "Auto-saving edits to floorplan.scad.";
  V.floor = "both";
  const ff = $("floor-filter");
  ff.querySelectorAll(".tool").forEach((bt: any) => bt.onclick = () => {
    V.floor = bt.dataset.floor;
    lower.visible = V.floor !== "1";
    main.visible = V.floor !== "0";
    if (V.clearSelections) V.clearSelections();   // drop selections on a now-hidden floor
    ff.querySelectorAll(".tool").forEach((x: any) => x.classList.toggle("active", x === bt));
  });
  V.view = "persp";
  const vm = $("view-mode");
  vm.querySelectorAll(".tool").forEach((bt: any) => bt.onclick = () => {
    V.view = bt.dataset.view; V.setView(V.view);
    updateOrbit();
    document.body.classList.toggle("planview", V.view === "plan");
    vm.querySelectorAll(".tool").forEach((x: any) => x.classList.toggle("active", x === bt));
  });
  buildLabels();

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    fitOrtho();
    renderer.setSize(innerWidth, innerHeight);
  });
  setupTools();
  // Seed / restore the A/B scenario.
  if (states.length) {                          // restored a saved walkthrough
    if (cur < 0 || cur >= states.length) cur = 0;
    history = states[cur].history;
    hi = (states[cur].hi >= 0 && states[cur].hi < history.length) ? states[cur].hi : history.length - 1;
    if (history[hi]) applySnap(history[hi].snap);   // V.refreshEditors/rebuildWalls exist now
    renderHistory(); renderScenario();
  } else {                                       // fresh: state A = the as-built model
    states = [{ label: "As-built", history, hi: -1 }];   // history aliases states[0].history
    cur = 0;
    commit("Initial layout");                    // seeds states[0].history + repaints
    renderScenario();
  }
  setStatus(null);
  dispatchModel();                                // seed the Layers panel at boot (§5.2)

  const v = new THREE.Vector3();
  const zoomEl = $("zoom-pct");
  let lastZoom = -1;
  (function loop() {
    requestAnimationFrame(loop);
    if (!V.fpActive) V.controls.update();          // first-person drives the camera itself (see walk tool)
    if (V.wallsDirty) { rebuildWalls(); V.wallsDirty = false; }   // realtime wall edits
    placeLabels(v);
    if (V.updateOverlays) V.updateOverlays();
    applyHandleRadius();                            // reveal only handles near the cursor
    // zoom % readout (§5.4): write only when the value changes (cheap)
    if (zoomEl) { const z = V.zoomPct(); if (z !== lastZoom) { lastZoom = z; zoomEl.textContent = z + "%"; } }
    renderer.render(scene, V.camera);
  })();
}

// z of a level's wall mid-height in current (exploded?) world space
const levelZ = (level: any) => LEVEL_Z[level] + (level === 1 && !V.exploded ? stackOffset() : 0);
// world-space boundary between the lower and main levels (for click→level pick):
// the top of the lower walls when stacked, the gap midpoint when exploded.
const levelSplitZ = () => (V.exploded ? MID_Z : wallH);
// floor-visibility filter ("both" | 0 | 1)
const levelVisible = (level: any) => V.floor === "both" || +V.floor === level;

// Rebuild the label divs from the `labels` collection (Phase 7). Each div is a
// positionable annotation; the Labels tool registers V.labelDown to start a drag
// and reads V.labels (each { el, lb, i }) to apply selection. A label with level 0
// gets `.dim`; one whose level is filtered out is hidden in placeLabels.
function buildLabels() {
  V.labelHost.querySelectorAll(".label").forEach((e: any) => e.remove());
  V.labels = (labels || []).map((lb, i) => {
    const el = document.createElement("div");
    el.className = "label" + (lb.level === 0 ? " dim" : "");
    el.textContent = lb.text; V.labelHost.appendChild(el);
    el.addEventListener("pointerdown", (e) => { if (V.labelDown) V.labelDown(e, i); });
    return { el, lb, i };
  });
  if (V.refreshLabelSel) V.refreshLabelSel();   // re-apply .sel after a rebuild
}
function placeLabels(v: any) {
  const w = V.renderer.domElement.clientWidth, h = V.renderer.domElement.clientHeight;
  for (const { el, lb } of V.labels) {
    if (!levelVisible(lb.level)) { el.style.display = "none"; continue; }
    v.set(lb.x, lb.y, levelZ(lb.level) + 0.3).project(V.camera);
    if (v.z > 1) { el.style.display = "none"; continue; }
    el.style.display = "";
    el.style.left = (v.x * 0.5 + 0.5) * w + "px";
    el.style.top = (-v.y * 0.5 + 0.5) * h + "px";
  }
}

// ===========================================================================
// TOOLS
// ===========================================================================
const ray = new THREE.Raycaster();
const ndcV = new THREE.Vector2();
function pointerNDC(e: any) {
  const r = V.renderer.domElement.getBoundingClientRect();
  ndcV.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  return ndcV;
}
// only the visible floor(s) are pickable, so a filtered floor isn't editable
const pickMeshes = (e: any) => {
  ray.setFromCamera(pointerNDC(e), V.camera);
  // exclude the roof: it stays `visible` (so it casts shadows even when its
  // material is transparent), but it must not block floor/wall picking. The roof
  // tool does its own picking against the roof plane + markers.
  // stairs are excluded alongside the roof: they're geometry the Select tool has
  // no panel for, and shouldn't intercept clicks meant for the floor/walls below.
  // skip ghosted (focus-dimmed) meshes so they can't steal clicks (§3.4: noPick).
  const ms = (Object.entries(V.meshes) as [string, any][]).filter(([k, m]) => levelVisible(+k[0]) && !m.userData.noPick && !k.includes("roof") && !k.includes("stair") && !k.includes("furn") && !k.includes("cab")).map(([, m]) => m);
  return ray.intersectObjects(ms, false)[0] || null;
};

let mode = "select";          // default tool: select-any-object (not orbit)
let spaceHeld = false;        // hold Space to temporarily orbit with LEFT-drag

// ---- mode system (§3.3): a MODE scopes the editor to one domain. Modes are
// SESSION UI state — never persisted to the .scad header; the editor opens in
// "layout". Each mode lists its tools (first = default) and a focus spec:
// meshKey-suffix → opacity (1 = full; unlisted = 1). applyFocus dims the rest.
// Tool names are the engine's internal tool keys ("edit" = the Walls tool).
// moulding/cabinets have no domain tools yet (Phases 4/5) — Select only for now.
const MODES: Record<string, any> = {
  layout:    { tools: ["select", "edit", "measure"],          focus: {} },
  doors:     { tools: ["select", "doors"],                    focus: { wall: 0.35, furn: 0.15, cab: 0.15 } },
  windows:   { tools: ["select", "windows"],                  focus: { wall: 0.35, door: 0.15, doorglass: 0.15, furn: 0.15, cab: 0.15 } },
  moulding:  { tools: ["select", "moulding"],                 focus: { wall: 0.85, furn: 0.15, cab: 0.15 } },
  cabinets:  { tools: ["select", "cabinets"],                 focus: { wall: 0.5, furn: 0.25 } },
  furniture: { tools: ["select", "furniture"],               focus: { wall: 0.5, cab: 0.25 } },
  structure: { tools: ["select", "stairs", "roof", "measure"], focus: {} },
  tour:      { tools: ["walk"],                               focus: {} },
  labels:    { tools: ["select", "labels"],                  focus: {} },
};
// modes that hide the roof entirely (focus table treats roof via setRoofView).
const MODE_ROOF_HIDDEN = new Set(["doors", "windows", "moulding", "cabinets"]);
let uiMode = "layout";        // active mode (NOT persisted)
let currentFocus = {};        // active focus spec — re-applied after each rebuildWalls

// Apply focus dimming (§3.4): for every mesh, clone its material ONCE on first
// dim (cached as userData.dimMat — never mutate the shared source material) and
// set transparent/opacity from the spec. Opacity 1 restores the original. Dimmed
// meshes get userData.noPick so pickMeshes skips them. Floors are NEVER dimmed.
// The roof is handled via setRoofView (not a material override).
function applyFocus(spec: any) {
  currentFocus = spec;
  for (const [k, m] of (Object.entries(V.meshes) as [string, any][])) {
    if (k.includes("roof")) continue;                     // roof goes through setRoofView
    const suffix = k.slice(k.indexOf("-") + 1);           // "1-wall" → "wall"
    if (suffix === "floor" || suffix === "arc") { m.userData.noPick = false; continue; }  // floors never dimmed
    let op = spec[suffix];
    if (op == null) op = 1;
    if (op >= 0.999) {                                     // full: restore original material
      if (m.userData.srcMat) { m.material = m.userData.srcMat; m.userData.srcMat = null; }
      m.userData.noPick = false;
    } else {
      if (!m.userData.srcMat) m.userData.srcMat = m.material;
      // (re)build the dim clone from the current source material each apply
      if (m.userData.dimMat) m.userData.dimMat.dispose();
      const dm = m.userData.srcMat.clone(); dm.transparent = true; dm.opacity = op; dm.depthWrite = false;
      m.userData.dimMat = dm; m.material = dm; m.userData.noPick = true;
    }
  }
}

// Subpanel count header text (§3.5, fixes G4): state the SCOPE explicitly —
// "N <noun>s selected" when there's a selection, else "New <noun>s will use these
// settings" so a slider/color reads as a placement default, not an edit.
function countLabel(n: any, noun: any) {
  if (n > 0) return `${n} ${noun}${n === 1 ? "" : "s"} selected`;
  return `New ${noun}s will use these settings`;
}

// ---- NumField (§5.1) engine wiring -----------------------------------------
// NumFields share the slider id contract: the engine reads <input>.value (decimal
// feet) and listens for `input` (live) / `change` (commit). The DISPLAY in the
// input is ft-in, so whenever the ENGINE writes a value into the field it sets the
// raw decimal then dispatches `kirkham:fmt` so the NumField reformats it (contract
// documented in controls.tsx::NumField). setNumField pushes engine→field; numField
// wires a NumField the same way the per-tool `slider(...)` helpers wire ranges.
function setNumField(id: any, num: any) {
  const el = $(id);
  if (!el) return;
  el.value = String(num);
  el.dispatchEvent(new CustomEvent("kirkham:fmt"));
}
// Wire a NumField: `get()` seeds the resting value; `change` commits via set()+commit,
// `input` (label-scrub / arrow) live-updates without a history entry. Mirrors the
// behavior of the old range `slider()` helpers but for the typed/scrubbed field.
function numField(id: any, get: any, set: any, commitLabel: any) {
  const el = $(id);
  if (!el) return;
  setNumField(id, get());
  el.addEventListener("change", (e: any) => { set(+e.target.value); commit(commitLabel); });
  el.addEventListener("input", (e: any) => { set(+e.target.value); });   // live scrub: no commit
}

// Single source of truth for whether LEFT-drag orbits. The standalone Orbit tool
// was removed in the mode redesign: LEFT orbits ONLY while Space is held (and
// never in locked plan view); MIDDLE-drag always orbits. Everything else leaves
// LEFT free for selection.
function updateOrbit() {
  const c = V.controls;
  if (!c || !c.mouseButtons) return;
  c.enableRotate = true;
  const orbit = spaceHeld && V.view !== "plan";
  c.mouseButtons.LEFT = orbit ? THREE.MOUSE.ROTATE : -1;
}

function setupTools() {
  const info = $("toolinfo");
  // The standalone Orbit tool is gone (Space-hold / middle-drag orbit everywhere).
  const ids = ["select", "walk", "measure", "edit", "doors", "windows", "moulding", "cabinets", "stairs", "furniture", "roof", "labels"];
  const btn = Object.fromEntries(ids.map((k) => [k, $("tool-" + k)]));
  // HINTS carry their shortcut in Figma style (§5.5).
  const HINTS: Record<string, string> = {
    select: "Select V — click any object to select it and see its properties. Hold Space (or middle-drag) to orbit. Press 1–8 to switch mode.",
    walk: "Walk — click the floor to drop in · drag to look around · WASD/arrows to walk · scroll to step · Q/E eye height · Esc to exit. ▶ Render renders this eye-level view.",
    measure: "Measure M — click two points to measure. Click again to start over.",
    edit: "Walls W — click/marquee-drag to select · Shift to add · drag to move all selected · drag a wall to PUSH it (whole colinear run shifts) · click a wall to add a point · Weld joins · Alt-click/Delete removes (hole).",
    doors: "Place Door D — click a wall to add · click a door to select (Shift = multi) · drag to slide · F flip swing · G flip hinge · Delete to remove.",
    windows: "Place Window N — click a wall to add a window · click to select (Shift = multi) · drag to slide · Width slider resizes · Delete to remove.",
    moulding: "Apply Moulding A — hover a room to preview · click to apply (or select if it already has this kind) · Shift = multi-select · pick the kind/profile/dims in the panel · Apply to level does every room · Delete to remove.",
    cabinets: "Place Cabinet C — click the floor to place (snaps back-to-wall within 3 ft) · click a cabinet to select (Shift = multi) · drag to slide along the wall · R rotate free pieces · Delete to remove.",
    stairs: "Stairs S — click the floor to add · drag a vertex to aim/turn a flight · drag the body to move · +Flight adds a turning flight (landing) · sliders resize · R rotate · F flip · Delete to remove.",
    furniture: "Place Furniture F — pick a type, click the floor to place it · click a piece to select (Shift = multi) · drag to move · sliders resize · R rotate · Delete to remove.",
    roof: "Roof R — click the roof to add a skylight (or a cut) · click a marker to select · drag to move · sliders resize · Delete to remove.",
    labels: "Labels L — click the floor to add a label · click a label to select (Shift = multi) · drag to move · type in the panel to rename · Delete to remove.",
  };
  // tool key → tool name (engine keys); used by the global keyboard handler (§3.3).
  const TOOL_KEYS: Record<string, string> = { v: "select", w: "edit", m: "measure", d: "doors", n: "windows", a: "moulding", c: "cabinets", s: "stairs", r: "roof", f: "furniture", l: "labels" };
  const measure = setupMeasure(info), edit = setupEdit(info), door = setupDoors(info), win = setupWindows(info), stair = setupStairs(info), furn = setupFurniture(info), roof = setupRoof(info);
  const mould = setupMoulding(info);
  const cab = setupCabinets(info);
  const lbl = setupLabels(info);
  const walk = setupFirstPerson(info);
  const select = setupSelect(info, { door, win, stair, furn, roof, mould, cab, lbl });
  V.refreshEditors = () => { edit.refresh(); door.refresh(); win.refresh(); stair.refresh(); furn.refresh(); roof.refresh(); mould.refresh(); cab.refresh(); lbl.refresh(); };
  V.clearSelections = () => { edit.clearSel(); door.clearSel(); win.clearSel(); stair.clearSel(); furn.clearSel(); roof.clearSel(); mould.clearSel(); cab.clearSel(); lbl.clearSel(); select.clearSel(); };

  // ---- Layers panel bridge (§5.2) -----------------------------------------
  // Each domain maps to: its owning mode, the tool that owns its selection, and
  // the V.meshes key suffixes to toggle for the eye icon. (mouldings/cabinets are
  // Phase 4/5 — listed so the table is the single source of truth.)
  const DOMAINS: Record<string, any> = {
    rooms:     { mode: "layout",    tool: null,  meshes: ["floor"] },
    doors:     { mode: "doors",     tool: door,  meshes: ["door", "doorglass", "arc"] },
    windows:   { mode: "windows",   tool: win,   meshes: ["glass"] },
    moulding:  { mode: "moulding",  tool: mould, meshes: ["mld"] },
    cabinets:  { mode: "cabinets",  tool: cab,   meshes: ["cab"] },
    furniture: { mode: "furniture", tool: furn,  meshes: ["furn"] },
    stairs:    { mode: "structure", tool: stair, meshes: ["stair"] },
    roof:      { mode: "structure", tool: roof,  meshes: ["roof", "roofglass"] },
    labels:    { mode: "labels",    tool: lbl,   meshes: [] },   // no meshes: eye → tool.setVisible
  };
  // Switch to the owning mode then select index i in that domain's tool. Rooms
  // (no tool) select via the unified Select tool. §5.2
  // Every Layers click also jumps the viewport to center on the selection (pan
  // only, zoom/orbit preserved) — without it a sidebar click can be invisible.
  V.selectObject = (kind: any, i: any) => {
    const dom = DOMAINS[kind]; if (!dom) return;
    if (uiMode !== dom.mode) setUiMode(dom.mode);   // clears selections + scopes UI
    if (kind === "rooms") {
      select.selectRoom(i);
      const r = rooms[i];
      if (r && V.centerOn) V.centerOn(r.x + r.w / 2, r.y + r.d / 2, levelZ(r.level) + 0.3);
      return;
    }
    if (dom.tool && dom.tool.select) dom.tool.select(i);
    const b = dom.tool && dom.tool.selBox ? dom.tool.selBox() : null;
    if (b && !b.isEmpty() && V.centerOn) { const c = b.getCenter(new THREE.Vector3()); V.centerOn(c.x, c.y, c.z); }
  };
  // Toggle a domain's meshes + tool markers visible (session-only; not persisted).
  V.setDomainVisible = (kind: any, on: any) => {
    const dom = DOMAINS[kind]; if (!dom) return;
    for (const lvl of [0, 1]) for (const suf of dom.meshes) {
      const m = V.meshes[`${lvl}-${suf}`]; if (m) m.visible = on;
    }
    if (dom.tool && dom.tool.setVisible) dom.tool.setVisible(on);
  };

  $("undo").onclick = undo;
  $("redo").onclick = redo;
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (k === "y") { e.preventDefault(); redo(); }
      // Cmd/Ctrl+D duplicate (§5.3): route to the active tool's selection. We
      // preventDefault even though it collides with the browser's bookmark
      // shortcut — that's acceptable per spec (preventDefault wins).
      else if (k === "d") {
        if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) return;
        e.preventDefault(); duplicateActive();
      }
      return;
    }
    if (e.key.startsWith("Arrow") && !/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) {
      e.preventDefault(); panCamera(e.key);
    }
  });
  // arrow keys pan the camera in its screen plane
  function panCamera(key: any) {
    if (V.fpActive) return;                        // in first-person, arrows walk (handled by the walk tool)
    const cam = V.camera, ctr = V.controls;
    const step = cam.position.distanceTo(ctr.target) * 0.045 + 0.5;
    const fwd = new THREE.Vector3().subVectors(ctr.target, cam.position).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, cam.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const d = new THREE.Vector3();
    if (key === "ArrowLeft") d.copy(right).multiplyScalar(-step);
    else if (key === "ArrowRight") d.copy(right).multiplyScalar(step);
    else if (key === "ArrowUp") d.copy(up).multiplyScalar(step);
    else if (key === "ArrowDown") d.copy(up).multiplyScalar(-step);
    cam.position.add(d); ctr.target.add(d);
  }
  function setMode(m: any) {
    mode = m;
    for (const k of ids) if (btn[k]) btn[k].classList.toggle("active", k === m);
    document.body.classList.toggle("measuring", m === "measure");
    document.body.classList.toggle("editing", m === "edit" || m === "doors" || m === "windows" || m === "stairs" || m === "furniture" || m === "cabinets" || m === "select");
    info.innerHTML = HINTS[m] || "";
    measure.clear();
    edit.setActive(m === "edit");
    door.setActive(m === "doors"); win.setActive(m === "windows"); stair.setActive(m === "stairs"); furn.setActive(m === "furniture"); roof.setActive(m === "roof");
    mould.setActive(m === "moulding");
    cab.setActive(m === "cabinets");
    lbl.setActive(m === "labels");
    // In SELECT mode the door/window/stair/skylight markers stay pickable (so you
    // can click any object) even though those tools aren't "dedicated" — their
    // panels stay hidden until something is selected.
    const sel = m === "select";
    door.setMarkersVisible(sel || m === "doors");
    win.setMarkersVisible(sel || m === "windows");
    stair.setMarkersVisible(sel || m === "stairs");
    furn.setMarkersVisible(sel || m === "furniture");
    roof.setMarkersVisible(sel || m === "roof");
    mould.setMarkersVisible(sel || m === "moulding");
    cab.setMarkersVisible(sel || m === "cabinets");
    lbl.setMarkersVisible(sel || m === "labels");
    select.setActive(sel);
    walk.setActive(m === "walk");                 // first-person: drives V.pcam directly
    if (m !== "edit") edit.clearSel();
    if (m !== "doors" && !sel) door.clearSel();
    if (m !== "windows" && !sel) win.clearSel();
    if (m !== "stairs" && !sel) stair.clearSel();
    if (m !== "furniture" && !sel) furn.clearSel();
    if (m !== "roof" && !sel) roof.clearSel();
    if (m !== "moulding" && !sel) mould.clearSel();
    if (m !== "cabinets" && !sel) cab.clearSel();
    if (m !== "labels" && !sel) lbl.clearSel();
    // roof ghosts while editing OR selecting (so skylights/cuts read); else honor toggle
    V.setRoofView(m === "roof" ? "ghost" : (roofShown ? "solid" : "hidden"));
    updateOrbit();
  }
  V.setMode = setMode;
  for (const k of ids) if (btn[k]) btn[k].onclick = () => setMode(k);

  // ---- mode manager (§3.3) -------------------------------------------------
  // Show only a mode's tool buttons in the bottom toolbar (data-modes on each
  // button). The React toolbar renders ALL buttons once; we hide non-mode ones.
  function applyModeToolbar(m: any) {
    for (const k of ids) {
      const b = btn[k]; if (!b) continue;
      const modes = (b.dataset.modes || "").split(/\s+/);
      b.hidden = !modes.includes(m);
    }
  }
  // Show only inspector subpanels whose data-mode includes the active mode
  // (IN ADDITION TO the existing selection-driven show/hide). Panels not in the
  // mode get .mode-hidden (CSS forces display:none, beating the inline display).
  function applyModePanels(m: any) {
    document.querySelectorAll(".subpanel[data-mode]").forEach((el) => {
      const modes = (el.getAttribute("data-mode") || "").split(/\s+/);
      el.classList.toggle("mode-hidden", !modes.includes(m));
    });
  }
  const modeBar = $("mode-bar");
  function setUiMode(m: any) {
    if (!MODES[m]) return;
    uiMode = m;
    if (modeBar) modeBar.querySelectorAll(".tool").forEach((s: any) => s.classList.toggle("active", s.dataset.mode === m));
    applyModeToolbar(m);
    applyModePanels(m);
    V.clearSelections && V.clearSelections();    // selections belong to the old mode
    const tools = MODES[m].tools;
    // keep the active tool if it belongs to the new mode; else use the default.
    setMode(tools.includes(mode) ? mode : tools[0]);
    // focus dimming: roof hidden in domain modes; setMode already set the roof view,
    // so override here for the hidden modes (and let applyFocus dim the rest).
    applyFocus(MODES[m].focus || {});
    if (MODE_ROOF_HIDDEN.has(m)) V.setRoofView("hidden");
    // Labels mode force-shows the label host (regardless of #t-labels) so labels
    // are visible + editable; leaving restores the checkbox's current state.
    if (V.labelHost) {
      const tl = $("t-labels");
      V.labelHost.style.display = (m === "labels" || (tl && tl.checked)) ? "block" : "none";
    }
  }
  V.setUiMode = setUiMode;
  V.getUiMode = () => uiMode;
  if (modeBar) modeBar.querySelectorAll(".tool").forEach((s: any) => (s.onclick = () => setUiMode(s.dataset.mode)));

  // ---- global keyboard (§3.3 / §5.5) --------------------------------------
  // Digits 1–8 switch MODES; letter keys switch the TOOL within the current mode.
  // Modes by digit, in mode-bar order.
  const MODE_KEYS: Record<string, string> = { 1: "layout", 2: "doors", 3: "windows", 4: "moulding", 5: "cabinets", 6: "furniture", 7: "structure", 8: "tour", 9: "labels" };
  // tool name → the tool object that owns its selection (for the precedence rule).
  const TOOL_OBJ: Record<string, any> = { edit, doors: door, windows: win, moulding: mould, cabinets: cab, stairs: stair, furniture: furn, roof, labels: lbl };
  // Cmd/Ctrl+D (§5.3): duplicate the ACTIVE tool's selection. In a dedicated
  // domain mode the active tool is `mode`; in Select mode the selection lives in
  // a sub-tool, so duplicate whichever sub-tool currently has one.
  function duplicateActive() {
    const direct = TOOL_OBJ[mode];
    if (direct && direct.duplicateSel && direct.hasSel && direct.hasSel()) { direct.duplicateSel(); return; }
    if (mode === "select") {
      for (const t of [door, win, stair, furn, cab, roof, lbl]) {
        if (t.duplicateSel && t.hasSel && t.hasSel()) { t.duplicateSel(); return; }
      }
    }
  }
  V.duplicateActive = duplicateActive;
  // Zoom-to-selection bounds (§5.4): union the selBox of every tool that has a
  // selection (walls/edit handled via its selected nodes). Null when nothing.
  V.selectionBox = () => {
    const box = new THREE.Box3();
    for (const t of [door, win, mould, cab, stair, furn, roof, lbl]) {
      const b = t.selBox && t.selBox(); if (b) box.union(b);
    }
    if (edit.selectedNodes) for (const ni of edit.selectedNodes()) {
      const n = graph.nodes[ni]; if (!n) continue;
      const z = levelZ(n.level);
      box.expandByPoint(new THREE.Vector3(n.x, n.y, z));
      box.expandByPoint(new THREE.Vector3(n.x, n.y, z + wallH));
    }
    return box.isEmpty() ? null : box;
  };
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;                 // Cmd/Ctrl handled elsewhere (undo/redo)
    if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) return;     // don't hijack typing
    // digits 1–8 → switch mode
    if (MODE_KEYS[e.key]) { e.preventDefault(); setUiMode(MODE_KEYS[e.key]); return; }
    const k = e.key.toLowerCase();
    const tool = TOOL_KEYS[k];
    if (!tool) return;
    // M activates Measure in ANY mode that includes it (one-shot overlay tool):
    // temporarily switch to measure without changing the mode (§3.1).
    if (k === "m") { if (MODES[uiMode].tools.includes("measure")) { e.preventDefault(); setMode("measure"); } return; }
    // PRECEDENCE (§3.3): a tool's own onKey wins when the active tool has a
    // selection (e.g. R rotates a selected stair). In SELECT mode the selection
    // lives in a sub-tool (door/window/stair/furn/roof), whose onKey also fires
    // while `mode === "select" && sel.size` — so defer if ANY sub-tool is
    // selected too. Only switch tools when nothing is selected AND the target
    // tool belongs to the current mode.
    const hasAnySel = (mode === "select")
      ? Object.values(TOOL_OBJ).some((t) => t.hasSel && t.hasSel())
      : !!(TOOL_OBJ[mode] && TOOL_OBJ[mode].hasSel && TOOL_OBJ[mode].hasSel());
    if (hasAnySel) return;                          // let the owning tool's onKey handle it
    if (MODES[uiMode].tools.includes(tool)) { e.preventDefault(); setMode(tool); }
  });

  // Zoom shortcuts (§5.4): Shift+1 fit, Shift+2 selection. Use e.code so the
  // shifted glyph ("!"/"@") doesn't matter, and don't fire while typing.
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !e.shiftKey) return;
    if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) return;
    if (e.code === "Digit1") { e.preventDefault(); V.zoomToFit && V.zoomToFit(); }
    else if (e.code === "Digit2") { e.preventDefault(); V.zoomToSelection && V.zoomToSelection(); }
  });

  // Hold Space to orbit with LEFT-drag (and release to go back to selecting).
  addEventListener("keydown", (e) => {
    if (e.code === "Space" && !spaceHeld && !/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) {
      spaceHeld = true; updateOrbit(); document.body.classList.add("orbiting"); e.preventDefault();
    }
  });
  addEventListener("keyup", (e) => {
    if (e.code === "Space") { spaceHeld = false; updateOrbit(); document.body.classList.remove("orbiting"); }
  });

  const dom = V.renderer.domElement;
  const route = (which: any, e: any) => {
    if (mode === "select") return (select as any)[which](e);
    if (mode === "walk") return (walk as any)[which](e);
    if (mode === "measure" && which === "onDown") return measure.onDown(e);
    if (mode === "edit") return (edit as any)[which](e);
    if (mode === "doors") return (door as any)[which](e);
    if (mode === "windows") return (win as any)[which](e);
    if (mode === "moulding") return (mould as any)[which](e);
    if (mode === "cabinets") return (cab as any)[which](e);
    if (mode === "stairs") return (stair as any)[which](e);
    if (mode === "furniture") return (furn as any)[which](e);
    if (mode === "roof") return (roof as any)[which](e);
    if (mode === "labels") return (lbl as any)[which](e);
  };
  dom.addEventListener("pointerdown", (e: any) => { if (e.button === 0) route("onDown", e); });
  const trackCursor = (e: any) => { cursorPx.x = e.clientX; cursorPx.y = e.clientY; cursorPx.inside = true; };
  dom.addEventListener("pointermove", (e: any) => { trackCursor(e); route("onMove", e); });
  dom.addEventListener("pointerenter", trackCursor);
  dom.addEventListener("pointerleave", () => { cursorPx.inside = false; });
  addEventListener("pointerup", (e) => route("onUp", e));
  dom.addEventListener("dblclick", (e: any) => { if (mode === "edit") edit.onDblClick(e); });
  V.updateOverlays = () => { measure.update(); edit.update(); door.update(); win.update(); mould.update(); cab.update(); stair.update(); furn.update(); roof.update(); lbl.update(); walk.update(); };

  // ---- unified Select tool: click ANY object → properties panel ----
  function setupSelect(info: any, sub: any) {
    const { door, win, stair, furn, roof, mould, cab, lbl } = sub;
    const hl = new THREE.Group(); V.scene.add(hl);
    const wallLineMat = new THREE.LineBasicMaterial({ color: 0xff8c42 });
    const roomLineMat = new THREE.LineBasicMaterial({ color: 0x6ea8fe });
    let active: any = null;                       // sub-tool owning the current drag
    const PANELS = ["door-controls", "window-controls", "moulding-controls", "cabinet-controls", "stairs-controls", "furniture-controls", "roof-controls", "label-controls", "wall-controls", "room-controls"];
    const showOnly = (id: any) => {
      for (const p of PANELS) { const el = $(p); if (el) el.style.display = p === id ? "block" : "none"; }
      const hint = $("sel-empty"); if (hint) hint.style.display = id ? "none" : "block";
    };
    const clearHL = () => hl.clear();
    function clearSel() {
      clearHL(); active = null;
      door.clearSel(); win.clearSel(); mould.clearSel(); cab.clearSel(); stair.clearSel(); furn.clearSel(); roof.clearSel(); lbl.clearSel();
      showOnly(null);
    }
    function setActive(on: any) { if (!on) clearSel(); else showOnly(null); }
    const txt = (id: any, v: any) => { const el = $(id); if (el) el.textContent = v; };

    function selectWall(wi: any, level: any) {
      door.clearSel(); win.clearSel(); mould.clearSel(); cab.clearSel(); stair.clearSel(); furn.clearSel(); roof.clearSel(); clearHL();
      const w = graph.walls[wi], a = graph.nodes[w.a], b = graph.nodes[w.b];
      const z = levelZ(level) + 0.07;
      hl.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
        [new THREE.Vector3(a.x, a.y, z), new THREE.Vector3(b.x, b.y, z)]), wallLineMat));
      const len = ftIn(Math.hypot(b.x - a.x, b.y - a.y)).split("  ")[0];
      txt("wall-len", len); txt("wall-level", level === 1 ? "Main level" : "Lower level");
      // "✎ Edit points" is layout-only; in doors mode show an "Add door — D" hint
      // instead (§3.3 item 6). Other domain modes show neither affordance.
      const editBtn = $("wall-edit-points");
      const modeHint = $("wall-mode-hint");
      if (editBtn) editBtn.style.display = uiMode === "layout" ? "block" : "none";
      if (modeHint) {
        if (uiMode === "doors") { modeHint.textContent = "Add door — D"; modeHint.style.display = "block"; }
        else modeHint.style.display = "none";
      }
      showOnly("wall-controls"); info.innerHTML = `Wall · <span class="reading">${len}</span>`;
    }
    function selectRoom(ri: any) {
      door.clearSel(); win.clearSel(); mould.clearSel(); cab.clearSel(); stair.clearSel(); furn.clearSel(); roof.clearSel(); clearHL();
      const r = rooms[ri];
      const poly = (roomLoops[ri] || []).map((ni) => graph.nodes[ni]).filter(Boolean);
      const z = levelZ(r.level) + 0.08;
      if (poly.length >= 3) {
        const pts = poly.map((p) => new THREE.Vector3(p.x, p.y, z)); pts.push(pts[0].clone());
        hl.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), roomLineMat));
      }
      const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
      const w = xs.length ? Math.max(...xs) - Math.min(...xs) : r.w;
      const d = ys.length ? Math.max(...ys) - Math.min(...ys) : r.d;
      const area = poly.length >= 3 ? polyArea(poly.map((p) => [p.x, p.y])) : r.w * r.d;
      txt("room-name", r.name); txt("room-level", r.level === 1 ? "Main level" : "Lower level");
      txt("room-dims", `${ftIn(w).split("  ")[0]} × ${ftIn(d).split("  ")[0]}`);
      txt("room-area", `${area.toFixed(0)} ft²`);
      const sw = $("room-color"); if (sw) sw.style.background = r.color;
      showOnly("room-controls"); info.innerHTML = `Room · <b>${r.name}</b>`;
    }
    function roomAt(x: any, y: any, level: any) {
      let best = -1, bestA = Infinity;
      rooms.forEach((r, i) => {
        if (r.level !== level) return;
        const rp = (roomLoops[i] || []).map((ni) => graph.nodes[ni]).filter(Boolean).map((p) => [p.x, p.y]);
        if (rp.length >= 3 && inPoly([x, y], rp)) { const a = polyArea(rp); if (a < bestA) { bestA = a; best = i; } }
      });
      return best;
    }
    function onDown(e: any) {
      if (spaceHeld) return;                 // Space → orbit, not select
      if (door.pickSelect(e)) { active = door; showOnly("door-controls"); return; }
      if (win.pickSelect(e)) { active = win; showOnly("window-controls"); return; }
      if (stair.pickSelect(e)) { active = stair; showOnly("stairs-controls"); return; }
      if (furn.pickSelect(e)) { active = furn; showOnly("furniture-controls"); return; }
      if (cab.pickSelect(e)) { active = cab; showOnly("cabinet-controls"); return; }
      if (roof.pickSelect(e)) { active = roof; showOnly("roof-controls"); return; }
      if (mould.pickSelect(e)) { active = mould; showOnly("moulding-controls"); return; }
      const hit = pickMeshes(e);
      if (!hit) { clearSel(); info.innerHTML = HINTS.select; return; }
      const level = hit.object.userData.level ?? (hit.point.z < levelSplitZ() ? 0 : 1);
      if (!levelVisible(level)) { clearSel(); return; }
      const nw = nearestWall(graph, hit.point.x, hit.point.y, level);
      if (nw && nw.dist < 0.7) { selectWall(nw.wall, level); return; }
      const ri = roomAt(hit.point.x, hit.point.y, level);
      if (ri >= 0) { selectRoom(ri); return; }
      clearSel(); info.innerHTML = HINTS.select;
    }
    function onMove(e: any) { if (active) active.onMove(e); }
    function onUp(e: any) { if (active) { active.onUp(e); active = null; } }
    // programmatic room/wall selection for the Layers panel (§5.2)
    function selectRoomByIndex(i: any) { if (i >= 0 && i < rooms.length) selectRoom(i); }
    return { onDown, onMove, onUp, update: () => {}, setActive, clearSel, refresh: () => {}, selectRoom: selectRoomByIndex };
  }

  // Open in Layout mode (§3.1): initialises the mode bar, toolbar visibility,
  // inspector panel gating, focus, AND the default tool (Select). uiMode is
  // session-only — the editor always opens in Layout, never persisted.
  setUiMode("layout");
}

// --- Measure ---------------------------------------------------------------
function setupMeasure(info: any) {
  const grp = new THREE.Group(); V.scene.add(grp);
  const dotGeo = new THREE.SphereGeometry(0.45, 16, 12);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xffd479 });
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffd479 });
  const label = document.createElement("div"); label.className = "mlabel"; label.style.display = "none";
  V.overlayHost.appendChild(label);   // always-visible overlay (not tied to the room-labels toggle)
  let pts: any = [];
  const clear = () => { pts = []; grp.clear(); label.style.display = "none"; };
  function onDown(e: any) {
    const hit = pickMeshes(e); if (!hit) return;
    if (pts.length === 2) clear();
    pts.push(hit.point.clone());
    const dot = new THREE.Mesh(dotGeo, dotMat); dot.position.copy(hit.point); grp.add(dot);
    if (pts.length === 2) {
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
      info.innerHTML = `Distance: <span class="reading">${ftIn(pts[0].distanceTo(pts[1]))}</span>`;
    } else info.innerHTML = "Start point set — click the end point.";
  }
  const mid = new THREE.Vector3();
  function update() {
    if (pts.length !== 2) return;
    mid.copy(pts[0]).add(pts[1]).multiplyScalar(0.5).project(V.camera);
    const w = V.renderer.domElement.clientWidth, h = V.renderer.domElement.clientHeight;
    label.style.display = mid.z > 1 ? "none" : "";
    label.style.left = (mid.x * 0.5 + 0.5) * w + "px";
    label.style.top = (-mid.y * 0.5 + 0.5) * h + "px";
    label.textContent = ftIn(pts[0].distanceTo(pts[1])).split("  ")[0];
  }
  return { onDown, update, clear };
}

// --- Walls: drag NODE endpoints (realtime) --------------------------------
function setupEdit(info: any) {
  const handles = new THREE.Group(); handles.visible = false; V.scene.add(handles); registerHandles(handles);
  const dotGeo = new THREE.SphereGeometry(0.75, 18, 12);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0x6ea8fe });    // default
  const dotHover = new THREE.MeshBasicMaterial({ color: 0xffd479 });  // hover
  const dotSel = new THREE.MeshBasicMaterial({ color: 0xff8c42 });    // selected
  const selected = new Set<number>();                                 // selected node indices

  // marquee box (HTML overlay)
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;border:1px solid #6ea8fe;background:rgba(110,168,254,.15);pointer-events:none;display:none;z-index:50";
  document.body.appendChild(box);

  // Wall-push highlight: the colinear run that would move if you grabbed the
  // hovered (or dragged) wall — drawn as fat lines over those segments.
  const wallHi = new THREE.Group(); V.scene.add(wallHi);
  const wallHiMat = new THREE.LineBasicMaterial({ color: 0xff8c42, linewidth: 3 });
  let hoverWall: any = null;                                     // wall index armed for push, or null
  function clearWallHi() { for (const c of wallHi.children) (c as any).geometry.dispose(); wallHi.clear(); }
  function showWallHi(wi: any) {
    clearWallHi();
    if (wi == null || !graph.walls[wi]) return;
    const lvl = graph.walls[wi].level, set = new Set(collinearNodes(graph, wi));
    const z = levelZ(lvl) + wallH / 2 + 0.05;
    for (const w of graph.walls) {                          // every segment fully on the line = the run
      if (w.level !== lvl || !set.has(w.a) || !set.has(w.b)) continue;
      const a = graph.nodes[w.a], b = graph.nodes[w.b];
      wallHi.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
        [new THREE.Vector3(a.x, a.y, z), new THREE.Vector3(b.x, b.y, z)]), wallHiMat));
    }
  }

  function rebuildHandles() {
    handles.clear();
    unpin();                                                 // indices may have shifted (undo/load/split)
    graph.nodes.forEach((n, i) => { const d = new THREE.Mesh(dotGeo, dotMat); d.userData.ni = i; handles.add(d); });
    placeHandles(); colorHandles();
  }
  const place = (m: any) => { const n = graph.nodes[m.userData.ni]; if (!n) { m.visible = false; return; } m.position.set(n.x, n.y, levelZ(n.level) + wallH / 2); m.visible = levelVisible(n.level); };
  function placeHandles() { handles.children.forEach(place); }
  function colorHandles() {
    for (const h of handles.children) (h as any).material = selected.has(h.userData.ni) ? dotSel : (h === hover ? dotHover : dotMat);
    const ec = $("edit-controls"), sc = $("sel-count");
    if (sc) sc.textContent = `${selected.size} selected`;
    $("weld-sel")?.classList.toggle("disabled", selected.size < 2);
    $("del-sel")?.classList.toggle("disabled", selected.size < 1);
    const align2 = selected.size < 2, dist3 = selected.size < 3;   // align needs ≥2 pts, distribute ≥3
    for (const id of ["align-left", "align-hcenter", "align-right", "align-top", "align-vcenter", "align-bottom"])
      $(id)?.classList.toggle("disabled", align2);
    $("dist-h")?.classList.toggle("disabled", dist3);
    $("dist-v")?.classList.toggle("disabled", dist3);
    if (ec) ec.style.display = handles.visible ? "block" : "none";
  }
  function setActive(on: any) { handles.visible = on; unpin(); if (!on) { clearHover(); clearWallHi(); hoverWall = null; $("edit-controls").style.display = "none"; } else { placeHandles(); colorHandles(); } }
  function clearSel() { selected.clear(); colorHandles(); }

  let hover: any = null, drag: any = null;
  const plane = new THREE.Plane(), hit = new THREE.Vector3(), tmp = new THREE.Vector3();
  function clearHover() { const h = hover; hover = null; if (h) colorHandles(); }
  const pickNode = (e: any) => (ray.setFromCamera(pointerNDC(e), V.camera),
    ray.intersectObjects(handles.children.filter((h) => h.visible), false)[0]?.object || null);
  // screen-space position of a node (for marquee hit-test)
  function nodeScreen(ni: any) {
    const n = graph.nodes[ni]; const r = V.renderer.domElement.getBoundingClientRect();
    tmp.set(n.x, n.y, levelZ(n.level) + wallH / 2).project(V.camera);
    return { x: r.left + (tmp.x * 0.5 + 0.5) * r.width, y: r.top + (-tmp.y * 0.5 + 0.5) * r.height, z: tmp.z };
  }

  // --- live dimensions: distance from a dragged node to the nearest wall in
  // each cardinal direction (CAD-style smart guides while moving). Double-click
  // a node to PIN its dimensions: they stay after the drag and each label can
  // be clicked to type an exact ft-in distance (the node moves along that ray).
  const dimGrp = new THREE.Group(); V.scene.add(dimGrp);
  const dimMat = new THREE.LineBasicMaterial({ color: 0x6ea8fe });
  let pinned: any = null;                                        // node index with pinned dims, or null
  let dimEdit: any = null;                                       // { i, cancel } while a label input is open
  const dimInfo: any[] = [null, null, null, null];          // per-label {dx,dy,t} for click-to-edit
  const dimLabels = [0, 1, 2, 3].map((i) => {
    const el = document.createElement("div"); el.className = "dimlabel"; el.style.display = "none";
    el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    el.addEventListener("click", () => beginDimEdit(i));
    V.overlayHost.appendChild(el); return el;
  });
  function rayHit(px: any, py: any, dx: any, dy: any, A: any, B: any) {                  // ray (P,d) vs segment AB → {t,x,y} or null
    const ex = B.x - A.x, ey = B.y - A.y, det = dx * -ey - -ex * dy;
    if (Math.abs(det) < 1e-9) return null;
    const rx = A.x - px, ry = A.y - py;
    const t = (rx * -ey - -ex * ry) / det, u = (dx * ry - dy * rx) / det;
    return (t > 1e-3 && u >= -1e-6 && u <= 1 + 1e-6) ? { t, x: px + dx * t, y: py + dy * t } : null;
  }
  function clearDimLines() { for (const c of dimGrp.children) (c as any).geometry.dispose(); dimGrp.clear(); }
  function hideDims() { clearDimLines(); dimLabels.forEach((l) => { l.style.display = "none"; l.classList.remove("pinned"); }); }
  function unpin() { pinned = null; if (dimEdit) dimEdit.cancel(); hideDims(); }
  function showDims(ni: any) {
    clearDimLines();
    const n = graph.nodes[ni]; if (!n) return;
    const z = levelZ(n.level) + wallH / 2, w = V.renderer.domElement.clientWidth, h = V.renderer.domElement.clientHeight;
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy], i) => {
      let best: any = null;
      for (const wl of graph.walls) {
        if (wl.level !== n.level || wl.a === ni || wl.b === ni) continue;   // skip incident walls
        const A = graph.nodes[wl.a], B = graph.nodes[wl.b]; if (!A || !B) continue;
        const hh = rayHit(n.x, n.y, dx, dy, A, B);
        if (hh && (!best || hh.t < best.t)) best = hh;
      }
      const el = dimLabels[i];
      if (best && best.t > 0.15 && best.t < 80) {
        dimGrp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
          [new THREE.Vector3(n.x, n.y, z), new THREE.Vector3(best.x, best.y, z)]), dimMat));
        tmp.set((n.x + best.x) / 2, (n.y + best.y) / 2, z).project(V.camera);
        el.style.display = tmp.z > 1 ? "none" : "";
        el.textContent = ftIn(best.t).split("  ")[0];
        el.style.left = (tmp.x * 0.5 + 0.5) * w + "px"; el.style.top = (-tmp.y * 0.5 + 0.5) * h + "px";
        el.classList.toggle("pinned", pinned === ni);
        dimInfo[i] = { dx, dy, t: best.t };
      } else { el.style.display = "none"; el.classList.remove("pinned"); dimInfo[i] = null; }
    });
  }
  // Click a pinned label → swap it for a text input; Enter applies (parseFeet:
  // 3'6", 42", 3.5 …), Escape cancels. The node slides along the dim's ray so
  // the typed distance to the hit wall holds exactly.
  function beginDimEdit(i: any) {
    const d = dimInfo[i];
    if (pinned == null || dimEdit || !d || !graph.nodes[pinned]) return;
    const el = dimLabels[i];
    const inp = document.createElement("input");
    inp.className = "dimedit"; inp.value = ftIn(d.t).split("  ")[0];
    inp.style.width = (inp.value.length + 2) + "ch";
    el.textContent = ""; el.appendChild(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = (apply: any) => {
      if (done) return; done = true; dimEdit = null;
      const v = apply ? parseFeet(inp.value) : null;
      inp.remove();
      if (v != null && v > 0.05 && Math.abs(v - d.t) > 1e-4 && graph.nodes[pinned]) {
        const pi = pinned;                                       // refreshEditors→rebuildHandles unpins;
        const ddx = d.dx * (d.t - v), ddy = d.dy * (d.t - v);   // hit wall stays put; node slides on the ray
        const ids = selected.has(pinned) ? [...selected] : [pinned];
        for (const ni of ids) { graph.nodes[ni].x += ddx; graph.nodes[ni].y += ddy; }
        rebuildWalls(); placeHandles(); V.wallsDirty = true; V.refreshEditors && V.refreshEditors();
        commit("Set dimension");
        pinned = pi;                                             // …re-pin: a dim edit keeps indices stable
      }
      if (pinned != null) showDims(pinned);
    };
    dimEdit = { i, cancel: () => finish(false) };
    inp.addEventListener("keydown", (ev) => {
      ev.stopPropagation();                                  // keep Delete/Escape from hitting onKey
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    });
    inp.addEventListener("blur", () => finish(true));
    inp.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  }

  function startGroupDrag(e: any, primary: any) {
    V.controls.enableRotate = false;
    clearWallHi(); hoverWall = null;
    const z = levelZ(graph.nodes[primary].level) + wallH / 2;
    plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, z));
    ray.setFromCamera(pointerNDC(e), V.camera); ray.ray.intersectPlane(plane, hit);
    const n0: Record<number, any> = {}; for (const ni of selected) n0[ni] = { x: graph.nodes[ni].x, y: graph.nodes[ni].y };
    if (pinned != null && pinned !== primary) unpin();       // pin follows one node at a time
    drag = { kind: "move", primary, start: { x: hit.x, y: hit.y }, n0, moved: false, added: false };
  }
  // Grab a WALL body and push it: the whole colinear run (its endpoints + every
  // node on the same line) translates PERPENDICULAR to the wall, so the wall
  // shifts in/out and the perpendicular walls meeting it stretch to follow.
  // `t0` is where on the wall it was grabbed — used to add a control point if the
  // gesture turns out to be a click (no drag) instead of a push.
  function startWallPush(e: any, wi: any, t0: any) {
    V.controls.enableRotate = false;
    const lvl = graph.walls[wi].level, z = levelZ(lvl) + wallH / 2;
    plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, z));
    ray.setFromCamera(pointerNDC(e), V.camera); ray.ray.intersectPlane(plane, hit);
    const [nx, ny] = wallNormal(graph, wi);
    const ids = collinearNodes(graph, wi);
    const n0: Record<number, any> = {}; for (const ni of ids) n0[ni] = { x: graph.nodes[ni].x, y: graph.nodes[ni].y };
    showWallHi(wi); hoverWall = wi;
    drag = { kind: "pushwall", wi, t0, nx, ny, ids, n0, start: { x: hit.x, y: hit.y }, moved: false };
  }
  function deleteSelected() {                                // delete every selected point → holes
    if (!selected.size) return;
    unpin();                                                 // node indices remap below
    let ids = [...selected];
    while (ids.length) {                                     // remap remaining ids after each delete (orphan pruning shifts indices)
      const ni = ids.pop()!;
      const r = deleteNode(graph, doors, ni);
      graph.nodes = r.nodes; graph.walls = r.walls; doors = r.doors; roomLoops = remapLoops(roomLoops, r.nodeMap);
      ids = ids.map((i) => r.nodeMap[i]).filter((i) => i != null && i >= 0);
    }
    selected.clear();
    rebuildWalls(); rebuildHandles(); V.refreshEditors && V.refreshEditors(); commit("Delete points");
  }
  function weldSelected() {
    if (selected.size < 2) return;
    unpin();                                                 // node indices remap below
    const r = weldGroup(graph, doors, [...selected]);
    graph.nodes = r.nodes; graph.walls = r.walls; doors = r.doors; roomLoops = remapLoops(roomLoops, r.nodeMap);
    selected.clear(); selected.add(r.target);
    rebuildWalls(); rebuildHandles(); V.refreshEditors && V.refreshEditors(); commit("Weld " + r.nodeMap.length + " points");
  }
  // Figma-style align: snap every selected node's x (axis 0) or y (axis 1) to the
  // selection's min / center / max edge. center = midpoint of the bounding extent.
  function alignSelected(axis: any, edge: any) {
    if (selected.size < 2) return;
    const k = axis === 0 ? "x" : "y";
    const ids = [...selected];
    let lo = Infinity, hi = -Infinity;
    for (const ni of ids) { const v = graph.nodes[ni][k]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const target = edge === "min" ? lo : edge === "max" ? hi : (lo + hi) / 2;
    for (const ni of ids) graph.nodes[ni][k] = target;
    rebuildWalls(); placeHandles(); V.wallsDirty = true; V.refreshEditors && V.refreshEditors();
    const names: Record<string, Record<string, string>> = { x: { min: "left", mid: "horizontal centers", max: "right" }, y: { min: "bottom", mid: "vertical centers", max: "top" } };
    commit("Align " + names[k][edge]);
  }
  // Distribute: even out spacing between the extreme nodes along axis (0=x, 1=y).
  function distributeSelected(axis: any) {
    if (selected.size < 3) return;
    const k = axis === 0 ? "x" : "y";
    const ids = [...selected].sort((a, b) => graph.nodes[a][k] - graph.nodes[b][k]);
    const lo = graph.nodes[ids[0]][k], hi = graph.nodes[ids[ids.length - 1]][k];
    const step = (hi - lo) / (ids.length - 1);
    ids.forEach((ni, i) => { graph.nodes[ni][k] = lo + step * i; });
    rebuildWalls(); placeHandles(); V.wallsDirty = true; V.refreshEditors && V.refreshEditors();
    commit("Distribute " + (axis === 0 ? "horizontally" : "vertically"));
  }

  function onMove(e: any) {
    if (drag && drag.kind === "move") {
      ray.setFromCamera(pointerNDC(e), V.camera);
      if (!ray.ray.intersectPlane(plane, hit)) return;
      let dx = hit.x - drag.start.x, dy = hit.y - drag.start.y;
      if (gridSize > 0) {                                    // snap the primary node's resulting position
        const p = drag.n0[drag.primary];
        dx = snap(p.x + dx, gridSize) - p.x; dy = snap(p.y + dy, gridSize) - p.y;
      }
      for (const ni of selected) { graph.nodes[ni].x = drag.n0[ni].x + dx; graph.nodes[ni].y = drag.n0[ni].y + dy; }
      if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) drag.moved = true;
      placeHandles(); V.wallsDirty = true;
      showDims(drag.primary);                      // live distances to nearby walls
      info.innerHTML = `Move ${selected.size}: <span class="reading">${dx >= 0 ? "+" : ""}${dx.toFixed(1)}, ${dy >= 0 ? "+" : ""}${dy.toFixed(1)} ft</span>`;
      return;
    }
    if (drag && drag.kind === "pushwall") {
      ray.setFromCamera(pointerNDC(e), V.camera);
      if (!ray.ray.intersectPlane(plane, hit)) return;
      let off = (hit.x - drag.start.x) * drag.nx + (hit.y - drag.start.y) * drag.ny;  // perp component
      if (gridSize > 0) off = snap(off, gridSize);
      const ox = drag.nx * off, oy = drag.ny * off;
      for (const ni of drag.ids) { graph.nodes[ni].x = drag.n0[ni].x + ox; graph.nodes[ni].y = drag.n0[ni].y + oy; }
      if (Math.abs(off) > 0.02) drag.moved = true;
      placeHandles(); showWallHi(drag.wi); V.wallsDirty = true;
      info.innerHTML = `Push wall <span class="reading">${off >= 0 ? "+" : ""}${off.toFixed(2)} ft</span> · ${drag.ids.length} pts move`;
      return;
    }
    if (drag && drag.kind === "marquee") {
      const x0 = Math.min(drag.sx, e.clientX), y0 = Math.min(drag.sy, e.clientY);
      box.style.left = x0 + "px"; box.style.top = y0 + "px";
      box.style.width = Math.abs(e.clientX - drag.sx) + "px"; box.style.height = Math.abs(e.clientY - drag.sy) + "px";
      return;
    }
    const m = pickNode(e);
    if (m !== hover) { hover = m; colorHandles(); }
    // Hovering a wall body (not a node) arms the push gesture — highlight its run.
    let wi = null;
    if (!m) {
      const hp = pickMeshes(e);
      if (hp) {
        const level = hp.object.userData.level ?? (hp.point.z < levelSplitZ() ? 0 : 1);
        const nw = levelVisible(level) ? nearestWall(graph, hp.point.x, hp.point.y, level) : null;
        if (nw && nw.dist < 1.0) wi = nw.wall;
      }
    }
    if (wi !== hoverWall) { hoverWall = wi; showWallHi(wi); }
  }
  function onDown(e: any) {
    const m = pickNode(e);
    if (m) {
      const ni = m.userData.ni;
      if (e.altKey) { selected.clear(); selected.add(ni); deleteSelected(); return; }
      if (e.shiftKey) { selected.has(ni) ? selected.delete(ni) : selected.add(ni); colorHandles(); return; }
      if (!selected.has(ni)) { selected.clear(); selected.add(ni); colorHandles(); }
      startGroupDrag(e, ni);
      return;
    }
    // empty space: marquee select (or split a wall if clicked on one)
    const hp = pickMeshes(e);
    if (hp) {
      // level comes from the hit mesh, never z — stacked floors overlap in z, so
      // a z-threshold can resolve to the hidden floor. Picks are floor-filtered.
      const level = hp.object.userData.level ?? (hp.point.z < levelSplitZ() ? 0 : 1);
      const nw = levelVisible(level) ? nearestWall(graph, hp.point.x, hp.point.y, level) : null;
      if (nw && nw.dist < 1.0 && e.altKey === false && e.shiftKey === false) {   // on a wall body
        // Grab the wall: drag PUSHES the whole colinear run; a click (no drag)
        // adds a control point at the grab spot (handled in onUp).
        startWallPush(e, nw.wall, Math.max(0.06, Math.min(0.94, nw.t)));
        return;
      }
    }
    clearWallHi(); hoverWall = null;
    drag = { kind: "marquee", sx: e.clientX, sy: e.clientY, shift: e.shiftKey };
    box.style.left = e.clientX + "px"; box.style.top = e.clientY + "px"; box.style.width = "0px"; box.style.height = "0px"; box.style.display = "block";
  }
  function onDblClick(e: any) {                                   // double-click a node → pin its dims
    const m = pickNode(e);
    if (m) {
      pinned = m.userData.ni;
      if (!selected.has(pinned)) { selected.clear(); selected.add(pinned); colorHandles(); }
      showDims(pinned);
      info.innerHTML = `Dimensions pinned — click a measurement to type a value, <span class="reading">Esc</span> to dismiss`;
    } else if (pinned != null) unpin();
  }
  function onUp(e: any) {
    if (!drag) return;
    const d = drag; drag = null; updateOrbit();
    if (pinned != null) showDims(pinned); else hideDims();   // pinned dims survive the drag
    if (d.kind === "move") {
      if (d.added) commit("Add control point");
      else if (d.moved) commit(selected.size > 1 ? `Move ${selected.size} points` : "Move point");
      return;
    }
    if (d.kind === "pushwall") {
      clearWallHi(); hoverWall = null;
      if (d.moved) {                                         // a real push → wall shifted, commit
        placeHandles(); V.wallsDirty = true; V.refreshEditors && V.refreshEditors();
        commit("Push wall");
      } else {                                               // a click → add a control point (old behavior)
        const r = splitWall(graph, doors, d.wi, d.t0);
        graph.nodes = r.nodes; graph.walls = r.walls; doors = r.doors;
        roomLoops = insertInLoops(roomLoops, r.splitA, r.splitB, r.ni);
        rebuildWalls(); rebuildHandles(); V.refreshEditors && V.refreshEditors();
        selected.clear(); selected.add(r.ni); colorHandles();
        commit("Add control point");
      }
      return;
    }
    // marquee
    box.style.display = "none";
    const x0 = Math.min(d.sx, e.clientX), x1 = Math.max(d.sx, e.clientX);
    const y0 = Math.min(d.sy, e.clientY), y1 = Math.max(d.sy, e.clientY);
    if (x1 - x0 < 3 && y1 - y0 < 3) { if (!d.shift) { clearSel(); unpin(); } return; }   // tiny = click on empty
    if (!d.shift) selected.clear();
    for (const h of handles.children) {
      if (!h.visible) continue;
      const s = nodeScreen(h.userData.ni);
      if (s.z < 1 && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) selected.add(h.userData.ni);
    }
    colorHandles();
  }
  function onKey(e: any) {
    if (mode !== "edit") return;
    if ((e.key === "Delete" || e.key === "Backspace") && (selected.size || hover)) {
      e.preventDefault(); if (!selected.size && hover) selected.add(hover.userData.ni); deleteSelected();
    } else if (e.key === "Escape") { unpin(); clearSel(); }
  }
  addEventListener("keydown", onKey);
  function update() {
    if (!handles.visible) return;
    placeHandles();
    if (pinned != null && !dimEdit && !drag) showDims(pinned);   // keep pinned dims tracking the camera
  }

  $("weld-sel").onclick = () => weldSelected();
  $("del-sel").onclick = () => deleteSelected();
  // align bar (x-axis = left/center/right, y-axis = top/center/bottom)
  $("align-left").onclick = () => alignSelected(0, "min");
  $("align-hcenter").onclick = () => alignSelected(0, "mid");
  $("align-right").onclick = () => alignSelected(0, "max");
  $("align-bottom").onclick = () => alignSelected(1, "min");
  $("align-vcenter").onclick = () => alignSelected(1, "mid");
  $("align-top").onclick = () => alignSelected(1, "max");
  $("dist-h").onclick = () => distributeSelected(0);
  $("dist-v").onclick = () => distributeSelected(1);

  rebuildHandles();
  V.edit = { get graph() { return graph; }, selected,
    moveNode: (ni: any, x: any, y: any) => { graph.nodes[ni].x = x; graph.nodes[ni].y = y; rebuildWalls(); placeHandles(); commit("Move endpoint"); },
    split: (wi: any, t: any) => { const r = splitWall(graph, doors, wi, t); graph.nodes = r.nodes; graph.walls = r.walls; doors = r.doors; roomLoops = insertInLoops(roomLoops, r.splitA, r.splitB, r.ni); rebuildWalls(); rebuildHandles(); V.refreshEditors && V.refreshEditors(); commit("Add control point"); return r.ni; },
    select: (ids: any) => { selected.clear(); for (const i of ids) selected.add(i); colorHandles(); },
    weldSelected, deleteSelected, alignSelected, distributeSelected,
    weld: (from: any, to: any) => { const r = weldNodes(graph, doors, from, to); graph.nodes = r.nodes; graph.walls = r.walls; doors = r.doors; roomLoops = remapLoops(roomLoops, r.nodeMap); rebuildWalls(); rebuildHandles(); V.refreshEditors && V.refreshEditors(); commit("Weld endpoints"); } };
  return { onDown, onMove, onUp, onDblClick, update, setActive, refresh: rebuildHandles, clearSel, hasSel: () => selected.size > 0, selectedNodes: () => [...selected] };
}

// --- Doors: place / remove on walls ---------------------------------------
function setupDoors(info: any) {
  const markers = new THREE.Group(); markers.visible = false; V.scene.add(markers); registerHandles(markers);
  const geo = new THREE.SphereGeometry(0.7, 16, 10);
  const mat = new THREE.MeshBasicMaterial({ color: 0x7ee08a });        // default
  const matHover = new THREE.MeshBasicMaterial({ color: 0xffd479 });   // hover
  const matSel = new THREE.MeshBasicMaterial({ color: 0xff8c42 });     // selected
  const selectedDoors = new Set<number>();
  let hover: any = null, drag: any = null, dedicated = false, selVis = false, domVisible = true;
  const plane = new THREE.Plane(), hit = new THREE.Vector3();

  function rebuildMarkers() {
    markers.clear();
    doors.forEach((d, i) => { const m = new THREE.Mesh(geo, mat); m.userData.di = i; markers.add(m); });
    placeMarkers(); colorMarkers();
  }
  function placeMarkers() {
    markers.children.forEach((m) => {
      const d = doors[m.userData.di], wl = d && graph.walls[d.wall];
      if (!wl || !graph.nodes[wl.a] || !graph.nodes[wl.b]) { m.visible = false; return; }
      const p = doorPoint(graph, d);
      m.position.set(p.x, p.y, levelZ(p.level) + wallH / 2);
      m.visible = levelVisible(p.level);
    });
  }
  function colorMarkers() {
    for (const m of markers.children) (m as any).material =selectedDoors.has(m.userData.di) ? matSel : (m === hover ? matHover : mat);
    $("door-count").textContent = countLabel(selectedDoors.size, "door");
    if (typeof syncPanel === "function") syncPanel();   // reflect selection into style/width/color/casing
    $("flip-door")?.classList.toggle("disabled", selectedDoors.size < 1);
    $("flip-hinge")?.classList.toggle("disabled", selectedDoors.size < 1);
    $("del-door")?.classList.toggle("disabled", selectedDoors.size < 1);
    const dc = $("door-controls");
    if (dc) dc.style.display = (markers.visible && (dedicated || selectedDoors.size > 0)) ? "block" : "none";
  }
  function refreshVis() { markers.visible = domVisible && (dedicated || selVis); if (markers.visible) placeMarkers(); else hover = null; colorMarkers(); }
  function setVisible(on: any) { domVisible = on; refreshVis(); }   // §5.2 Layers eye toggle (session-only)
  function setActive(on: any) { dedicated = on; refreshVis(); }
  function setMarkersVisible(on: any) { selVis = on; refreshVis(); }
  function clearSel() { selectedDoors.clear(); colorMarkers(); }
  const pickMarker = (e: any) => (ray.setFromCamera(pointerNDC(e), V.camera),
    ray.intersectObjects(markers.children.filter((m) => m.visible), false)[0]?.object || null);
  // nearest door (by center) to a world point on `level`, within a forgiving
  // radius — lets a click on the door LEAF (not just the marker) select it.
  function nearestDoorIndex(x: any, y: any, level: any) {
    let best = -1, bd = Infinity;
    doors.forEach((d, i) => {
      const wl = graph.walls[d.wall]; if (!wl || wl.level !== level) return;
      const a = graph.nodes[wl.a], b = graph.nodes[wl.b]; if (!a || !b) return;
      const px = a.x + (b.x - a.x) * d.t, py = a.y + (b.y - a.y) * d.t;
      const dist = Math.hypot(x - px, y - py), thr = Math.max(1.6, d.w * 0.7);
      if (dist < thr && dist < bd) { bd = dist; best = i; }
    });
    return best;
  }
  // select-only entry for the Select tool: returns true if a door was hit (marker
  // or proximity) and begins a slide-drag. Never creates.
  function pickSelect(e: any) {
    const mk = pickMarker(e);
    let di = mk ? mk.userData.di : -1;
    if (di < 0) {
      const h = pickMeshes(e);
      if (h) { const lvl = h.object.userData.level ?? (h.point.z < levelSplitZ() ? 0 : 1); di = nearestDoorIndex(h.point.x, h.point.y, lvl); }
    }
    if (di < 0) return false;
    if (e.shiftKey) { selectedDoors.has(di) ? selectedDoors.delete(di) : selectedDoors.add(di); }
    else { selectedDoors.clear(); selectedDoors.add(di); }
    colorMarkers();
    const lvl = graph.walls[doors[di].wall].level;
    plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, levelZ(lvl) + wallH / 2));
    V.controls.enableRotate = false; drag = { di, moved: false };
    return true;
  }

  function onDown(e: any) {
    const mk = pickMarker(e);
    if (mk) {                                   // SELECT (like walls) — never delete on click
      const di = mk.userData.di;
      if (e.shiftKey) { selectedDoors.has(di) ? selectedDoors.delete(di) : selectedDoors.add(di); colorMarkers(); return; }
      if (!selectedDoors.has(di)) { selectedDoors.clear(); selectedDoors.add(di); colorMarkers(); }
      V.controls.enableRotate = false;          // begin drag-to-slide
      const lvl = graph.walls[doors[di].wall].level;
      plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, levelZ(lvl) + wallH / 2));
      drag = { di, moved: false };
      return;
    }
    const hit2 = pickMeshes(e); if (!hit2) { if (!e.shiftKey) clearSel(); return; }
    const level = hit2.object.userData.level ?? (hit2.point.z < levelSplitZ() ? 0 : 1);
    const nw = levelVisible(level) ? nearestWall(graph, hit2.point.x, hit2.point.y, level) : null;
    if (!nw || nw.dist > 1.5) { if (!e.shiftKey) clearSel(); info.innerHTML = "Click a wall to add a door, or a door to select."; return; }
    const w = Math.min(doorWidthDefault, nw.len - 0.6);
    const t = Math.max(w / 2 / nw.len, Math.min(1 - w / 2 / nw.len, nw.t));
    doors.push(normDoor({ wall: nw.wall, t, w, side: 1, style: doorStyle, color: doorColor, casing: doorCasing }));
    rebuildWalls(); rebuildMarkers(); commit("Add doorway");
    info.innerHTML = `Door added (${doors.length} total).`;
  }
  function onMove(e: any) {
    if (drag) {                                  // slide the grabbed door along its wall
      ray.setFromCamera(pointerNDC(e), V.camera);
      if (!ray.ray.intersectPlane(plane, hit)) return;
      const d = doors[drag.di], wl = graph.walls[d.wall];
      const a = graph.nodes[wl.a], b = graph.nodes[wl.b];
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1e-6;
      const len = Math.sqrt(len2), half = (d.w / 2) / len;
      d.t = Math.max(half, Math.min(1 - half, ((hit.x - a.x) * dx + (hit.y - a.y) * dy) / len2));
      drag.moved = true;
      rebuildWalls(); placeMarkers();
      info.innerHTML = `Door at <span class="reading">${(d.t * 100).toFixed(0)}%</span> of wall`;
      return;
    }
    const mk = pickMarker(e);
    if (mk !== hover) { hover = mk; colorMarkers(); }
  }
  function onUp() {
    if (!drag) return;
    const d = drag; drag = null; updateOrbit();
    if (d.moved) commit("Move doorway");        // click without drag = selection only (NOT delete)
  }
  function flipSelected() {                                    // mirror ACROSS the wall (swing side)
    if (!selectedDoors.size) return;
    for (const di of selectedDoors) doors[di].side = -(doors[di].side ?? 1);
    rebuildWalls(); commit("Flip swing");
  }
  function flipHingeSelected() {                               // mirror ALONG the wall (hinge end)
    if (!selectedDoors.size) return;
    for (const di of selectedDoors) doors[di].hand = -(doors[di].hand ?? 1);
    rebuildWalls(); commit("Flip hinge");
  }
  function deleteSelectedDoors() {
    if (!selectedDoors.size) return;
    [...selectedDoors].sort((a, b) => b - a).forEach((di) => doors.splice(di, 1));  // high→low keeps indices valid
    selectedDoors.clear();
    rebuildWalls(); rebuildMarkers(); commit("Delete doors");
  }
  function onKey(e: any) {
    if (mode !== "doors" && !(mode === "select" && selectedDoors.size)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selectedDoors.size) { e.preventDefault(); deleteSelectedDoors(); }
    else if (e.key === "Escape") clearSel();
    else if (e.key === "f") flipSelected();        // f = flip swing
    else if (e.key === "g") flipHingeSelected();   // g = flip hinge (the other axis)
  }
  addEventListener("keydown", onKey);
  $("flip-door").onclick = flipSelected;
  $("flip-hinge")?.addEventListener("click", flipHingeSelected);
  $("del-door").onclick = deleteSelectedDoors;

  // ---- Phase 3 inspector wiring: style cards, width, color, casing ----------
  // Dual behavior (G4): with a selection, edit it + commit; with nothing
  // selected, set the default for NEW doors. syncPanel() reflects the selection.
  function setProp(fn: any, label: any) {
    if (selectedDoors.size) {
      for (const di of selectedDoors) fn(doors[di]);
      rebuildWalls(); rebuildMarkers(); commit(label);
    } else { saveState(); }
    syncPanel();
  }
  // style cards
  const styleGrid = $("door-style");
  if (styleGrid) styleGrid.querySelectorAll(".style-card").forEach((card: any) => {
    card.addEventListener("click", () => {
      const sid = card.getAttribute("data-style"); if (!sid) return;
      if (selectedDoors.size) setProp((d: any) => { d.style = sid; }, "Door style");
      else { doorStyle = sid; saveState(); syncPanel(); }
    });
  });
  // keep a door's center within the wall so the (possibly resized) opening fits.
  function clampDoorT(di: any) {
    const d = doors[di], wl = graph.walls[d.wall]; if (!wl) return d.t;
    const a = graph.nodes[wl.a], b = graph.nodes[wl.b]; if (!a || !b) return d.t;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1e-6, half = (d.w / 2) / len;
    return Math.max(half, Math.min(1 - half, d.t));
  }
  // clamp a width so the door still fits its wall (leaving a small jamb margin).
  function clampDoorWidth(di: any, w: any) {
    const d = doors[di], wl = graph.walls[d.wall]; if (!wl) return w;
    const a = graph.nodes[wl.a], b = graph.nodes[wl.b]; if (!a || !b) return w;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1e-6;
    return Math.max(1.5, Math.min(w, len - 0.6));
  }
  // width: numField resizes the selection or sets the default
  numField("t-doorwidth", () => (selectedDoors.size ? doors[[...selectedDoors][0]].w : doorWidthDefault),
    (v: any) => {
      const w = Math.max(1.5, Math.min(8, v));
      if (selectedDoors.size) for (const di of selectedDoors) { doors[di].w = clampDoorWidth(di, w); doors[di].t = clampDoorT(di); }
      else doorWidthDefault = w;
    }, "Door width");
  // color
  const colorInp = $("door-color");
  if (colorInp) colorInp.addEventListener("input", () => {
    if (selectedDoors.size) setProp((d: any) => { d.color = colorInp.value; }, "Door color");
    else { doorColor = colorInp.value; saveState(); }
  });
  // casing toggle
  const casingBox = $("t-doorcasing");
  if (casingBox) casingBox.addEventListener("change", () => {
    if (selectedDoors.size) setProp((d: any) => { d.casing = casingBox.checked; }, "Door casing");
    else { doorCasing = casingBox.checked; saveState(); }
  });
  // reflect the selection (or defaults) into the door inspector controls.
  function syncPanel() {
    const one = selectedDoors.size ? doors[[...selectedDoors][0]] : null;
    const sid = one ? (one.style || "slab") : doorStyle;
    if (styleGrid) styleGrid.querySelectorAll(".style-card").forEach((c: any) =>
      c.classList.toggle("active", c.getAttribute("data-style") === sid));
    setNumField("t-doorwidth", one ? one.w : doorWidthDefault);
    if (colorInp) colorInp.value = one ? (one.color || "#8a5a3c") : doorColor;
    if (casingBox) casingBox.checked = one ? !!one.casing : doorCasing;
    $("door-count").textContent = countLabel(selectedDoors.size, "door");
  }

  function update() { if (markers.visible) placeMarkers(); }

  rebuildMarkers();
  V.doors = () => doors;
  // select(i): programmatic single-select (Layers panel / selectObject). §5.2
  function select(i: any) {
    if (i < 0 || i >= doors.length) return;
    selectedDoors.clear(); selectedDoors.add(i); colorMarkers();
    const el = $("door-controls"); if (el) el.style.display = "block";
  }
  // world-space bbox of the selected doors (for zoom-to-selection, §5.4)
  function selBox() {
    if (!selectedDoors.size) return null;
    const b = new THREE.Box3();
    for (const di of selectedDoors) {
      const d = doors[di], wl = graph.walls[d.wall]; if (!wl) continue;
      const p = doorPoint(graph, d), z = levelZ(p.level);
      b.expandByPoint(new THREE.Vector3(p.x - d.w, p.y - d.w, z));
      b.expandByPoint(new THREE.Vector3(p.x + d.w, p.y + d.w, z + wallH));
    }
    return b.isEmpty() ? null : b;
  }
  // duplicateSel (§5.3): clone each selected door on the same wall, t+0.08 clamped.
  function duplicateSel() {
    if (!selectedDoors.size) return;
    const made = [];
    for (const di of [...selectedDoors]) {
      const d = doors[di]; const nd = { ...d, t: Math.max(0, Math.min(1, (d.t ?? 0.5) + 0.08)) };
      doors.push(nd); made.push(doors.length - 1);
    }
    selectedDoors.clear(); made.forEach((i) => selectedDoors.add(i));
    rebuildWalls(); rebuildMarkers(); commit("Duplicate door");
  }
  return { onDown, onMove, onUp, update, setActive, setMarkersVisible, setVisible, pickSelect, select, duplicateSel, selBox, refresh: rebuildMarkers, clearSel, hasSel: () => selectedDoors.size > 0 };
}

// --- Windows: place on walls, select/slide/delete, adjust width ------------
function setupWindows(info: any) {
  const markers = new THREE.Group(); markers.visible = false; V.scene.add(markers); registerHandles(markers);
  const geo = new THREE.SphereGeometry(0.7, 16, 10);
  const mat = new THREE.MeshBasicMaterial({ color: 0x6ec6e0 });
  const matHover = new THREE.MeshBasicMaterial({ color: 0xffd479 });
  const matSel = new THREE.MeshBasicMaterial({ color: 0xff8c42 });
  const sel = new Set<number>();
  let hover: any = null, drag: any = null, dedicated = false, selVis = false, domVisible = true;
  let syncWinPanel = () => {};
  const plane = new THREE.Plane(), hit = new THREE.Vector3();

  function rebuildMarkers() {
    markers.clear();
    windows.forEach((w, i) => { const m = new THREE.Mesh(geo, mat); m.userData.wi = i; markers.add(m); });
    placeMarkers(); colorMarkers();
  }
  function placeMarkers() {
    markers.children.forEach((m) => {
      const win = windows[m.userData.wi], wl = win && graph.walls[win.wall];
      if (!wl || !graph.nodes[wl.a] || !graph.nodes[wl.b]) { m.visible = false; return; }
      const a = graph.nodes[wl.a], b = graph.nodes[wl.b];
      const bd = winBand(win);
      m.position.set(a.x + (b.x - a.x) * win.t, a.y + (b.y - a.y) * win.t, levelZ(wl.level) + (bd.z0 + bd.z1) / 2);
      m.visible = levelVisible(wl.level);
    });
  }
  function colorMarkers() {
    for (const m of markers.children) (m as any).material =sel.has(m.userData.wi) ? matSel : (m === hover ? matHover : mat);
    $("win-count").textContent = countLabel(sel.size, "window");
    $("del-win")?.classList.toggle("disabled", sel.size < 1);
    const wc = $("window-controls");
    if (wc) wc.style.display = (markers.visible && (dedicated || sel.size > 0)) ? "block" : "none";
    syncWinPanel();
  }
  function refreshVis() { markers.visible = domVisible && (dedicated || selVis); if (markers.visible) placeMarkers(); else hover = null; colorMarkers(); }
  function setVisible(on: any) { domVisible = on; refreshVis(); }   // §5.2 Layers eye toggle (session-only)
  function setActive(on: any) { dedicated = on; refreshVis(); }
  function setMarkersVisible(on: any) { selVis = on; refreshVis(); }
  function clearSel() { sel.clear(); colorMarkers(); }
  const pick = (e: any) => (ray.setFromCamera(pointerNDC(e), V.camera), ray.intersectObjects(markers.children.filter((m) => m.visible), false)[0]?.object || null);
  function nearestWindowIndex(x: any, y: any, level: any) {
    let best = -1, bd = Infinity;
    windows.forEach((win, i) => {
      const wl = graph.walls[win.wall]; if (!wl || wl.level !== level) return;
      const a = graph.nodes[wl.a], b = graph.nodes[wl.b]; if (!a || !b) return;
      const px = a.x + (b.x - a.x) * win.t, py = a.y + (b.y - a.y) * win.t;
      const dist = Math.hypot(x - px, y - py), thr = Math.max(1.4, win.w * 0.7);
      if (dist < thr && dist < bd) { bd = dist; best = i; }
    });
    return best;
  }
  function pickSelect(e: any) {
    const mk = pick(e);
    let wi = mk ? mk.userData.wi : -1;
    if (wi < 0) { const h = pickMeshes(e); if (h) { const lvl = h.object.userData.level ?? (h.point.z < levelSplitZ() ? 0 : 1); wi = nearestWindowIndex(h.point.x, h.point.y, lvl); } }
    if (wi < 0) return false;
    if (e.shiftKey) { sel.has(wi) ? sel.delete(wi) : sel.add(wi); } else { sel.clear(); sel.add(wi); }
    colorMarkers();
    const lvl = graph.walls[windows[wi].wall].level;
    plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, levelZ(lvl) + wallH / 2));
    V.controls.enableRotate = false; drag = { wi, moved: false };
    return true;
  }

  function onDown(e: any) {
    const mk = pick(e);
    if (mk) {                                   // select (never deletes on click)
      const wi = mk.userData.wi;
      if (e.shiftKey) { sel.has(wi) ? sel.delete(wi) : sel.add(wi); colorMarkers(); return; }
      if (!sel.has(wi)) { sel.clear(); sel.add(wi); colorMarkers(); }
      V.controls.enableRotate = false;
      const lvl = graph.walls[windows[wi].wall].level;
      plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, levelZ(lvl) + wallH / 2));
      drag = { wi, moved: false };
      return;
    }
    const hp = pickMeshes(e); if (!hp) { if (!e.shiftKey) clearSel(); return; }
    const level = hp.object.userData.level ?? (hp.point.z < levelSplitZ() ? 0 : 1);
    const nw = levelVisible(level) ? nearestWall(graph, hp.point.x, hp.point.y, level) : null;
    if (!nw || nw.dist > 1.5) { if (!e.shiftKey) clearSel(); info.innerHTML = "Click a wall to add a window."; return; }
    const w = Math.min(winWidth, nw.len - 0.6);
    const t = Math.max(w / 2 / nw.len, Math.min(1 - w / 2 / nw.len, nw.t));
    windows.push({ wall: nw.wall, t, w, sill: winSill, h: winHeight });
    rebuildWalls(); rebuildMarkers(); commit("Add window");
    info.innerHTML = `Window added (${windows.length} total).`;
  }
  function onMove(e: any) {
    if (drag) {
      ray.setFromCamera(pointerNDC(e), V.camera);
      if (!ray.ray.intersectPlane(plane, hit)) return;
      const win = windows[drag.wi], wl = graph.walls[win.wall];
      const a = graph.nodes[wl.a], b = graph.nodes[wl.b];
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1e-6, len = Math.sqrt(len2), half = (win.w / 2) / len;
      win.t = Math.max(half, Math.min(1 - half, ((hit.x - a.x) * dx + (hit.y - a.y) * dy) / len2));
      drag.moved = true; rebuildWalls(); placeMarkers();
      info.innerHTML = `Window at <span class="reading">${(win.t * 100).toFixed(0)}%</span> of wall`;
      return;
    }
    const mk = pick(e); if (mk !== hover) { hover = mk; colorMarkers(); }
  }
  function onUp() { if (!drag) return; const d = drag; drag = null; updateOrbit(); if (d.moved) commit("Move window"); }
  function setWidth(v: any) {                         // adjust width of selected windows + default for new ones
    winWidth = v;
    for (const wi of sel) {
      const win = windows[wi], wl = graph.walls[win.wall], a = graph.nodes[wl.a], b = graph.nodes[wl.b];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1e-6;
      win.w = Math.min(v, len - 0.6);
      const half = (win.w / 2) / len; win.t = Math.max(half, Math.min(1 - half, win.t));
    }
    rebuildWalls(); placeMarkers(); saveState();
  }
  function setSill(v: any) {                          // vertical position (bottom height)
    winSill = v;
    for (const wi of sel) windows[wi].sill = Math.max(0, Math.min(v, wallH - 0.3));
    rebuildWalls(); placeMarkers(); saveState();
  }
  function setHeight(v: any) {                         // glass height
    winHeight = v;
    for (const wi of sel) windows[wi].h = v;
    rebuildWalls(); placeMarkers(); saveState();
  }
  function deleteSel() {
    if (!sel.size) return;
    [...sel].sort((a, b) => b - a).forEach((wi) => windows.splice(wi, 1));
    sel.clear(); rebuildWalls(); rebuildMarkers(); commit("Delete windows");
  }
  function onKey(e: any) {
    if (mode !== "windows" && !(mode === "select" && sel.size)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && sel.size) { e.preventDefault(); deleteSel(); }
    else if (e.key === "Escape") clearSel();
  }
  addEventListener("keydown", onKey);
  // NumFields (§5.1): commit on `change`, live-update on `input` (label scrub).
  numField("t-winwidth", () => winWidth, setWidth, "Window size");
  numField("t-winsill", () => winSill, setSill, "Window size");
  numField("t-winheight", () => winHeight, setHeight, "Window size");
  // reflect the selected window's dims into the fields (or defaults when empty).
  syncWinPanel = () => {
    const w = sel.size ? windows[[...sel][0]] : null;
    setNumField("t-winwidth", w ? w.w : winWidth);
    setNumField("t-winsill", w ? (w.sill ?? winSill) : winSill);
    setNumField("t-winheight", w ? (w.h ?? winHeight) : winHeight);
  };
  $("del-win").onclick = deleteSel;
  function update() { if (markers.visible) placeMarkers(); }

  rebuildMarkers();
  V.windows = () => windows;
  function select(i: any) {
    if (i < 0 || i >= windows.length) return;
    sel.clear(); sel.add(i); colorMarkers();
    const el = $("window-controls"); if (el) el.style.display = "block";
  }
  function selBox() {
    if (!sel.size) return null;
    const b = new THREE.Box3();
    for (const wi of sel) {
      const w = windows[wi], wl = graph.walls[w.wall]; if (!wl) continue;
      const a = graph.nodes[wl.a], bb = graph.nodes[wl.b]; if (!a || !bb) continue;
      const px = a.x + (bb.x - a.x) * w.t, py = a.y + (bb.y - a.y) * w.t, bd = winBand(w);
      b.expandByPoint(new THREE.Vector3(px - w.w, py - w.w, levelZ(wl.level) + bd.z0));
      b.expandByPoint(new THREE.Vector3(px + w.w, py + w.w, levelZ(wl.level) + bd.z1));
    }
    return b.isEmpty() ? null : b;
  }
  // duplicateSel (§5.3): clone on same wall, t+0.08 clamped.
  function duplicateSel() {
    if (!sel.size) return;
    const made = [];
    for (const wi of [...sel]) {
      const w = windows[wi]; const nw = { ...w, t: Math.max(0, Math.min(1, (w.t ?? 0.5) + 0.08)) };
      windows.push(nw); made.push(windows.length - 1);
    }
    sel.clear(); made.forEach((i) => sel.add(i));
    rebuildWalls(); rebuildMarkers(); commit("Duplicate window");
  }
  return { onDown, onMove, onUp, update, setActive, setMarkersVisible, setVisible, pickSelect, select, duplicateSel, selBox, refresh: rebuildMarkers, clearSel, hasSel: () => sel.size > 0 };
}

// --- Stairs: place / move / resize / rotate / flip / delete ----------------
// Stairs are solid stepped blocks (front stoop + interior stair). Unlike doors/
// windows they aren't wall-bound: each is a footprint on a level's floor with an
// ascent direction. They are edited on that level's floor plane — click empty
// floor to drop one, click a stair (marker or body) to select, drag to slide,
// and the panel resizes / rotates / flips / deletes the selection.
function setupStairs(info: any) {
  const markers = new THREE.Group(); markers.visible = false; V.scene.add(markers); registerHandles(markers);
  const geo = new THREE.SphereGeometry(0.7, 16, 10);
  const matBase = new THREE.MeshBasicMaterial({ color: 0xd0a85a });
  const matHover = new THREE.MeshBasicMaterial({ color: 0xffd479 });
  const matSel = new THREE.MeshBasicMaterial({ color: 0xff5a3c });
  const sel = new Set<number>();                          // selected stair indices
  let hover: any = null, drag: any = null, dedicated = false, selVis = false, domVisible = true;
  let syncStairPanel = () => {};
  const plane = new THREE.Plane(), hit = new THREE.Vector3();
  const DIRS: Dir[] = ["+y", "+x", "-y", "-x"];   // rotate cycles 90° through these

  // Walls-like editing: ONE marker per centerline vertex (foot · landings · top),
  // each lifted to the tread height it sits on (stack-aware, so a vertex at run
  // height h has world z levelZ(level) + h). Markers carry { si, vk }.
  const materializePath = (s: any) => {
    if (!Array.isArray(s.path) || s.path.length < 2) { const sp = stairPath(s); s.path = sp.pts.map((p) => [p[0], p[1]]); s.width = sp.width; }
  };
  const syncBBox = (s: any) => { const b = stairBBox(s); s.x = b.x; s.y = b.y; s.w = b.w; s.d = b.d; };
  function rebuildMarkers() {
    markers.clear();
    stairs.forEach((s, i) => {
      const n = stairPath(s).pts.length;
      for (let k = 0; k < n; k++) { const m = new THREE.Mesh(geo, matBase); m.userData.si = i; m.userData.vk = k; markers.add(m); }
    });
    placeMarkers(); colorMarkers();
  }
  function placeMarkers() {
    let cur = -1, pts: any = null, zs: any = null;
    markers.children.forEach((m) => {
      const s = stairs[m.userData.si]; if (!s) { m.visible = false; return; }
      if (m.userData.si !== cur) { cur = m.userData.si; pts = stairPath(s).pts; zs = stairVertexZs(s, levelZ(s.level)); }
      const p = pts[m.userData.vk]; if (!p) { m.visible = false; return; }
      m.position.set(p[0], p[1], (zs[m.userData.vk] ?? levelZ(s.level)) + 0.6);
      m.visible = levelVisible(s.level);
    });
  }
  function colorMarkers() {
    for (const m of markers.children) (m as any).material =sel.has(m.userData.si) ? matSel : (m === hover ? matHover : matBase);
    const cnt = $("stair-count");
    if (cnt) cnt.textContent = countLabel(sel.size, "stair");
    $("del-stair")?.classList.toggle("disabled", sel.size < 1);
    const sc = $("stairs-controls");
    if (sc) sc.style.display = (markers.visible && (dedicated || sel.size > 0)) ? "block" : "none";
    syncStairPanel();
  }
  function refreshVis() { markers.visible = domVisible && (dedicated || selVis); if (markers.visible) placeMarkers(); else hover = null; colorMarkers(); }
  function setVisible(on: any) { domVisible = on; refreshVis(); }   // §5.2 Layers eye toggle (session-only)
  function setActive(on: any) { dedicated = on; refreshVis(); }
  function setMarkersVisible(on: any) { selVis = on; refreshVis(); }
  function clearSel() { sel.clear(); colorMarkers(); }
  const pickMarker = (e: any) => (ray.setFromCamera(pointerNDC(e), V.camera),
    ray.intersectObjects(markers.children.filter((m) => m.visible), false)[0]?.object || null);

  // smallest stair footprint containing (x,y) on a level
  function stairAt(x: any, y: any, level: any) {
    let best = -1, bestA = Infinity;
    stairs.forEach((s, i) => {
      if (s.level !== level) return;
      if (x >= s.x! && x <= s.x! + s.w! && y >= s.y! && y <= s.y! + s.d!) { const a = s.w! * s.d!; if (a < bestA) { bestA = a; best = i; } }
    });
    return best;
  }
  // raycast the stair BODY meshes (excluded from pickMeshes) → {x,y,level} | null
  function bodyHit(e: any) {
    const ms = [0, 1].filter((l) => levelVisible(l)).map((l) => V.meshes[`${l}-stair`]).filter(Boolean);
    ray.setFromCamera(pointerNDC(e), V.camera);
    const h = ray.intersectObjects(ms, false)[0]; if (!h) return null;
    const level = h.object.userData.level ?? (h.point.z < levelSplitZ() ? 0 : 1);
    return { x: h.point.x, y: h.point.y, level };
  }
  // point on a level's floor plane under the cursor (stack-aware)
  function floorPoint(e: any, level: any) {
    plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, levelZ(level)));
    ray.setFromCamera(pointerNDC(e), V.camera);
    return ray.ray.intersectPlane(plane, hit) ? { x: hit.x, y: hit.y } : null;
  }
  function startMove(e: any) {                            // drag the whole stair (body grab)
    const primary = stairs[[...sel][0]]; if (!primary) return;
    const p = floorPoint(e, primary.level); if (!p) return;
    V.controls.enableRotate = false;
    const start: Record<number, any> = {};
    for (const i of sel) { const s = stairs[i]; start[i] = { x: s.x, y: s.y, path: Array.isArray(s.path) ? s.path.map((q: any) => [q[0], q[1]]) : null }; }
    drag = { kind: "move", p0: p, level: primary.level, start, moved: false };
  }
  function startVertexDrag(e: any, si: any, vk: any) {              // drag a single centerline vertex
    const s = stairs[si]; if (!s) return;
    const p = floorPoint(e, s.level); if (!p) return;
    V.controls.enableRotate = false;
    drag = { kind: "vertex", si, vk, level: s.level, moved: false };
  }
  // Select-tool entry: true if a stair was hit (and a drag is armed).
  function pickSelect(e: any) {
    const mk = pickMarker(e);
    if (mk) {
      const si = mk.userData.si;
      if (e.shiftKey) { sel.has(si) ? sel.delete(si) : sel.add(si); } else { sel.clear(); sel.add(si); }
      colorMarkers(); startVertexDrag(e, si, mk.userData.vk);
      return true;
    }
    const b = bodyHit(e), bi = b ? stairAt(b.x, b.y, b.level) : -1; if (bi < 0) return false;
    if (e.shiftKey) { sel.has(bi) ? sel.delete(bi) : sel.add(bi); } else { sel.clear(); sel.add(bi); }
    colorMarkers(); startMove(e);
    return true;
  }
  function onDown(e: any) {
    const mk = pickMarker(e);
    if (mk) {                                        // grabbed a vertex
      const si = mk.userData.si;
      if (e.shiftKey) { sel.has(si) ? sel.delete(si) : sel.add(si); colorMarkers(); return; }
      if (!sel.has(si)) { sel.clear(); sel.add(si); }
      colorMarkers(); startVertexDrag(e, si, mk.userData.vk);
      return;
    }
    const b = bodyHit(e), bi = b ? stairAt(b.x, b.y, b.level) : -1;
    if (bi >= 0) {                                   // grabbed the body → move whole stair
      if (e.shiftKey) { sel.has(bi) ? sel.delete(bi) : sel.add(bi); colorMarkers(); return; }
      if (!sel.has(bi)) { sel.clear(); sel.add(bi); colorMarkers(); }
      startMove(e);
      return;
    }
    const hp = pickMeshes(e); if (!hp) { if (!e.shiftKey) clearSel(); return; }   // empty → place a stair
    const level = hp.object.userData.level ?? (hp.point.z < levelSplitZ() ? 0 : 1);
    if (!levelVisible(level)) { if (!e.shiftKey) clearSel(); return; }
    const cx = snap(hp.point.x, gridSize), cy = snap(hp.point.y, gridSize);
    const s: Stair = { name: "Stair", level, width: stairW, steps: stairCount, up: stairUp, down: stairDown,
      dir: "+y", path: [[cx, cy - stairRun / 2], [cx, cy + stairRun / 2]] };
    syncBBox(s); stairs.push(s);
    V.wallsDirty = true; rebuildMarkers();
    sel.clear(); sel.add(stairs.length - 1); colorMarkers();
    commit("Add stair"); info.innerHTML = `Stair added (${stairs.length} total) — drag the end · +Flight to turn.`;
  }
  function onMove(e: any) {
    if (drag && drag.kind === "vertex") {            // reshape one flight by dragging its vertex
      const p = floorPoint(e, drag.level); if (!p) return;
      const s = stairs[drag.si]; if (!s) return;
      let px = p.x, py = p.y;
      if (gridSize > 0) { px = snap(px, gridSize); py = snap(py, gridSize); }
      materializePath(s); s.path![drag.vk] = [px, py]; syncBBox(s);
      drag.moved = true; V.wallsDirty = true; placeMarkers();
      const pts = stairPath(s).pts, sl = (i: any, j: any) => Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
      const parts = [];
      if (drag.vk > 0) parts.push(ftIn(sl(drag.vk - 1, drag.vk)));
      if (drag.vk < pts.length - 1) parts.push(ftIn(sl(drag.vk, drag.vk + 1)));
      info.innerHTML = `Flight: <span class="reading">${parts.join(" · ")}</span>`;
      return;
    }
    if (drag) {                                      // slide the whole stair
      const p = floorPoint(e, drag.level); if (!p) return;
      let dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
      if (gridSize > 0) { dx = snap(dx, gridSize); dy = snap(dy, gridSize); }
      for (const i of sel) { const st = drag.start[i], s = stairs[i]; if (!st || !s) continue;
        s.x = st.x + dx; s.y = st.y + dy;
        if (st.path) s.path = st.path.map(([x, y]: number[]) => [x + dx, y + dy]); }
      drag.moved = true; V.wallsDirty = true; placeMarkers();
      info.innerHTML = `Move: <span class="reading">${dx >= 0 ? "+" : ""}${dx.toFixed(1)}, ${dy >= 0 ? "+" : ""}${dy.toFixed(1)} ft</span>`;
      return;
    }
    const mk = pickMarker(e); if (mk !== hover) { hover = mk; colorMarkers(); }
  }
  function onUp() { if (!drag) return; const d = drag; drag = null; updateOrbit(); if (d.moved) commit(d.kind === "vertex" ? "Shape stair" : "Move stair"); }

  // run = footprint dimension ALONG the ascent; width = ACROSS it (anchored at center)
  const alongX = (s: any) => s.dir === "+x" || s.dir === "-x";
  function setWidth(v: any) {                              // stair width (across every flight)
    stairW = v;
    for (const i of sel) { const s = stairs[i];
      if (Array.isArray(s.path)) { s.width = v; syncBBox(s); }
      else if (alongX(s)) { const cy = s.y! + s.d! / 2; s.d = v; s.y = cy - v / 2; }
      else { const cx = s.x! + s.w! / 2; s.w = v; s.x = cx - v / 2; } }
    V.wallsDirty = true; placeMarkers(); saveState();
  }
  function setRun(v: any) {                                // length of the LAST flight (foot end fixed)
    stairRun = v;
    for (const i of sel) { const s = stairs[i];
      if (Array.isArray(s.path)) {
        const p = s.path!, n = p.length, a = p[n - 2], b = p[n - 1];
        const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
        p[n - 1] = [a[0] + (dx / len) * v, a[1] + (dy / len) * v]; syncBBox(s);
      }
      else if (alongX(s)) { const cx = s.x! + s.w! / 2; s.w = v; s.x = cx - v / 2; }
      else { const cy = s.y! + s.d! / 2; s.d = v; s.y = cy - v / 2; } }
    V.wallsDirty = true; placeMarkers(); saveState();
  }
  function setUp(v: any) {                                // travel ABOVE the floor
    stairUp = v;
    for (const i of sel) stairs[i].up = v;
    V.wallsDirty = true; placeMarkers(); saveState();   // top tread moves → markers follow
  }
  function setDown(v: any) {                              // travel BELOW the floor
    stairDown = v;
    for (const i of sel) stairs[i].down = v;
    V.wallsDirty = true; placeMarkers(); saveState();
  }
  function setSteps(v: any) {
    stairCount = Math.max(2, Math.round(v));
    for (const i of sel) stairs[i].steps = stairCount;
    V.wallsDirty = true; placeMarkers(); saveState();   // landing heights shift with the count
  }
  function rotateSel() {                             // turn 90° about the footprint center
    if (!sel.size) return;
    for (const i of sel) { const s = stairs[i];
      const cx = s.x! + s.w! / 2, cy = s.y! + s.d! / 2;
      s.dir = DIRS[(DIRS.indexOf(s.dir!) + 1) % DIRS.length];
      if (Array.isArray(s.path)) { s.path = s.path.map(([px, py]) => [cx + (py - cy), cy - (px - cx)]); syncBBox(s); }
      else { const nw = s.d!, nd = s.w!; s.w = nw; s.d = nd; s.x = cx - nw / 2; s.y = cy - nd / 2; } }
    V.wallsDirty = true; placeMarkers(); commit("Rotate stair");
  }
  function flipSel() {                               // reverse the climb (swap foot ↔ top)
    if (!sel.size) return;
    const F: Record<string, Dir> = { "+y": "-y", "-y": "+y", "+x": "-x", "-x": "+x" };
    for (const i of sel) { const s = stairs[i];
      if (Array.isArray(s.path)) { s.path.reverse(); const u = s.up ?? 0; s.up = s.down ?? 0; s.down = u; }
      else s.dir = F[s.dir!] || s.dir; }
    V.wallsDirty = true; placeMarkers(); commit("Flip stair");
  }
  // Append a flight that turns LEFT at a new landing; its end vertex is then
  // draggable anywhere (straight, left, or right). Remove drops the last flight.
  function addFlight() {
    if (!sel.size) return;
    for (const i of sel) { const s = stairs[i]; materializePath(s);
      const p = s.path!, n = p.length, a = p[n - 2], b = p[n - 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len, run = stairRun;        // left 90°: (ux,uy) → (-uy,ux)
      p.push([b[0] - uy * run, b[1] + ux * run]); syncBBox(s); }
    V.wallsDirty = true; rebuildMarkers(); commit("Add flight");
    info.innerHTML = "Flight added — drag its end to turn/aim it.";
  }
  function removeFlight() {
    if (!sel.size) return;
    let any = false;
    for (const i of sel) { const s = stairs[i];
      if (Array.isArray(s.path) && s.path.length > 2) { s.path.pop(); syncBBox(s); any = true; } }
    if (!any) return;
    V.wallsDirty = true; rebuildMarkers(); commit("Remove flight");
  }
  function deleteSel() {
    if (!sel.size) return;
    [...sel].sort((a, b) => b - a).forEach((i) => stairs.splice(i, 1));
    sel.clear(); V.wallsDirty = true; rebuildMarkers(); commit("Delete stairs");
  }
  function onKey(e: any) {
    if (mode !== "stairs" && !(mode === "select" && sel.size)) return;
    if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && sel.size) { e.preventDefault(); deleteSel(); }
    else if (e.key === "Escape") clearSel();
    else if ((e.key === "r" || e.key === "R") && sel.size) rotateSel();
    else if ((e.key === "f" || e.key === "F") && sel.size) flipSel();
  }
  addEventListener("keydown", onKey);
  // dimension NumFields (§5.1); Steps stays an integer range slider.
  numField("t-stairwidth", () => stairW, setWidth, "Stair width");
  numField("t-stairrun", () => stairRun, setRun, "Stair run");
  numField("t-stairrise", () => stairUp, setUp, "Stair rise");
  numField("t-stairdrop", () => stairDown, setDown, "Stair drop");
  const stepsEl = $("t-stairsteps"), stepsVal = $("t-stairsteps-v");
  if (stepsEl) {
    stepsEl.value = stairCount; if (stepsVal) stepsVal.textContent = stairCount;
    stepsEl.oninput = (e: any) => { if (stepsVal) stepsVal.textContent = +e.target.value; setSteps(+e.target.value); commit("Stair steps"); };
  }
  // reflect the selected stair's dims into the fields (or defaults when empty).
  const widthOf = (s: any) => Array.isArray(s.path) ? (s.width ?? stairW) : (alongX(s) ? s.d : s.w);
  const runOf = (s: any) => {                              // last-flight length for a path stair
    if (!Array.isArray(s.path)) return alongX(s) ? s.w : s.d;
    const p = s.path, n = p.length;
    return Math.hypot(p[n - 1][0] - p[n - 2][0], p[n - 1][1] - p[n - 2][1]);
  };
  syncStairPanel = () => {
    const s = sel.size ? stairs[[...sel][0]] : null;
    setNumField("t-stairwidth", s ? widthOf(s) : stairW);
    setNumField("t-stairrun", s ? runOf(s) : stairRun);
    setNumField("t-stairrise", s ? (s.up ?? stairUp) : stairUp);
    setNumField("t-stairdrop", s ? (s.down ?? stairDown) : stairDown);
    if (stepsEl) { const v = s ? (s.steps ?? stairCount) : stairCount; stepsEl.value = v; if (stepsVal) stepsVal.textContent = v; }
  };
  $("rot-stair")?.addEventListener("click", rotateSel);
  $("flip-stair")?.addEventListener("click", flipSel);
  $("add-flight")?.addEventListener("click", addFlight);
  $("del-flight")?.addEventListener("click", removeFlight);
  $("del-stair")?.addEventListener("click", deleteSel);
  function update() { if (markers.visible) placeMarkers(); }

  rebuildMarkers();
  V.stairsApi = () => stairs;
  function select(i: any) {
    if (i < 0 || i >= stairs.length) return;
    sel.clear(); sel.add(i); colorMarkers();
    const el = $("stairs-controls"); if (el) el.style.display = "block";
  }
  function selBox() {
    if (!sel.size) return null;
    const b = new THREE.Box3();
    for (const i of sel) { const s = stairs[i]; const z = levelZ(s.level);
      b.expandByPoint(new THREE.Vector3(s.x, s.y, z + (s.down ? -s.down : 0)));
      b.expandByPoint(new THREE.Vector3(s.x! + s.w!, s.y! + s.d!, z + (s.up ?? 0) + 1)); }
    return b.isEmpty() ? null : b;
  }
  // duplicateSel (§5.3): clone offset by x+1, y+1.
  function duplicateSel() {
    if (!sel.size) return;
    const made = [];
    for (const i of [...sel]) { const s = stairs[i];
      const c = { ...s, x: s.x! + 1, y: s.y! + 1 };
      if (Array.isArray(s.path)) c.path = s.path.map(([x, y]) => [x + 1, y + 1]);
      stairs.push(c); made.push(stairs.length - 1); }
    sel.clear(); made.forEach((i) => sel.add(i));
    V.wallsDirty = true; rebuildMarkers(); commit("Duplicate stair");
  }
  return { onDown, onMove, onUp, update, setActive, setMarkersVisible, setVisible, pickSelect, select, duplicateSel, selBox, refresh: rebuildMarkers, clearSel, hasSel: () => sel.size > 0 };
}

// --- Furniture: place / move / resize / rotate / recolor / delete ----------
// Furniture pieces (cabinets, island, beds, couches) are footprints on a level's
// floor, edited exactly like stairs: pick a type, click empty floor to drop one,
// click a piece (marker or body) to select, drag to slide, and the panel resizes /
// retypes / recolors / rotates / deletes the selection. Geometry per type comes
// from src/furniture.js (shared with the SCAD export).
function setupFurniture(info: any) {
  const markers = new THREE.Group(); markers.visible = false; V.scene.add(markers); registerHandles(markers);
  const geo = new THREE.SphereGeometry(0.7, 16, 10);
  const matBase = new THREE.MeshBasicMaterial({ color: 0x8ad0a0 });
  const matHover = new THREE.MeshBasicMaterial({ color: 0xffd479 });
  const matSel = new THREE.MeshBasicMaterial({ color: 0xff5a3c });
  const sel = new Set<number>();                          // selected furniture indices
  let hover: any = null, drag: any = null, dedicated = false, selVis = false, domVisible = true;
  const plane = new THREE.Plane(), hit = new THREE.Vector3();
  const DIRS: Dir[] = ["+y", "+x", "-y", "-x"];   // rotate cycles 90° through these
  const effColor = (f: any) => f.color || FURNITURE_TYPES[f.type]?.color || "#b89a72";

  const fcenter = (s: any) => ({ x: s.x + s.w / 2, y: s.y + s.d / 2 });
  function markerPos(s: any) {
    const c = fcenter(s);
    return new THREE.Vector3(c.x, c.y, levelZ(s.level) + (s.h ?? 3) + 0.5);
  }
  function rebuildMarkers() {
    markers.clear();
    furniture.forEach((s, i) => { const m = new THREE.Mesh(geo, matBase); m.userData.fi = i; markers.add(m); });
    placeMarkers(); colorMarkers();
  }
  function placeMarkers() {
    markers.children.forEach((m) => {
      const s = furniture[m.userData.fi]; if (!s) { m.visible = false; return; }
      m.position.copy(markerPos(s)); m.visible = levelVisible(s.level);
    });
  }
  function colorMarkers() {
    for (const m of markers.children) (m as any).material =sel.has(m.userData.fi) ? matSel : (m === hover ? matHover : matBase);
    const cnt = $("furn-count");
    if (cnt) cnt.textContent = countLabel(sel.size, "piece");
    $("del-furn")?.classList.toggle("disabled", sel.size < 1);
    const fc = $("furniture-controls");
    if (fc) fc.style.display = (markers.visible && (dedicated || sel.size > 0)) ? "block" : "none";
    syncPanel();
  }
  function refreshVis() { markers.visible = domVisible && (dedicated || selVis); if (markers.visible) placeMarkers(); else hover = null; colorMarkers(); }
  function setVisible(on: any) { domVisible = on; refreshVis(); }   // §5.2 Layers eye toggle (session-only)
  function setActive(on: any) { dedicated = on; refreshVis(); }
  function setMarkersVisible(on: any) { selVis = on; refreshVis(); }
  function clearSel() { sel.clear(); colorMarkers(); }
  const pickMarker = (e: any) => (ray.setFromCamera(pointerNDC(e), V.camera),
    ray.intersectObjects(markers.children.filter((m) => m.visible), false)[0]?.object || null);

  // smallest furniture footprint containing (x,y) on a level
  function furnAt(x: any, y: any, level: any) {
    let best = -1, bestA = Infinity;
    furniture.forEach((s, i) => {
      if (s.level !== level) return;
      if (x >= s.x! && x <= s.x! + s.w! && y >= s.y! && y <= s.y! + s.d!) { const a = s.w! * s.d!; if (a < bestA) { bestA = a; best = i; } }
    });
    return best;
  }
  // raycast the furniture BODY meshes (excluded from pickMeshes) → {x,y,level} | null
  function bodyHit(e: any) {
    const ms = [0, 1].filter((l) => levelVisible(l)).map((l) => V.meshes[`${l}-furn`]).filter(Boolean);
    ray.setFromCamera(pointerNDC(e), V.camera);
    const h = ray.intersectObjects(ms, false)[0]; if (!h) return null;
    const level = h.object.userData.level ?? (h.point.z < levelSplitZ() ? 0 : 1);
    return { x: h.point.x, y: h.point.y, level };
  }
  function pickIndex(e: any) {
    const mk = pickMarker(e); if (mk) return mk.userData.fi;
    const b = bodyHit(e); if (b) { const i = furnAt(b.x, b.y, b.level); if (i >= 0) return i; }
    return -1;
  }
  function floorPoint(e: any, level: any) {
    plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, levelZ(level)));
    ray.setFromCamera(pointerNDC(e), V.camera);
    return ray.ray.intersectPlane(plane, hit) ? { x: hit.x, y: hit.y } : null;
  }
  function startDrag(e: any) {
    const primary = furniture[[...sel][0]]; if (!primary) return;
    const p = floorPoint(e, primary.level); if (!p) return;
    V.controls.enableRotate = false;
    const start: Record<number, any> = {};
    for (const i of sel) start[i] = { x: furniture[i].x, y: furniture[i].y };
    drag = { p0: p, level: primary.level, start, moved: false };
  }
  function pickSelect(e: any) {
    const i = pickIndex(e); if (i < 0) return false;
    if (e.shiftKey) { sel.has(i) ? sel.delete(i) : sel.add(i); } else { sel.clear(); sel.add(i); }
    colorMarkers(); startDrag(e);
    return true;
  }
  function onDown(e: any) {
    const i = pickIndex(e);
    if (i >= 0) {
      if (e.shiftKey) { sel.has(i) ? sel.delete(i) : sel.add(i); colorMarkers(); return; }
      if (!sel.has(i)) { sel.clear(); sel.add(i); colorMarkers(); }
      startDrag(e);
      return;
    }
    const hp = pickMeshes(e); if (!hp) { if (!e.shiftKey) clearSel(); return; }   // empty floor → place
    const level = hp.object.userData.level ?? (hp.point.z < levelSplitZ() ? 0 : 1);
    if (!levelVisible(level)) { if (!e.shiftKey) clearSel(); return; }
    const cx = snap(hp.point.x, gridSize), cy = snap(hp.point.y, gridSize);
    furniture.push({ type: furnType, level, x: cx - furnW / 2, y: cy - furnD / 2,
      w: furnW, d: furnD, h: furnH, dir: "+y" });
    V.wallsDirty = true; rebuildMarkers();
    sel.clear(); sel.add(furniture.length - 1); colorMarkers();
    commit("Add furniture"); info.innerHTML = `${FURNITURE_TYPES[furnType]?.label || "Furniture"} added (${furniture.length} total).`;
  }
  function onMove(e: any) {
    if (drag) {
      const p = floorPoint(e, drag.level); if (!p) return;
      let dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
      if (gridSize > 0) { dx = snap(dx, gridSize); dy = snap(dy, gridSize); }
      for (const i of sel) { const st = drag.start[i]; if (!st || !furniture[i]) continue; furniture[i].x = st.x + dx; furniture[i].y = st.y + dy; }
      drag.moved = true; V.wallsDirty = true; placeMarkers();
      info.innerHTML = `Move: <span class="reading">${dx >= 0 ? "+" : ""}${dx.toFixed(1)}, ${dy >= 0 ? "+" : ""}${dy.toFixed(1)} ft</span>`;
      return;
    }
    const mk = pickMarker(e); if (mk !== hover) { hover = mk; colorMarkers(); }
  }
  function onUp() { if (!drag) return; const d = drag; drag = null; updateOrbit(); if (d.moved) commit("Move furniture"); }

  function setWidth(v: any) {                            // X extent, anchored at center
    furnW = v;
    for (const i of sel) { const s = furniture[i]; const cx = s.x + s.w / 2; s.w = v; s.x = cx - v / 2; }
    V.wallsDirty = true; placeMarkers(); saveState();
  }
  function setDepth(v: any) {                            // Y extent, anchored at center
    furnD = v;
    for (const i of sel) { const s = furniture[i]; const cy = s.y + s.d / 2; s.d = v; s.y = cy - v / 2; }
    V.wallsDirty = true; placeMarkers(); saveState();
  }
  function setHeight(v: any) {
    furnH = v;
    for (const i of sel) furniture[i].h = v;
    V.wallsDirty = true; placeMarkers(); saveState();   // top marker follows
  }
  function setType(v: any) {                             // retype selection, or set default for new pieces
    if (!FURNITURE_TYPES[v]) return;
    furnType = v;
    if (sel.size) { for (const i of sel) furniture[i].type = v; V.wallsDirty = true; placeMarkers(); commit("Change furniture type"); }
    else { const d = FURNITURE_TYPES[v]; furnW = d.w; furnD = d.d; furnH = d.h; syncPanel(); saveState(); }
  }
  function setColor(v: any) {
    for (const i of sel) furniture[i].color = v;
    V.wallsDirty = true; saveState();
  }
  function rotateSel() {                            // turn 90°: cycle dir + swap footprint about center
    if (!sel.size) return;
    for (const i of sel) { const s = furniture[i];
      s.dir = DIRS[(DIRS.indexOf(s.dir!) + 1) % DIRS.length];
      const cx = s.x + s.w / 2, cy = s.y + s.d / 2, nw = s.d, nd = s.w;
      s.w = nw; s.d = nd; s.x = cx - nw / 2; s.y = cy - nd / 2; }
    V.wallsDirty = true; placeMarkers(); commit("Rotate furniture");
  }
  function deleteSel() {
    if (!sel.size) return;
    [...sel].sort((a, b) => b - a).forEach((i) => furniture.splice(i, 1));
    sel.clear(); V.wallsDirty = true; rebuildMarkers(); commit("Delete furniture");
  }
  function onKey(e: any) {
    if (mode !== "furniture" && !(mode === "select" && sel.size)) return;
    if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && sel.size) { e.preventDefault(); deleteSel(); }
    else if (e.key === "Escape") clearSel();
    else if ((e.key === "r" || e.key === "R") && sel.size) rotateSel();
  }
  addEventListener("keydown", onKey);

  // populate the type <select> from the registry. Cabinets are now a first-class
  // domain (Phase 5), so "cabinet" is DROPPED from the NEW-piece list — but legacy
  // furniture cabinets still render and stay selectable/editable: when such a piece
  // is selected, syncPanel re-adds a "cabinet" option so its type shows correctly.
  const NEW_FURN_TYPES = FURNITURE_ORDER.filter((k) => k !== "cabinet");
  const typeSel = $("furn-type");
  const fillTypeOptions = (includeCabinet: any) => {
    if (!typeSel) return;
    const keys = includeCabinet ? FURNITURE_ORDER : NEW_FURN_TYPES;
    typeSel.innerHTML = keys.map((k) => `<option value="${k}">${FURNITURE_TYPES[k].label}${k === "cabinet" ? " (legacy)" : ""}</option>`).join("");
  };
  if (typeSel && !typeSel.dataset.filled) { fillTypeOptions(false); typeSel.dataset.filled = "1"; }
  // if the default furnType was a cabinet (legacy save), fall back to the first new type.
  if (furnType === "cabinet") furnType = NEW_FURN_TYPES[0];
  const colorInp = $("furn-color");
  // reflect the active piece (or defaults) into the panel controls
  function syncPanel() {
    const f = sel.size ? furniture[[...sel][0]] : null;
    const w = f ? f.w : furnW, d = f ? f.d : furnD, h = f ? f.h : furnH, type = f ? f.type : furnType;
    // dimension NumFields reformat ft-in when the engine pushes a raw number.
    setNumField("t-furnwidth", w); setNumField("t-furndepth", d); setNumField("t-furnheight", h);
    // legacy cabinet selected: re-add the "cabinet" option so the dropdown shows it.
    fillTypeOptions(type === "cabinet");
    if (typeSel) typeSel.value = type;
    if (colorInp && f) colorInp.value = effColor(f);
  }
  if (typeSel) typeSel.onchange = (e: any) => setType(e.target.value);
  if (colorInp) colorInp.oninput = (e: any) => setColor(e.target.value);
  // dimension NumFields (§5.1): commit on `change`, live-update on `input`.
  numField("t-furnwidth", () => furnW, setWidth, "Furniture width");
  numField("t-furndepth", () => furnD, setDepth, "Furniture depth");
  numField("t-furnheight", () => furnH, setHeight, "Furniture height");
  $("rot-furn")?.addEventListener("click", rotateSel);
  $("del-furn")?.addEventListener("click", deleteSel);
  function update() { if (markers.visible) placeMarkers(); }

  rebuildMarkers();
  V.furnitureApi = () => furniture;
  function select(i: any) {
    if (i < 0 || i >= furniture.length) return;
    sel.clear(); sel.add(i); colorMarkers();
    const el = $("furniture-controls"); if (el) el.style.display = "block";
  }
  function selBox() {
    if (!sel.size) return null;
    const b = new THREE.Box3();
    for (const i of sel) { const s = furniture[i]; const z = levelZ(s.level);
      b.expandByPoint(new THREE.Vector3(s.x, s.y, z));
      b.expandByPoint(new THREE.Vector3(s.x + s.w, s.y + s.d, z + (s.h ?? 3))); }
    return b.isEmpty() ? null : b;
  }
  // duplicateSel (§5.3): clone offset by x+1, y+1.
  function duplicateSel() {
    if (!sel.size) return;
    const made = [];
    for (const i of [...sel]) { const s = furniture[i]; furniture.push({ ...s, x: s.x + 1, y: s.y + 1 }); made.push(furniture.length - 1); }
    sel.clear(); made.forEach((i) => sel.add(i));
    V.wallsDirty = true; rebuildMarkers(); commit("Duplicate furniture");
  }
  return { onDown, onMove, onUp, update, setActive, setMarkersVisible, setVisible, pickSelect, select, duplicateSel, selBox, refresh: rebuildMarkers, clearSel, hasSel: () => sel.size > 0 };
}

// --- Cabinets: place / slide / rotate / delete base/wall/tall cabinets ------
// Cabinets are footprint objects like furniture, but place snaps the BACK to the
// nearest wall within 3 ft (footprint back at wall centerline + WALL_T/2, facing
// away from the wall), drag slides along the wall axis for wall-backed pieces (or
// 2D-snaps for free pieces), and an adjacency snap flushes a dragged end to a
// neighbor's end on the same wall. Geometry comes from src/cabinets.js.
function setupCabinets(info: any) {
  const markers = new THREE.Group(); markers.visible = false; V.scene.add(markers); registerHandles(markers);
  const geo = new THREE.SphereGeometry(0.7, 16, 10);
  const matBase = new THREE.MeshBasicMaterial({ color: 0x7fb0d8 });
  const matHover = new THREE.MeshBasicMaterial({ color: 0xffd479 });
  const matSel = new THREE.MeshBasicMaterial({ color: 0xff5a3c });
  const sel = new Set<number>();                          // selected cabinet indices
  let hover: any = null, drag: any = null, dedicated = false, selVis = false, domVisible = true;
  let syncCabPanel = () => {};
  const plane = new THREE.Plane(), hit = new THREE.Vector3();
  const DIRS: Dir[] = ["+y", "+x", "-y", "-x"];   // rotate cycles 90° through these
  const SNAP_WALL = 3.0;                          // wall-snap radius (ft) for placement
  const ADJ = 0.4;                               // adjacency snap distance (ft)
  const effColor = (c: any) => c.color || "#9aa3ad";

  // run-axis "width" of a cabinet (along its face): w when ±y, d when ±x.
  const runW = (c: any) => (c.dir === "+x" || c.dir === "-x") ? c.d : c.w;
  const ccenter = (c: any) => ({ x: c.x + c.w / 2, y: c.y + c.d / 2 });
  function markerPos(c: any) {
    const m = ccenter(c);
    return new THREE.Vector3(m.x, m.y, levelZ(c.level) + (c.mount ?? 0) + (c.h ?? 3) + 0.5);
  }
  function rebuildMarkers() {
    markers.clear();
    cabinets.forEach((c, i) => { const m = new THREE.Mesh(geo, matBase); m.userData.ci = i; markers.add(m); });
    placeMarkers(); colorMarkers();
  }
  function placeMarkers() {
    markers.children.forEach((m) => {
      const c = cabinets[m.userData.ci]; if (!c) { m.visible = false; return; }
      m.position.copy(markerPos(c)); m.visible = levelVisible(c.level);
    });
  }
  function colorMarkers() {
    for (const m of markers.children) (m as any).material =sel.has(m.userData.ci) ? matSel : (m === hover ? matHover : matBase);
    const cnt = $("cab-count");
    if (cnt) cnt.textContent = countLabel(sel.size, "cabinet");
    $("del-cab")?.classList.toggle("disabled", sel.size < 1);
    const cc = $("cabinet-controls");
    if (cc) cc.style.display = (markers.visible && (dedicated || sel.size > 0)) ? "block" : "none";
    syncCabPanel();
  }
  function refreshVis() { markers.visible = domVisible && (dedicated || selVis); if (markers.visible) placeMarkers(); else hover = null; colorMarkers(); }
  function setVisible(on: any) { domVisible = on; for (const lvl of [0, 1]) { const m = V.meshes[`${lvl}-cab`]; if (m) m.visible = on; } refreshVis(); }
  function setActive(on: any) { dedicated = on; refreshVis(); }
  function setMarkersVisible(on: any) { selVis = on; refreshVis(); }
  function clearSel() { sel.clear(); colorMarkers(); }
  const pickMarker = (e: any) => (ray.setFromCamera(pointerNDC(e), V.camera),
    ray.intersectObjects(markers.children.filter((m) => m.visible), false)[0]?.object || null);

  function cabAt(x: any, y: any, level: any) {
    let best = -1, bestA = Infinity;
    cabinets.forEach((c, i) => {
      if (c.level !== level) return;
      if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.d) { const a = c.w * c.d; if (a < bestA) { bestA = a; best = i; } }
    });
    return best;
  }
  function bodyHit(e: any) {
    const ms = [0, 1].filter((l) => levelVisible(l)).map((l) => V.meshes[`${l}-cab`]).filter(Boolean);
    ray.setFromCamera(pointerNDC(e), V.camera);
    const h = ray.intersectObjects(ms, false)[0]; if (!h) return null;
    const level = h.object.userData.level ?? (h.point.z < levelSplitZ() ? 0 : 1);
    return { x: h.point.x, y: h.point.y, level };
  }
  function pickIndex(e: any) {
    const mk = pickMarker(e); if (mk) return mk.userData.ci;
    const b = bodyHit(e); if (b) { const i = cabAt(b.x, b.y, b.level); if (i >= 0) return i; }
    return -1;
  }
  function floorPoint(e: any, level: any) {
    plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, levelZ(level)));
    ray.setFromCamera(pointerNDC(e), V.camera);
    return ray.ray.intersectPlane(plane, hit) ? { x: hit.x, y: hit.y } : null;
  }

  // nearest cardinal dir ("+x"/"-x"/"+y"/"-y") to a vector
  function cardinal(vx: any, vy: any) {
    return Math.abs(vx) >= Math.abs(vy) ? (vx >= 0 ? "+x" : "-x") : (vy >= 0 ? "+y" : "-y");
  }
  // Snap a NEW cabinet to a wall near (x,y): back flush to the wall face, dir
  // facing away (toward the room/click), grid-snapped along the wall. Returns a
  // partial cabinet {x,y,w,d,dir,wall} or null when no wall is near.
  function snapToWall(x: any, y: any, level: any, w: any, d: any) {
    const nw = nearestWall(graph, x, y, level);
    if (!nw || nw.dist > SNAP_WALL) return null;
    const wl = graph.walls[nw.wall], a = graph.nodes[wl.a], b = graph.nodes[wl.b];
    const wx = b.x - a.x, wy = b.y - a.y, wlen = Math.hypot(wx, wy) || 1e-6;
    const ux = wx / wlen, uy = wy / wlen;                  // wall axis unit
    // point on the wall centerline closest to the click
    const px = a.x + ux * (nw.t * wlen), py = a.y + uy * (nw.t * wlen);
    // inward normal = toward the click point (away from the wall)
    let nxn = x - px, nyn = y - py; const nl = Math.hypot(nxn, nyn) || 1e-6; nxn /= nl; nyn /= nl;
    const dir = cardinal(nxn, nyn);
    const along = (dir === "+y" || dir === "-y");         // face ±y → run along X
    const cabRun = along ? w : d, cabDepth = along ? d : w;
    // center offset from the wall centerline along the inward normal
    const off = WALL_T / 2 + cabDepth / 2;
    let cxp = px + nxn * off, cyp = py + nyn * off;
    // grid-snap along the wall axis (snap the center's along-coordinate)
    if (gridSize > 0) {
      const alongCoord = along ? cxp : cyp;
      const snapped = snap(alongCoord, gridSize);
      if (along) cxp = snapped; else cyp = snapped;
    }
    return { x: cxp - w / 2, y: cyp - d / 2, w, d, dir, wall: nw.wall };
  }

  function startDrag(e: any) {
    const primary = cabinets[[...sel][0]]; if (!primary) return;
    const p = floorPoint(e, primary.level); if (!p) return;
    V.controls.enableRotate = false;
    const start: Record<number, any> = {};
    for (const i of sel) start[i] = { x: cabinets[i].x, y: cabinets[i].y };
    drag = { p0: p, level: primary.level, start, moved: false };
  }
  function pickSelect(e: any) {
    const i = pickIndex(e); if (i < 0) return false;
    if (e.shiftKey) { sel.has(i) ? sel.delete(i) : sel.add(i); } else { sel.clear(); sel.add(i); }
    colorMarkers(); startDrag(e);
    return true;
  }
  function placeNew(cx: any, cy: any, level: any) {
    const snapped = snapToWall(cx, cy, level, cabW, cabD);
    const def = CABINET_KINDS[cabKind] || CABINET_KINDS.base;
    const base = { level, kind: cabKind, front: cabFront, drawers: cabDrawers,
      counter: cabCounter, mount: cabMount, h: cabH, color: cabColor, counterColor: cabCounterColor };
    if (snapped) {
      cabinets.push(normCab({ ...base, x: snapped.x, y: snapped.y, w: snapped.w, d: snapped.d, dir: snapped.dir, wall: snapped.wall }));
    } else {
      cabinets.push(normCab({ ...base, x: snap(cx, gridSize) - cabW / 2, y: snap(cy, gridSize) - cabD / 2, w: cabW, d: cabD, dir: "+y" }));
    }
    sel.clear(); sel.add(cabinets.length - 1);
    V.wallsDirty = true; rebuildMarkers();
    commit("Add cabinet");
    info.innerHTML = `${CABINET_KINDS[cabKind]?.label || "Cabinet"} added (${cabinets.length} total).`;
  }
  function onDown(e: any) {
    const i = pickIndex(e);
    if (i >= 0) {
      if (e.shiftKey) { sel.has(i) ? sel.delete(i) : sel.add(i); colorMarkers(); return; }
      if (!sel.has(i)) { sel.clear(); sel.add(i); colorMarkers(); }
      startDrag(e);
      return;
    }
    const hp = pickMeshes(e); if (!hp) { if (!e.shiftKey) clearSel(); return; }
    const level = hp.object.userData.level ?? (hp.point.z < levelSplitZ() ? 0 : 1);
    if (!levelVisible(level)) { if (!e.shiftKey) clearSel(); return; }
    placeNew(hp.point.x, hp.point.y, level);
  }
  // Adjacency snap: nudge the dragged primary so an END lands flush with another
  // cabinet's END on the same wall (within ADJ ft). Operates along the wall axis.
  function adjacencySnap(primary: any) {
    if (primary.wall == null) return { dx: 0, dy: 0 };
    const wl = graph.walls[primary.wall]; if (!wl) return { dx: 0, dy: 0 };
    const a = graph.nodes[wl.a], b = graph.nodes[wl.b]; if (!a || !b) return { dx: 0, dy: 0 };
    const wx = b.x - a.x, wy = b.y - a.y, wlen = Math.hypot(wx, wy) || 1e-6;
    const ux = wx / wlen, uy = wy / wlen;
    const proj = (c: any) => { const m = ccenter(c); return (m.x - a.x) * ux + (m.y - a.y) * uy; };
    const pc = proj(primary), pr = runW(primary) / 2;
    const pLo = pc - pr, pHi = pc + pr;
    let bestShift = 0, bestDist = ADJ;
    cabinets.forEach((c, i) => {
      if (c === primary || sel.has(i) || c.wall !== primary.wall || c.level !== primary.level) return;
      const qc = proj(c), qr = runW(c) / 2, qLo = qc - qr, qHi = qc + qr;
      // candidate flush pairings: primaryLo→neighborHi and primaryHi→neighborLo
      for (const [pEnd, qEnd] of [[pLo, qHi], [pHi, qLo]]) {
        const dd = qEnd - pEnd;
        if (Math.abs(dd) < bestDist) { bestDist = Math.abs(dd); bestShift = dd; }
      }
    });
    return { dx: ux * bestShift, dy: uy * bestShift };
  }
  function onMove(e: any) {
    if (drag) {
      const p = floorPoint(e, drag.level); if (!p) return;
      const primary = cabinets[[...sel][0]];
      let dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
      if (primary && primary.wall != null && graph.walls[primary.wall]) {
        // slide along the wall axis only: project the raw delta onto the wall.
        const wl = graph.walls[primary.wall], a = graph.nodes[wl.a], b = graph.nodes[wl.b];
        const wx = b.x - a.x, wy = b.y - a.y, wlen = Math.hypot(wx, wy) || 1e-6;
        const ux = wx / wlen, uy = wy / wlen;
        const t = dx * ux + dy * uy;
        dx = ux * t; dy = uy * t;
      } else if (gridSize > 0) { dx = snap(dx, gridSize); dy = snap(dy, gridSize); }
      for (const i of sel) { const st = drag.start[i]; if (!st || !cabinets[i]) continue; cabinets[i].x = st.x + dx; cabinets[i].y = st.y + dy; }
      // adjacency snap (single-cabinet drags only, wall-backed)
      if (sel.size === 1 && primary && primary.wall != null) {
        const { dx: ax, dy: ay } = adjacencySnap(primary);
        if (ax || ay) { primary.x += ax; primary.y += ay; }
      }
      drag.moved = true; V.wallsDirty = true; placeMarkers();
      info.innerHTML = `Move: <span class="reading">${dx >= 0 ? "+" : ""}${dx.toFixed(1)}, ${dy >= 0 ? "+" : ""}${dy.toFixed(1)} ft</span>`;
      return;
    }
    const mk = pickMarker(e); if (mk !== hover) { hover = mk; colorMarkers(); }
  }
  function onUp() { if (!drag) return; const d = drag; drag = null; updateOrbit(); if (d.moved) commit("Move cabinet"); }

  // ---- inspector setters ----------------------------------------------------
  function setWidth(v: any) {                            // run width: anchored at center
    cabW = v;
    for (const i of sel) { const c = cabinets[i]; const cx = c.x + c.w / 2; c.w = v; c.x = cx - v / 2; }
    V.wallsDirty = true; placeMarkers(); saveState();
  }
  function setDepth(v: any) {
    cabD = v;
    for (const i of sel) { const c = cabinets[i]; const cy = c.y + c.d / 2; c.d = v; c.y = cy - v / 2; }
    V.wallsDirty = true; placeMarkers(); saveState();
  }
  function setHeight(v: any) {
    cabH = v;
    for (const i of sel) cabinets[i].h = v;
    V.wallsDirty = true; placeMarkers(); saveState();
  }
  function setMountH(v: any) {
    cabMount = v;
    for (const i of sel) cabinets[i].mount = v;
    V.wallsDirty = true; placeMarkers(); saveState();
  }
  function setKind(v: any) {                             // retype: apply kind defaults to d/h/mount, keep x/y/w
    if (!CABINET_KINDS[v]) return;
    cabKind = v; const def = CABINET_KINDS[v];
    if (sel.size) {
      for (const i of sel) { const c = cabinets[i];
        c.kind = v; c.d = def.d; c.h = def.h; c.mount = def.mount;
        if (v !== "base") c.counter = false; }
      V.wallsDirty = true; placeMarkers(); commit("Change cabinet kind");
    } else {
      cabD = def.d; cabH = def.h; cabMount = def.mount; cabCounter = def.counter; saveState();
    }
    syncCabPanel();
  }
  function setFront(v: any) {
    if (!FRONT_ORDER.includes(v)) return;
    cabFront = v;
    if (sel.size) { for (const i of sel) cabinets[i].front = v; V.wallsDirty = true; commit("Cabinet front"); }
    else saveState();
    syncCabPanel();
  }
  function setDrawers(v: any) {
    v = Math.max(0, Math.min(3, v | 0));
    cabDrawers = v;
    if (sel.size) { for (const i of sel) cabinets[i].drawers = v; V.wallsDirty = true; commit("Cabinet drawers"); }
    else saveState();
    syncCabPanel();
  }
  function setCounter(on: any) {
    cabCounter = on;
    if (sel.size) { for (const i of sel) cabinets[i].counter = on; V.wallsDirty = true; commit("Cabinet counter"); }
    else saveState();
    syncCabPanel();
  }
  function setColor(v: any) { cabColor = v; for (const i of sel) cabinets[i].color = v; V.wallsDirty = true; saveState(); }
  function setCounterColor(v: any) { cabCounterColor = v; for (const i of sel) cabinets[i].counterColor = v; V.wallsDirty = true; saveState(); }

  function rotateSel() {                            // 90°: free pieces swap footprint; wall-backed re-derive
    if (!sel.size) return;
    for (const i of sel) { const c = cabinets[i];
      c.dir = DIRS[(DIRS.indexOf(c.dir!) + 1) % DIRS.length];
      const cx = c.x + c.w / 2, cy = c.y + c.d / 2, nw = c.d, nd = c.w;
      c.w = nw; c.d = nd; c.x = cx - nw / 2; c.y = cy - nd / 2;
      // wall-backed: re-derive snap so the new back stays flush to its wall.
      if (c.wall != null && graph.walls[c.wall]) {
        const s = snapToWall(cx, cy, c.level, c.w, c.d);
        if (s) { c.x = s.x; c.y = s.y; c.dir = s.dir as Dir; c.wall = s.wall; }
      }
    }
    V.wallsDirty = true; placeMarkers(); commit("Rotate cabinet");
  }
  function deleteSel() {
    if (!sel.size) return;
    [...sel].sort((a, b) => b - a).forEach((i) => cabinets.splice(i, 1));
    sel.clear(); V.wallsDirty = true; rebuildMarkers(); commit("Delete cabinet");
  }
  function onKey(e: any) {
    if (mode !== "cabinets" && !(mode === "select" && sel.size)) return;
    if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && sel.size) { e.preventDefault(); deleteSel(); }
    else if (e.key === "Escape") clearSel();
    else if ((e.key === "r" || e.key === "R") && sel.size) rotateSel();
  }
  addEventListener("keydown", onKey);

  // ---- inspector wiring -----------------------------------------------------
  const kindSeg = $("cab-kind");
  if (kindSeg) kindSeg.querySelectorAll(".tool").forEach((b: any) =>
    b.addEventListener("click", () => { const k = b.getAttribute("data-kind"); if (k) setKind(k); }));
  const frontGrid = $("cab-front");
  if (frontGrid) frontGrid.querySelectorAll(".style-card").forEach((card: any) =>
    card.addEventListener("click", () => { const f = card.getAttribute("data-front"); if (f) setFront(f); }));
  numField("t-cabw", () => (sel.size ? cabinets[[...sel][0]].w : cabW), setWidth, "Cabinet width");
  numField("t-cabd", () => (sel.size ? cabinets[[...sel][0]].d : cabD), setDepth, "Cabinet depth");
  numField("t-cabh", () => (sel.size ? cabinets[[...sel][0]].h : cabH), setHeight, "Cabinet height");
  numField("t-cabmount", () => (sel.size ? (cabinets[[...sel][0]].mount ?? 0) : cabMount), setMountH, "Cabinet mount");
  const drawSeg = $("cab-drawers");
  if (drawSeg) drawSeg.querySelectorAll(".tool").forEach((b: any) =>
    b.addEventListener("click", () => { const n = b.getAttribute("data-drawers"); if (n != null) setDrawers(+n); }));
  const counterBox = $("t-cabcounter");
  if (counterBox) counterBox.addEventListener("change", (e: any) => setCounter(e.target.checked));
  const colorInp = $("cab-color");
  if (colorInp) colorInp.addEventListener("input", (e: any) => setColor(e.target.value));
  const ccolorInp = $("cab-countercolor");
  if (ccolorInp) ccolorInp.addEventListener("input", (e: any) => setCounterColor(e.target.value));
  $("rot-cab")?.addEventListener("click", rotateSel);
  $("del-cab")?.addEventListener("click", deleteSel);

  // reflect the selection (or defaults) into the cabinet inspector controls.
  syncCabPanel = () => {
    const c = sel.size ? cabinets[[...sel][0]] : null;
    const kind = c ? c.kind : cabKind;
    const front = c ? (c.front || "shaker") : cabFront;
    const drawers = c ? (c.drawers ?? 0) : cabDrawers;
    if (kindSeg) kindSeg.querySelectorAll(".tool").forEach((b: any) => b.classList.toggle("active", b.getAttribute("data-kind") === kind));
    if (frontGrid) frontGrid.querySelectorAll(".style-card").forEach((card: any) => card.classList.toggle("active", card.getAttribute("data-front") === front));
    if (drawSeg) drawSeg.querySelectorAll(".tool").forEach((b: any) => b.classList.toggle("active", +b.getAttribute("data-drawers") === drawers));
    setNumField("t-cabw", c ? c.w : cabW);
    setNumField("t-cabd", c ? c.d : cabD);
    setNumField("t-cabh", c ? c.h : cabH);
    setNumField("t-cabmount", c ? (c.mount ?? 0) : cabMount);
    // mount field is meaningful for wall cabinets — enable/disable accordingly.
    const mountRow = $("t-cabmount")?.closest(".prop, .numfield");
    if (mountRow) mountRow.style.opacity = kind === "wall" ? "1" : "0.5";
    if (counterBox) counterBox.checked = c ? !!c.counter : cabCounter;
    if (colorInp) colorInp.value = c ? effColor(c) : cabColor;
    if (ccolorInp) ccolorInp.value = c ? (c.counterColor || "#dcd8d0") : cabCounterColor;
    const cnt = $("cab-count"); if (cnt) cnt.textContent = countLabel(sel.size, "cabinet");
  };

  function update() { if (markers.visible) placeMarkers(); }

  rebuildMarkers();
  V.cabinets = () => cabinets;
  function select(i: any) {
    if (i < 0 || i >= cabinets.length) return;
    sel.clear(); sel.add(i); colorMarkers();
    const el = $("cabinet-controls"); if (el) el.style.display = "block";
  }
  function selBox() {
    if (!sel.size) return null;
    const b = new THREE.Box3();
    for (const i of sel) { const c = cabinets[i]; const z = levelZ(c.level) + (c.mount ?? 0);
      b.expandByPoint(new THREE.Vector3(c.x, c.y, z));
      b.expandByPoint(new THREE.Vector3(c.x + c.w, c.y + c.d, z + (c.h ?? 3))); }
    return b.isEmpty() ? null : b;
  }
  // duplicateSel (§5.3): clone offset along the wall (+runW) if wall-backed, else x+1/y+1.
  function duplicateSel() {
    if (!sel.size) return;
    const made = [];
    for (const i of [...sel]) {
      const c = cabinets[i];
      let nx = c.x + 1, ny = c.y + 1;
      if (c.wall != null && graph.walls[c.wall]) {
        const wl = graph.walls[c.wall], a = graph.nodes[wl.a], b = graph.nodes[wl.b];
        const wx = b.x - a.x, wy = b.y - a.y, wlen = Math.hypot(wx, wy) || 1e-6;
        const ux = wx / wlen, uy = wy / wlen, step = runW(c);
        nx = c.x + ux * step; ny = c.y + uy * step;
      }
      cabinets.push(normCab({ ...c, x: nx, y: ny })); made.push(cabinets.length - 1);
    }
    sel.clear(); made.forEach((i) => sel.add(i));
    V.wallsDirty = true; rebuildMarkers(); commit("Duplicate cabinet");
  }
  colorMarkers();
  return { onDown, onMove, onUp, update, setActive, setMarkersVisible, setVisible, pickSelect, select, duplicateSel, selBox, refresh: rebuildMarkers, clearSel, hasSel: () => sel.size > 0 };
}

// --- Labels: positionable scene text annotations (Phase 7) ------------------
// Labels are HTML divs in #labels (V.labelHost), positioned each frame from the
// `labels` collection (buildLabels/placeLabels). This tool makes them
// clickable/draggable: it toggles `labels-live` on the host (so the divs accept
// pointer events in Labels mode AND the Select tool), selects on div click,
// drags on the horizontal plane at the label's z, adds a label when the Labels
// TOOL is active and you click empty floor, and renames via #label-text.
function setupLabels(info: any) {
  const sel = new Set<number>();                          // selected label indices
  let dedicated = false, selVis = false, domVisible = true;
  let drag: any = null;                                // { i, dx, dy, level, moved }
  const plane = new THREE.Plane(), hit = new THREE.Vector3();

  // panels other tools' selection hides; we hide them when a label is selected
  // via a viewport (div) click so the inspector reads the label, not stale state.
  const OTHER_PANELS = ["door-controls", "window-controls", "moulding-controls", "cabinet-controls",
    "stairs-controls", "furniture-controls", "roof-controls", "wall-controls", "room-controls"];

  function host() { return V.labelHost; }
  function applyLive() {                           // labels clickable in labels mode or Select
    const h = host(); if (!h) return;
    h.classList.toggle("labels-live", domVisible && (dedicated || selVis));
  }
  // re-apply .sel classes after a buildLabels() rebuild (registered on V).
  V.refreshLabelSel = () => {
    if (!V.labels) return;
    for (const o of V.labels) o.el.classList.toggle("sel", sel.has(o.i));
  };
  function colorSel() {
    if (V.labels) for (const o of V.labels) o.el.classList.toggle("sel", sel.has(o.i));
    const cnt = $("label-count");
    if (cnt) cnt.textContent = countLabel(sel.size, "label");
    $("label-del")?.classList.toggle("disabled", sel.size < 1);
    const lc = $("label-controls");
    if (lc && (dedicated || sel.size > 0)) lc.style.display = "block";
    syncPanel();
  }
  function showPanel() {                           // viewport (div) click → focus our panel
    for (const p of OTHER_PANELS) { const el = $(p); if (el) el.style.display = "none"; }
    const hint = $("sel-empty"); if (hint) hint.style.display = "none";
    const lc = $("label-controls"); if (lc) lc.style.display = "block";
  }
  function syncPanel() {
    const lb = sel.size ? (labels || [])[[...sel][0]] : null;
    const t = $("label-text");
    if (t && document.activeElement !== t) t.value = lb ? lb.text : "";
  }

  function setVisible(on: any) { domVisible = on; if (V.labels) for (const o of V.labels) o.el.style.visibility = on ? "" : "hidden"; applyLive(); }
  function setActive(on: any) { dedicated = on; applyLive(); colorSel(); }
  function setMarkersVisible(on: any) { selVis = on; applyLive(); }
  function clearSel() { sel.clear(); colorSel(); }
  function hasSel() { return sel.size > 0; }

  function floorPoint(e: any, level: any) {
    plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, levelZ(level) + 0.3));
    ray.setFromCamera(pointerNDC(e), V.camera);
    return ray.ray.intersectPlane(plane, hit) ? { x: hit.x, y: hit.y } : null;
  }

  // div pointerdown (registered by buildLabels via V.labelDown): select + start drag.
  V.labelDown = (e: any, i: any) => {
    if (spaceHeld) return;
    if (!(dedicated || selVis)) return;            // only when interactive
    e.stopPropagation(); e.preventDefault();
    if (e.shiftKey) { sel.has(i) ? sel.delete(i) : sel.add(i); }
    else if (!sel.has(i)) { sel.clear(); sel.add(i); }
    showPanel(); colorSel();
    const lb = (labels || [])[i]; if (!lb) return;
    const p = floorPoint(e, lb.level); if (!p) return;
    drag = { i, dx: lb.x - p.x, dy: lb.y - p.y, level: lb.level, moved: false };
    host()?.classList.add("dragging");
    try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
  };

  // canvas onDown (Labels tool active): a click that misses any label adds one.
  function onDown(e: any) {
    if (drag) return;                              // a div-drag is in progress
    const hp = pickMeshes(e);
    if (!hp) { if (!e.shiftKey) clearSel(); return; }
    const level = hp.object.userData.level ?? (hp.point.z < levelSplitZ() ? 0 : 1);
    if (!levelVisible(level)) { if (!e.shiftKey) clearSel(); return; }
    (labels || (labels = [])).push(normLabel({ text: "Label", x: hp.point.x, y: hp.point.y, level }));
    sel.clear(); sel.add(labels.length - 1);
    buildLabels(); commit("Add label");
    info.innerHTML = `Label added (${labels.length} total).`;
    const t = $("label-text");
    if (t) { showPanel(); t.value = "Label"; t.focus(); t.select(); }
  }
  function onMove(e: any) {
    if (!drag) return;
    const p = floorPoint(e, drag.level); if (!p) return;
    const lb = (labels || [])[drag.i]; if (!lb) return;
    lb.x = p.x + drag.dx; lb.y = p.y + drag.dy; drag.moved = true;
    info.innerHTML = `Move label: <span class="reading">${lb.x.toFixed(1)}, ${lb.y.toFixed(1)} ft</span>`;
  }
  function onUp() { if (!drag) return; const d = drag; drag = null; host()?.classList.remove("dragging"); if (d.moved) commit("Move label"); }
  // The label divs hold pointer capture during a drag, so move/up fire on the div
  // (not the canvas) — and a drag can start in Select mode too, where route() does
  // NOT call lbl.onMove/onUp. Listen at the window level so the drag always tracks.
  addEventListener("pointermove", (e) => { if (drag) onMove(e); });
  addEventListener("pointerup", (e) => { if (drag) onUp(); });
  function update() {}

  // ---- inspector wiring -----------------------------------------------------
  const textInp = $("label-text");
  if (textInp) {
    // live `input`: update the div text without a commit; `change`: commit.
    textInp.addEventListener("input", (e: any) => {
      for (const i of sel) { const lb = (labels || [])[i]; if (lb) lb.text = e.target.value; }
      if (V.labels) for (const o of V.labels) if (sel.has(o.i)) o.el.textContent = o.lb.text;
    });
    textInp.addEventListener("change", (e: any) => {
      for (const i of sel) { const lb = (labels || [])[i]; if (lb) lb.text = e.target.value; }
      buildLabels(); commit("Rename label");
    });
  }
  $("label-del")?.addEventListener("click", deleteSel);

  function deleteSel() {
    if (!sel.size) return;
    [...sel].sort((a, b) => b - a).forEach((i) => (labels || []).splice(i, 1));
    sel.clear(); buildLabels(); commit("Delete label"); colorSel();
  }
  function onKey(e: any) {
    if (mode !== "labels" && !(mode === "select" && sel.size)) return;
    if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && sel.size) { e.preventDefault(); deleteSel(); }
    else if (e.key === "Escape") clearSel();
  }
  addEventListener("keydown", onKey);

  // external select (Layers panel): V.selectObject centers the viewport via
  // selBox after this returns, so select() only handles the selection itself.
  function select(i: any) {
    if (i < 0 || i >= (labels || []).length) return;
    sel.clear(); sel.add(i); showPanel(); colorSel();
  }
  // selBox (§5.4): each selected label's anchor ±1 ft in x/y/z.
  function selBox() {
    if (!sel.size) return null;
    const b = new THREE.Box3();
    for (const i of sel) { const lb = (labels || [])[i]; if (!lb) continue; const z = levelZ(lb.level) + 0.3;
      b.expandByPoint(new THREE.Vector3(lb.x - 1, lb.y - 1, z - 1));
      b.expandByPoint(new THREE.Vector3(lb.x + 1, lb.y + 1, z + 1)); }
    return b.isEmpty() ? null : b;
  }
  // duplicateSel (§5.3): clone selected offset by (+1,+1) ft; select the clones.
  function duplicateSel() {
    if (!sel.size) return;
    const made = [];
    for (const i of [...sel]) { const lb = (labels || [])[i]; if (!lb) continue;
      labels!.push(normLabel({ ...lb, x: lb.x + 1, y: lb.y + 1 })); made.push(labels!.length - 1); }
    sel.clear(); made.forEach((i) => sel.add(i));
    buildLabels(); commit("Duplicate label");
  }
  function refresh() { applyLive(); colorSel(); }   // after undo/redo: re-apply state to rebuilt divs

  return { onDown, onMove, onUp, onKey, update, setActive, setMarkersVisible, setVisible,
    select, duplicateSel, selBox, refresh, clearSel, hasSel };
}

// --- Moulding: apply per-room trim (base / chair / crown) ------------------
// Mouldings are applied PER ROOM, PER KIND and paint the room's interior
// perimeter (src/moulding.js). The Apply tool hover-highlights the room under
// the cursor (a translucent floor overlay) with a floating "Apply base · stepped
// to Kitchen" hint; clicking either selects an existing (room,kind) moulding or
// creates one from the inspector defaults. The Select tool (in moulding mode)
// picks a room's moulding by clicking near a moulded wall at the profile's z-band.
function setupMoulding(info: any) {
  const sel = new Set<number>();                          // selected moulding indices
  let dedicated = false, selVis = false, domVisible = true, hoverRoom = -1;
  let syncMldPanel = () => {};

  // hover highlight: a thin translucent overlay over the hovered room's loop.
  const hl = new THREE.Group(); V.scene.add(hl);
  const hlMat = new THREE.MeshBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.22,
    side: THREE.DoubleSide, depthWrite: false });
  // floating hint label (always-visible overlay, independent of the labels toggle)
  const hint = document.createElement("div"); hint.className = "mlabel"; hint.style.display = "none";
  V.overlayHost.appendChild(hint);

  const exists = (room: any, kind: any) => mouldings.findIndex((m) => m.room === room && m.kind === kind);
  const cap = (s: any) => (s ? s[0].toUpperCase() + s.slice(1) : s);

  function clearHL() { hl.clear(); hint.style.display = "none"; hoverRoom = -1; }
  function showRoomHL(ri: any) {
    hl.clear();
    if (ri < 0 || !rooms[ri]) { hoverRoom = -1; return; }
    hoverRoom = ri;
    const r = rooms[ri];
    const poly = (roomLoops[ri] || []).map((ni) => graph.nodes[ni]).filter(Boolean);
    if (poly.length < 3) return;
    const z = levelZ(r.level) + 0.05;
    const shape = new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, p.y)));
    const g = new THREE.ShapeGeometry(shape); g.translate(0, 0, z);
    hl.add(new THREE.Mesh(g, hlMat));
  }

  // smallest room (by area) whose loop polygon contains (x,y) on a level.
  function roomAt(x: any, y: any, level: any) {
    let best = -1, bestA = Infinity;
    rooms.forEach((r, i) => {
      if (r.level !== level) return;
      const rp = (roomLoops[i] || []).map((ni) => graph.nodes[ni]).filter(Boolean).map((p) => [p.x, p.y]);
      if (rp.length >= 3 && inPoly([x, y], rp)) { const a = polyArea(rp); if (a < bestA) { bestA = a; best = i; } }
    });
    return best;
  }
  // floor-plane hit (stack-aware) → {x, y, level} | null
  function floorHit(e: any) {
    const h = pickMeshes(e); if (!h) return null;
    const level = h.object.userData.level ?? (h.point.z < levelSplitZ() ? 0 : 1);
    return levelVisible(level) ? { x: h.point.x, y: h.point.y, level } : null;
  }

  function refreshVis() {
    // mouldings have no markers; the mesh itself is the object. Visibility just
    // gates the hover overlay (apply tool) + the domain mesh toggle (eye icon).
    const on = domVisible && (dedicated || selVis);
    if (!on) clearHL();
    colorSel();
  }
  function setVisible(on: any) {
    domVisible = on;
    for (const lvl of [0, 1]) { const m = V.meshes[`${lvl}-mld`]; if (m) m.visible = on; }
    refreshVis();
  }
  function setActive(on: any) { dedicated = on; if (!on) clearHL(); refreshVis(); }
  function setMarkersVisible(on: any) { selVis = on; refreshVis(); }
  function clearSel() { sel.clear(); colorSel(); }

  // panel show/hide + count; no markers to recolor (the mesh is vertex-colored).
  function colorSel() {
    const cnt = $("mld-count");
    if (cnt) cnt.textContent = countLabel(sel.size, "moulding");
    $("del-mld")?.classList.toggle("disabled", sel.size < 1);
    const mc = $("moulding-controls");
    if (mc) mc.style.display = ((dedicated || selVis) && (dedicated || sel.size > 0)) ? "block" : "none";
    syncMldPanel();
  }

  // Pick the moulding whose room+kind is nearest the click point within 0.6 ft of
  // one of its runs, at that kind's z-band. Returns the moulding index, or -1.
  function pickIndex(e: any) {
    const h = floorHit(e); if (!h) return -1;
    let best = -1, bd = 0.6;
    mouldings.forEach((m, i) => {
      const r = rooms[m.room]; if (!r || r.level !== h.level) return;
      for (const run of mouldingRuns(graph, roomLoops, doors, windows, m, wallH)) {
        const dx = run.bx - run.ax, dy = run.by - run.ay, len2 = dx * dx + dy * dy || 1e-6;
        let t = ((h.x - run.ax) * dx + (h.y - run.ay) * dy) / len2; t = Math.max(0, Math.min(1, t));
        const px = run.ax + dx * t, py = run.ay + dy * t;
        const dist = Math.hypot(h.x - px, h.y - py);
        if (dist < bd) { bd = dist; best = i; }
      }
    });
    return best;
  }
  // Select-tool entry: true if a moulding was hit near a moulded wall.
  function pickSelect(e: any) {
    const i = pickIndex(e); if (i < 0) return false;
    if (e.shiftKey) { sel.has(i) ? sel.delete(i) : sel.add(i); } else { sel.clear(); sel.add(i); }
    colorSel();
    return true;
  }

  // create or select a (room, kind) moulding from the current defaults.
  function applyAt(ri: any) {
    const ex = exists(ri, mldKind);
    if (ex >= 0) { sel.clear(); sel.add(ex); colorSel(); return; }
    mouldings.push({ room: ri, kind: mldKind as MouldKind, profile: mldProfile, h: mldH, d: mldD, color: mldColor });
    sel.clear(); sel.add(mouldings.length - 1);
    V.wallsDirty = true; colorSel(); commit(`Apply ${mldKind} moulding`);
  }

  function onDown(e: any) {
    if (spaceHeld) return;
    const h = floorHit(e); if (!h) { if (!e.shiftKey) clearSel(); return; }
    // Apply tool: click a room → select its existing (room,kind) moulding or
    // create one from the current defaults (applyAt does the select-vs-create).
    const ri = roomAt(h.x, h.y, h.level);
    if (ri < 0) { if (!e.shiftKey) clearSel(); return; }
    applyAt(ri);
    info.innerHTML = `Applied ${mldKind} · ${mldProfile} to <b>${rooms[ri]?.name || "room"}</b>.`;
  }
  function onMove(e: any) {
    if (!dedicated) return;                         // hover preview only in the Apply tool
    const h = floorHit(e);
    const ri = h ? roomAt(h.x, h.y, h.level) : -1;
    if (ri !== hoverRoom) showRoomHL(ri);
    if (ri >= 0) {
      hint.style.display = "";
      hint.textContent = `Apply ${mldKind} · ${mldProfile} to ${rooms[ri]?.name || "room"}`;
      hint.style.left = e.clientX + 14 + "px"; hint.style.top = e.clientY + 14 + "px";
    } else hint.style.display = "none";
  }
  function onUp() {}

  function deleteSel() {
    if (!sel.size) return;
    [...sel].sort((a, b) => b - a).forEach((i) => mouldings.splice(i, 1));
    sel.clear(); V.wallsDirty = true; colorSel(); commit("Delete moulding");
  }
  function onKey(e: any) {
    if (mode !== "moulding" && !(mode === "select" && sel.size)) return;
    if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && sel.size) { e.preventDefault(); deleteSel(); }
    else if (e.key === "Escape") clearSel();
  }
  addEventListener("keydown", onKey);

  // ---- inspector wiring -----------------------------------------------------
  // Dual behavior (G4): with a selection, edit it + commit; with nothing
  // selected, set the default for newly-applied mouldings.
  function setProp(fn: any, label: any) {
    if (sel.size) { for (const i of sel) fn(mouldings[i]); V.wallsDirty = true; colorSel(); commit(label); }
    else { saveState(); }
    syncMldPanel();
  }
  // kind segmented control (.tool[data-kind=base|chair|crown])
  const kindSeg = $("mld-kind");
  if (kindSeg) kindSeg.querySelectorAll(".tool").forEach((b: any) => {
    b.addEventListener("click", () => {
      const k = b.getAttribute("data-kind"); if (!k) return;
      if (sel.size) setProp((m: any) => { m.kind = k; }, "Moulding kind");
      else {
        mldKind = k; const def = KIND_DEFAULTS[k] || KIND_DEFAULTS.base;
        mldProfile = def.profile; mldH = def.h; mldD = def.d;
        saveState();
      }
      syncMldPanel();
    });
  });
  // profile cards (.style-card[data-profile=…])
  const profGrid = $("mld-profile");
  if (profGrid) profGrid.querySelectorAll(".style-card").forEach((card: any) => {
    card.addEventListener("click", () => {
      const pid = card.getAttribute("data-profile"); if (!pid) return;
      if (sel.size) setProp((m: any) => { m.profile = pid; }, "Moulding profile");
      else { mldProfile = pid; saveState(); syncMldPanel(); }
    });
  });
  // Height / Depth NumFields
  numField("t-mldh", () => (sel.size ? mouldings[[...sel][0]].h : mldH),
    (v: any) => { const h = Math.max(0.1, Math.min(1.5, v)); if (sel.size) for (const i of sel) mouldings[i].h = h; else mldH = h; V.wallsDirty = true; }, "Moulding height");
  numField("t-mldd", () => (sel.size ? mouldings[[...sel][0]].d : mldD),
    (v: any) => { const d = Math.max(0.02, Math.min(0.3, v)); if (sel.size) for (const i of sel) mouldings[i].d = d; else mldD = d; V.wallsDirty = true; }, "Moulding depth");
  // color
  const colorInp = $("mld-color");
  if (colorInp) colorInp.addEventListener("input", () => {
    if (sel.size) setProp((m: any) => { m.color = colorInp.value; }, "Moulding color");
    else { mldColor = colorInp.value; saveState(); }
  });
  // Apply to every room on the visible level(s) — upsert (replace existing kind).
  $("mld-all")?.addEventListener("click", () => {
    const made: any = [];
    rooms.forEach((r, ri) => {
      if (!levelVisible(r.level)) return;
      if (!roomLoops[ri] || roomLoops[ri].length < 3) return;
      const ex = exists(ri, mldKind);
      if (ex >= 0) { const m = mouldings[ex]; m.profile = mldProfile; m.h = mldH; m.d = mldD; m.color = mldColor; }
      else { mouldings.push({ room: ri, kind: mldKind as MouldKind, profile: mldProfile, h: mldH, d: mldD, color: mldColor }); made.push(mouldings.length - 1); }
    });
    sel.clear(); made.forEach((i: any) => sel.add(i));
    V.wallsDirty = true; colorSel(); commit(`Apply ${mldKind} moulding to level`);
  });
  $("del-mld")?.addEventListener("click", deleteSel);

  // reflect the selection (or defaults) into the moulding inspector controls.
  syncMldPanel = () => {
    const m = sel.size ? mouldings[[...sel][0]] : null;
    const kind = m ? m.kind : mldKind;
    const prof = m ? (m.profile || "square") : mldProfile;
    if (kindSeg) kindSeg.querySelectorAll(".tool").forEach((b: any) => b.classList.toggle("active", b.getAttribute("data-kind") === kind));
    if (profGrid) profGrid.querySelectorAll(".style-card").forEach((c: any) => c.classList.toggle("active", c.getAttribute("data-profile") === prof));
    setNumField("t-mldh", m ? m.h : mldH);
    setNumField("t-mldd", m ? m.d : mldD);
    if (colorInp) colorInp.value = m ? (m.color || mldColor) : mldColor;
    const cnt = $("mld-count"); if (cnt) cnt.textContent = countLabel(sel.size, "moulding");
  };

  function update() { /* hover overlay is event-driven; nothing per-frame */ }

  V.mouldings = () => mouldings;
  // select(i): programmatic single-select (Layers panel / selectObject). §5.2
  function select(i: any) {
    if (i < 0 || i >= mouldings.length) return;
    sel.clear(); sel.add(i); colorSel();
    const el = $("moulding-controls"); if (el) el.style.display = "block";
  }
  // world-space bbox of the selected mouldings' runs (for zoom-to-selection).
  function selBox() {
    if (!sel.size) return null;
    const b = new THREE.Box3();
    for (const i of sel) {
      const m = mouldings[i], r = rooms[m.room]; if (!r) continue;
      const z = levelZ(r.level) + mouldingZ(m, wallH);
      for (const run of mouldingRuns(graph, roomLoops, doors, windows, m, wallH)) {
        b.expandByPoint(new THREE.Vector3(run.ax, run.ay, z));
        b.expandByPoint(new THREE.Vector3(run.bx, run.by, z + (m.h ?? 0.3)));
      }
    }
    return b.isEmpty() ? null : b;
  }
  // duplicateSel (§5.3): mouldings are unique per (room,kind) — duplication is a
  // no-op with a hint (you can't have two of the same kind in one room).
  function duplicateSel() {
    if (!sel.size) return;
    info.innerHTML = "A room has at most one moulding per kind — switch kinds to add another.";
  }

  colorSel();
  return { onDown, onMove, onUp, update, setActive, setMarkersVisible, setVisible, pickSelect, select, duplicateSel, selBox, refresh: colorSel, clearSel, hasSel: () => sel.size > 0 };
}

// --- Roof: place / move / resize / delete skylights and cuts ---------------
// Skylights are glazed openings; cuts are open-to-sky (the central patio is a
// default cut). Both are edited on the roof plane (z = top of the main walls).
function setupRoof(info: any) {
  const markers = new THREE.Group(); markers.visible = false; V.scene.add(markers); registerHandles(markers);
  const geo = new THREE.SphereGeometry(0.8, 16, 10);
  const matSky = new THREE.MeshBasicMaterial({ color: 0x6ec6e0 });     // skylight
  const matCut = new THREE.MeshBasicMaterial({ color: 0xffa14a });     // cut
  const matHover = new THREE.MeshBasicMaterial({ color: 0xffd479 });
  const matSel = new THREE.MeshBasicMaterial({ color: 0xff5a3c });
  const sel = new Set<string>();                  // selected keys ("sky:2" / "cut:0")
  let hover: any = null, drag: any = null, addKind = "sky", dedicated = false, selVis = false, domVisible = true;
  const plane = new THREE.Plane(), hit = new THREE.Vector3();

  // unified accessor over skylights + cuts
  const list = () => [
    ...skylights.map((s, i) => ({ kind: "sky", i, o: s })),
    ...roofCuts.map((c, i) => ({ kind: "cut", i, o: c })),
  ];
  const keyOf = (e: any) => `${e.kind}:${e.i}`;
  const opCenter = (e: any) => (e.kind === "cut" && e.o.poly)
    ? { x: polyCentroid(e.o.poly)[0], y: polyCentroid(e.o.poly)[1] } : { x: e.o.x, y: e.o.y };
  const roofTopZ = () => roofZBottom() + roofThickness;

  function rebuildMarkers() {
    markers.clear();
    for (const e of list()) {
      const m = new THREE.Mesh(geo, e.kind === "cut" ? matCut : matSky);
      m.userData.key = keyOf(e); m.userData.entry = e; markers.add(m);
    }
    placeMarkers(); colorMarkers();
  }
  function placeMarkers() {
    const z = roofTopZ() + 0.4;
    markers.children.forEach((m) => {
      const e = m.userData.entry; const c = opCenter(e);
      m.position.set(c.x, c.y, levelZ(1) - LEVEL_Z[1] + z);   // roof rides main; levelZ(1) handles stacking
      m.visible = levelVisible(1);
    });
  }
  function colorMarkers() {
    for (const m of markers.children) {
      const base = m.userData.entry.kind === "cut" ? matCut : matSky;
      (m as any).material = sel.has(m.userData.key) ? matSel : (m === hover ? matHover : base);
    }
    const cnt = $("roof-count");
    if (cnt) cnt.textContent = countLabel(sel.size, "opening");
    $("del-roof")?.classList.toggle("disabled", sel.size < 1);
    const rc = $("roof-controls");
    if (rc) rc.style.display = (markers.visible && (dedicated || sel.size > 0)) ? "block" : "none";
  }
  function refreshVis() { markers.visible = domVisible && (dedicated || selVis); if (markers.visible) placeMarkers(); else hover = null; colorMarkers(); }
  function setVisible(on: any) { domVisible = on; refreshVis(); }   // §5.2 Layers eye toggle (session-only)
  function setActive(on: any) { dedicated = on; refreshVis(); }
  function setMarkersVisible(on: any) { selVis = on; refreshVis(); }
  function clearSel() { sel.clear(); colorMarkers(); }
  const pick = (e: any) => (ray.setFromCamera(pointerNDC(e), V.camera),
    ray.intersectObjects(markers.children.filter((m) => m.visible), false)[0]?.object || null);
  // nearest SKYLIGHT to a roof-plane point (cuts need their marker, so the big
  // patio cut never hijacks a room click underneath it).
  function nearestSkyKey(x: any, y: any) {
    let best = null, bd = Infinity;
    skylights.forEach((s, i) => {
      const dist = Math.hypot(x - s.x, y - s.y), thr = Math.max(s.w, s.d) / 2 + 0.4;
      if (dist < thr && dist < bd) { bd = dist; best = `sky:${i}`; }
    });
    return best;
  }
  function pickSelect(e: any) {
    const mk = pick(e);
    let k = mk ? mk.userData.key : null;
    const p = roofPoint(e);
    if (!k && p) k = nearestSkyKey(p.x, p.y);
    if (!k) return false;
    if (e.shiftKey) { sel.has(k) ? sel.delete(k) : sel.add(k); } else { sel.clear(); sel.add(k); }
    colorMarkers();
    if (p) {
      V.controls.enableRotate = false;
      const start: Record<string, any> = {};
      for (const key of sel) { const en = entryFromKey(key); start[key] = en.o.poly ? en.o.poly.map((q: any) => [...q]) : { x: en.o.x, y: en.o.y }; }
      drag = { p0: p, start, moved: false };
    }
    return true;
  }
  // point on the roof plane under the cursor (stacked-aware)
  function roofPoint(e: any) {
    const z = levelZ(1) - LEVEL_Z[1] + roofTopZ();
    plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, z));
    ray.setFromCamera(pointerNDC(e), V.camera);
    return ray.ray.intersectPlane(plane, hit) ? { x: hit.x, y: hit.y } : null;
  }
  function entryFromKey(k: any) { const [kind, i] = k.split(":"); return { kind, i: +i, o: (kind === "sky" ? skylights[+i] : roofCuts[+i]) as any }; }

  function onDown(e: any) {
    const mk = pick(e);
    if (mk) {                                     // select / start drag
      const k = mk.userData.key;
      if (e.shiftKey) { sel.has(k) ? sel.delete(k) : sel.add(k); colorMarkers(); return; }
      if (!sel.has(k)) { sel.clear(); sel.add(k); colorMarkers(); }
      const p = roofPoint(e); if (!p) return;
      V.controls.enableRotate = false;
      const start: Record<string, any> = {};
      for (const key of sel) { const en = entryFromKey(key); start[key] = en.o.poly ? en.o.poly.map((q: any) => [...q]) : { x: en.o.x, y: en.o.y }; }
      drag = { p0: p, start, moved: false };
      return;
    }
    const p = roofPoint(e); if (!p) { if (!e.shiftKey) clearSel(); return; }
    const gx = snap(p.x, gridSize), gy = snap(p.y, gridSize);
    if (addKind === "cut") roofCuts.push({ x: gx, y: gy, w: skyW, d: skyD });
    else skylights.push({ x: gx, y: gy, w: skyW, d: skyD });
    V.wallsDirty = true; rebuildMarkers();
    sel.clear(); sel.add(addKind === "cut" ? `cut:${roofCuts.length - 1}` : `sky:${skylights.length - 1}`);
    colorMarkers(); commit(addKind === "cut" ? "Add roof cut" : "Add skylight");
    info.innerHTML = `${addKind === "cut" ? "Cut" : "Skylight"} added.`;
  }
  function onMove(e: any) {
    if (drag) {
      const p = roofPoint(e); if (!p) return;
      let dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
      if (gridSize > 0) { dx = snap(dx, gridSize); dy = snap(dy, gridSize); }
      for (const key of sel) {
        const en = entryFromKey(key), s = drag.start[key];
        if (en.o.poly && Array.isArray(s)) en.o.poly = s.map(([x, y]) => [x + dx, y + dy]);
        else { en.o.x = s.x + dx; en.o.y = s.y + dy; }
      }
      drag.moved = true; V.wallsDirty = true; placeMarkers();
      info.innerHTML = `Move: <span class="reading">${dx >= 0 ? "+" : ""}${dx.toFixed(1)}, ${dy >= 0 ? "+" : ""}${dy.toFixed(1)} ft</span>`;
      return;
    }
    const mk = pick(e); if (mk !== hover) { hover = mk; colorMarkers(); }
  }
  function onUp() { if (!drag) return; const d = drag; drag = null; updateOrbit(); if (d.moved) commit("Move roof opening"); }
  function resize(kind: any, v: any) {                       // kind 'w' | 'd'
    if (kind === "w") skyW = v; else skyD = v;
    for (const key of sel) { const en = entryFromKey(key); if (en.o.poly) continue; if (kind === "w") en.o.w = v; else en.o.d = v; }
    V.wallsDirty = true; placeMarkers(); saveState();
  }
  function deleteSel() {
    if (!sel.size) return;
    const skyDel: any = [], cutDel: any = [];
    for (const k of sel) { const [kind, i] = k.split(":"); (kind === "sky" ? skyDel : cutDel).push(+i); }
    skyDel.sort((a: any, b: any) => b - a).forEach((i: any) => skylights.splice(i, 1));
    cutDel.sort((a: any, b: any) => b - a).forEach((i: any) => roofCuts.splice(i, 1));
    sel.clear(); V.wallsDirty = true; rebuildMarkers(); commit("Delete roof openings");
  }
  function onKey(e: any) {
    if (mode !== "roof" && !(mode === "select" && sel.size)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && sel.size) { e.preventDefault(); deleteSel(); }
    else if (e.key === "Escape") clearSel();
  }
  addEventListener("keydown", onKey);

  const kindBtn = $("roof-kind");
  const syncKind = () => { kindBtn.textContent = addKind === "cut" ? "＋ Cut" : "＋ Skylight"; kindBtn.classList.toggle("active", addKind === "cut"); };
  kindBtn.onclick = () => { addKind = addKind === "cut" ? "sky" : "cut"; syncKind(); };
  syncKind();
  $("del-roof").onclick = deleteSel;
  const slider = (id: any, get: any, set: any, suffix: any) => {
    const el = $(id), val = $(id + "-v");
    el.value = get(); val.textContent = get() + suffix;
    el.oninput = (ev: any) => { val.textContent = (+ev.target.value) + suffix; set(+ev.target.value); commit("Roof opening size"); };
  };
  slider("t-skyw", () => skyW, (v: any) => resize("w", v), " ft");
  slider("t-skyd", () => skyD, (v: any) => resize("d", v), " ft");
  function update() { if (markers.visible) placeMarkers(); }

  rebuildMarkers();
  V.roof = () => ({ skylights, roofCuts });
  // select(flatIndex): the Layers panel lists skylights then cuts; map back to keys.
  function select(flat: any) {
    let key = null;
    if (flat >= 0 && flat < skylights.length) key = `sky:${flat}`;
    else if (flat - skylights.length >= 0 && flat - skylights.length < roofCuts.length) key = `cut:${flat - skylights.length}`;
    if (!key) return;
    sel.clear(); sel.add(key); colorMarkers();
    const el = $("roof-controls"); if (el) el.style.display = "block";
  }
  function selBox() {
    if (!sel.size) return null;
    const b = new THREE.Box3();
    const z = levelZ(1) - LEVEL_Z[1] + roofTopZ();
    for (const k of sel) {
      const e = entryFromKey(k), c = opCenter(e);
      const w = e.o.w ?? 4, d = e.o.d ?? 4;
      b.expandByPoint(new THREE.Vector3(c.x - w / 2, c.y - d / 2, z - 1));
      b.expandByPoint(new THREE.Vector3(c.x + w / 2, c.y + d / 2, z + 1));
    }
    return b.isEmpty() ? null : b;
  }
  // duplicateSel (§5.3): clone skylights/cuts offset by x+1, y+1.
  function duplicateSel() {
    if (!sel.size) return;
    const made = [];
    for (const k of [...sel]) {
      const [kind, i] = k.split(":");
      if (kind === "sky") { const s = skylights[+i]; skylights.push({ ...s, x: s.x + 1, y: s.y + 1 }); made.push(`sky:${skylights.length - 1}`); }
      else { const c = roofCuts[+i]; roofCuts.push({ ...c, x: (c.x ?? 0) + 1, y: (c.y ?? 0) + 1, poly: c.poly ? c.poly.map(([x, y]) => [x + 1, y + 1]) : undefined }); made.push(`cut:${roofCuts.length - 1}`); }
    }
    sel.clear(); made.forEach((k) => sel.add(k));
    V.wallsDirty = true; rebuildMarkers(); commit("Duplicate roof opening");
  }
  return { onDown, onMove, onUp, update, setActive, setMarkersVisible, setVisible, pickSelect, select, duplicateSel, selBox, refresh: rebuildMarkers, clearSel, hasSel: () => sel.size > 0 };
}

// --- First-person "drop-in" walkthrough (Google Street View style) ----------
// Reuses the PERSPECTIVE camera (V.pcam) + its OrbitControls target so the
// existing Blender render — which reads V.pcam.position + V.pctrl.target + fov —
// renders exactly this eye-level view with no extra plumbing. While active,
// `V.fpActive` tells the render loop to stop OrbitControls from re-driving the
// camera; this module positions it each frame instead.
function setupFirstPerson(info: any) {
  // yaw is measured CW from +Y (so yaw 0 looks toward the back of the house,
  // matching plan-up). pitch is up/down. eye = standing height above the floor.
  const fp = { pos: new THREE.Vector3(), yaw: 0, pitch: 0, eye: 5.5, fov: 70, level: 1, dropped: false };
  let active = false;        // Walk tool is selected
  let engaged = false;       // dropped in: we're driving the camera (orbit view replaced)
  let saved: any = null;
  let dragging = false, moved = false, downX = 0, downY = 0, lastX = 0, lastY = 0;
  let prevLabelDisp = "";
  const keys = new Set<string>();
  const SPEED = 9;                                 // walk speed, ft/sec
  let lastT = 0;

  // ground ring under the cursor: previews where a click will drop you in
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.85, 28),
    new THREE.MeshBasicMaterial({ color: 0x2aa5ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false }));
  ring.renderOrder = 999; ring.rotation.x = 0; ring.visible = false; V.scene.add(ring);

  const fwd = new THREE.Vector3(), rightV = new THREE.Vector3(), tgt = new THREE.Vector3();
  const dirVec = (out: any) => { const cp = Math.cos(fp.pitch); return out.set(cp * Math.sin(fp.yaw), cp * Math.cos(fp.yaw), Math.sin(fp.pitch)); };
  const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  function heading() {                             // +Y reads as North in plan; yaw is CW from +Y
    const deg = ((fp.yaw * 180 / Math.PI) % 360 + 360) % 360;
    return `${COMPASS[Math.round(deg / 45) % 8]} ${Math.round(deg)}°`;
  }

  // Drive the perspective camera from the fp state (and mirror target → controls
  // so cameraState()/the Blender render line up).
  function apply() {
    const cam = V.pcam;
    fp.pos.z = levelZ(fp.level) + fp.eye;          // ride the level's stack/explode offset
    cam.position.copy(fp.pos);
    dirVec(fwd); tgt.copy(fp.pos).add(fwd);
    cam.up.set(0, 0, 1); cam.lookAt(tgt);
    if (cam.fov !== fp.fov) { cam.fov = fp.fov; cam.updateProjectionMatrix(); }
    V.pctrl.target.copy(tgt);
    const hv = $("fp-head-v"); if (hv) hv.textContent = heading();
  }

  // Take over the camera: replace the live orbit view with the first-person eye.
  // (Called on the first floor-click, so the orbit viewport is preserved until
  // the user actually picks where to stand.)
  function engage() {
    if (engaged) return;
    engaged = true; V.fpActive = true;
    V.pctrl.enabled = false; V.controls.enabled = false;
    prevLabelDisp = V.labelHost.style.display; V.labelHost.style.display = "none";  // labels look wrong from inside
    lastT = 0;
  }
  // Teleport the eye to a floor point, facing the model center (street-view drop).
  function dropAt(x: any, y: any, level: any) {
    fp.pos.x = x; fp.pos.y = y; fp.level = level; fp.dropped = true;
    const dx = V.center.x - x, dy = V.center.y - y;
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) fp.yaw = Math.atan2(dx, dy);
    fp.pitch = 0; engage(); apply();
  }

  // raycast the visible floor/wall meshes → {point, level} | null
  function floorHit(e: any) {
    const hit = pickMeshes(e); if (!hit) return null;
    const level = hit.object?.userData?.level ?? (hit.point.z < levelSplitZ() ? 0 : 1);
    return { point: hit.point, level };
  }

  function setActive(on: any) {
    if (on === active) return;
    active = on;
    if (on) {
      // Arm drop-mode but KEEP the current viewport: we don't move the camera or
      // take over controls until the user clicks a spot to stand. We only ensure
      // we're on the perspective camera (first-person can't run in the ortho plan).
      engaged = false; fp.dropped = false; V.fpActive = false;
      saved = { pos: V.pcam.position.clone(), target: V.pctrl.target.clone(), fov: V.pcam.fov, view: V.view };
      if (V.view === "plan") {
        V.view = "persp"; V.setView("persp");
        const vm = $("view-mode");
        vm?.querySelectorAll(".tool").forEach((x: any) => x.classList.toggle("active", x.dataset.view === "persp"));
        document.body.classList.remove("planview");
      }
      document.body.classList.add("walking");
      const se = $("sel-empty"); if (se) se.style.display = "none";
      const wc = $("walk-controls"); if (wc) wc.style.display = "block";
      // sync panel inputs; heading stays blank until we actually drop in
      const eyeEl = $("t-eye"), eyeV = $("t-eye-v");
      if (eyeEl) { eyeEl.value = fp.eye; if (eyeV) eyeV.textContent = fp.eye + " ft"; }
      const fovEl = $("t-fov"), fovV = $("t-fov-v");
      if (fovEl) { fovEl.value = fp.fov; if (fovV) fovV.textContent = fp.fov + "°"; }
      const hv = $("fp-head-v"); if (hv) hv.textContent = "click a spot";
    } else {
      const wasEngaged = engaged;
      engaged = false; V.fpActive = false; keys.clear(); ring.visible = false; dragging = false;
      document.body.classList.remove("walking");
      const wc = $("walk-controls"); if (wc) wc.style.display = "none";
      // only restore the saved orbit view if we'd taken over; if we never dropped
      // in, the live viewport was never disturbed, so leave it exactly as-is.
      if (wasEngaged) {
        V.labelHost.style.display = prevLabelDisp;
        if (saved) {
          V.pcam.position.copy(saved.pos); V.pcam.fov = saved.fov; V.pcam.updateProjectionMatrix();
          V.pctrl.target.copy(saved.target);
        }
        V.pctrl.enabled = (V.view !== "plan"); V.controls.enabled = (V.view !== "plan");
        updateOrbit(); V.pctrl.update();
      }
    }
  }

  function onDown(e: any) {
    dragging = true; moved = false;
    downX = lastX = e.clientX; downY = lastY = e.clientY;
    ring.visible = false;
  }
  function onMove(e: any) {
    if (dragging && engaged) {                      // look around (only once we've dropped in)
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 3) moved = true;
      const sens = 0.0042;
      fp.yaw += dx * sens;                          // drag right → look right
      fp.pitch = Math.max(-1.45, Math.min(1.45, fp.pitch - dy * sens));
      apply();
      return;
    }
    // hover: preview the drop point on the floor
    const h = floorHit(e);
    if (h) { ring.position.set(h.point.x, h.point.y, levelZ(h.level) + 0.06); ring.visible = true; }
    else ring.visible = false;
  }
  function onUp(e: any) {
    if (!dragging) return;
    dragging = false;
    if (!moved) {                                   // a click (not a look-drag) → teleport there
      const h = floorHit(e); if (h) dropAt(h.point.x, h.point.y, h.level);
    }
  }

  function update() {                               // per-frame: smooth WASD walking
    if (!engaged) return;
    const now = performance.now();
    let dt = lastT ? (now - lastT) / 1000 : 0; lastT = now;
    dt = Math.min(dt, 0.05);
    if (!keys.size) return;
    let mF = 0, mR = 0;
    if (keys.has("w") || keys.has("arrowup")) mF += 1;
    if (keys.has("s") || keys.has("arrowdown")) mF -= 1;
    if (keys.has("d") || keys.has("arrowright")) mR += 1;
    if (keys.has("a") || keys.has("arrowleft")) mR -= 1;
    if (!mF && !mR) return;
    dirVec(fwd); fwd.z = 0; fwd.normalize();
    rightV.set(fwd.y, -fwd.x, 0);                   // forward × up (Z-up)
    const step = SPEED * dt;
    fp.pos.x += (fwd.x * mF + rightV.x * mR) * step;
    fp.pos.y += (fwd.y * mF + rightV.y * mR) * step;
    apply();
  }

  function setEye(v: any) {
    fp.eye = v;
    const eyeV = $("t-eye-v"); if (eyeV) eyeV.textContent = v + " ft";
    if (active) apply();
  }

  // held-key tracking + Q/E eye nudge + Esc, only while first-person is active
  addEventListener("keydown", (e) => {
    if (!active) return;
    if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) return;
    const k = e.key.toLowerCase();
    if (k === "escape") { V.setMode("select"); return; }
    if (!engaged) return;                           // movement applies only once dropped in
    if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) { keys.add(k); e.preventDefault(); }
    else if (k === "q") { setEye(Math.max(1, +(fp.eye - 0.25).toFixed(2))); const el = $("t-eye"); if (el) el.value = fp.eye; }
    else if (k === "e") { setEye(Math.min(10, +(fp.eye + 0.25).toFixed(2))); const el = $("t-eye"); if (el) el.value = fp.eye; }
  });
  addEventListener("keyup", (e) => { keys.delete(e.key.toLowerCase()); });

  // scroll to step forward/back along the view (OrbitControls wheel is disabled here)
  V.renderer.domElement.addEventListener("wheel", (e: any) => {
    if (!engaged) return;                           // pre-drop: let the orbit wheel-zoom work
    e.preventDefault();
    dirVec(fwd); fwd.z = 0; fwd.normalize();
    const s = -Math.sign(e.deltaY) * 1.4;
    fp.pos.x += fwd.x * s; fp.pos.y += fwd.y * s; apply();
  }, { passive: false });

  // panel wiring (elements exist after the React UI mounts)
  const eyeEl = $("t-eye");
  if (eyeEl) eyeEl.oninput = (e: any) => { setEye(+e.target.value); };
  const fovEl = $("t-fov");
  if (fovEl) fovEl.oninput = (e: any) => {
    fp.fov = +e.target.value;
    const v = $("t-fov-v"); if (v) v.textContent = fp.fov + "°";
    if (active) apply();
  };
  const center = $("fp-center");
  if (center) center.onclick = () => { if (active) dropAt(V.center.x, V.center.y, fp.level); };

  return { onDown, onMove, onUp, update, setActive, clearSel: () => {} };
}

// ---------------------------------------------------------------------------
// Fully realtime: floors + walls + doors are built in three.js from the shared
// node graph (src/walls.js). OpenSCAD remains the export format (floorplan.scad).
// Boot: restore the on-disk floorplan.scad's embedded state (the source of truth)
// BEFORE building geometry, then build. A pending Reset skips the restore so the
// seed model is built and then auto-saved over the file.
(async function boot() {
  let resetReq = false;
  try { resetReq = sessionStorage.getItem("kirkham-reset") === "1"; sessionStorage.removeItem("kirkham-reset"); } catch (e: any) {}
  if (!resetReq) restored = await loadStateFromServer();
  try {
    build();
    booting = false;                       // auto-save is now live
    if (!restored) flushSave();            // initialize/overwrite floorplan.scad with the current model
  } catch (e: any) { console.error(e); fail(String(e.message || e)); }
})();
