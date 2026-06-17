# Kirkham Editor — Mode-Based UX Redesign

**Goal:** make the editor feel like Figma — single-user, but with Figma's discipline:
select-by-default, context-driven inspector, live layers, keyboard-first — specialized
for **architecture + interior design** via **modes**. A mode focuses the whole UI
(toolbar, inspector, canvas emphasis, picking) on one domain: Layout, Doors, Windows,
Moulding, Cabinets, Furniture, Structure, Tour. Everything continues to persist to
`floorplan.scad` (state header + generated OpenSCAD geometry).

This document is the implementation spec. Phases at the bottom are **ordered**; each
operation lists exact files, functions, and acceptance criteria. Implementers: read the
whole doc before starting a phase; follow the existing engine patterns described in
§2 — do not rewrite the engine.

---

## 1. UX review of the current editor

### What is already Figma-like (keep, do not regress)

- **Select is the default tool; orbit is deliberate** (Space / middle-drag / Orbit tool).
  `controls.mouseButtons.LEFT = -1` outside orbit. This is the single best decision in
  the current UX — preserve it everywhere.
- **Uniform selection model** across all object tools: click selects, Shift adds,
  marquee box-selects (walls), drag moves, Delete deletes, explicit Weld. Keep this
  contract for every new domain.
- **Per-edit undo history with a clickable timeline**, per-scenario-state.
- **Align/distribute** for wall nodes (Figma's align bar, correctly disabled by count).
- **Auto-save with visible save status**; on-disk `.scad` is the single source of truth.
- **Live dimension guides** while dragging wall nodes (ray-cast ft-in labels).
- **Plan/3D toggle** where every tool works identically in both views.

### Gaps vs. Figma (what this redesign fixes)

| # | Gap | Figma behavior | Fix (phase) |
|---|-----|----------------|-------------|
| G1 | One flat toolbar of 10 tools mixing navigation (Orbit, Walk), inspection (Measure), and six editing domains | Tools are few and contextual; modes (Design/Proto/Dev) re-skin the whole UI | Mode system (P1) |
| G2 | No keyboard shortcuts for tools/modes (only R/F/Delete inside tools) | V/H/R/T… single-key tools | Mode keys 1–8, tool keys (P1) |
| G3 | Right panel always shows Display/Dimensions/Sun/Export — scene globals — above the selection | Right panel = properties of *selection*; file/canvas settings live elsewhere | Design/Scene tabs (P1) |
| G4 | Sliders double as "edit selection" *and* "defaults for new objects" with no indication which | Properties always describe the selection; placement defaults are remembered silently | Inspector header states scope (P1), NumFields (P2) |
| G5 | Layers panel is a static room list rendered once from the seed `ROOMS` — it ignores edits, and lists only rooms | Layers reflect the live document; click row = select; eye = hide | Live layers (P2) |
| G6 | No numeric entry — sliders only; can't type 2'6" | Numeric fields everywhere, scrubbed or typed | NumField (P2) |
| G7 | No duplicate (Cmd+D / Alt-drag), no copy/paste | Core editing verbs | Duplicate (P2) |
| G8 | No zoom indicator, no zoom-to-fit / zoom-to-selection | Shift+1 / Shift+2, % readout | (P2) |
| G9 | `window.prompt`/`confirm` for scenario rename/delete | Inline editing | (P2) |
| G10 | Doors are one generic slab leaf — no styles, no casing, nothing to "focus on how our doors look" | n/a (domain) | Doors mode (P3) |
| G11 | No moulding at all (baseboard/crown/chair rail/casing) | n/a (domain) | Moulding mode (P4) |
| G12 | "Cabinet" is a generic furniture box + countertop — no fronts, kinds, toe kick, runs | n/a (domain) | Cabinets mode (P5) |
| G13 | Tool hints exist but selection-specific shortcuts are undiscoverable | Tooltips show shortcuts | Hints carry keys (P1) |

### Engine/architecture observations (constraints on the design)

- `src/main.js` (~3000 lines) is an imperative engine wired to React-rendered DOM by
  element id. The React side is intentionally **uncontrolled** (`defaultValue`,
  engine reads/writes DOM). This pattern is proven here — the redesign **keeps it**
  and adds one narrow event bridge for the layers panel (§5.2) rather than converting
  to React state.
- Every object domain follows one pattern: a **pure parts/geometry function** shared
  by the three.js builder and the SCAD exporter, a `setup<Domain>(info)` tool closure
  with `{setActive, setMarkersVisible, clearSel, refresh, update, onDown/onMove/onUp,
  onKey}`, a `commit(label)` into history, fields in `stateBlob()` / `applyState()` /
  `snapshot()` / `applySnap()`, and a `SYNC_COLL` entry for A→B propagation.
  **Every new domain in this doc must follow that exact pattern.**
- `rebuildWalls()` is the universal "geometry changed" hook — new domain meshes are
  rebuilt there.
- No tests exist in the repo. Phase 0 adds a Node test harness; every later phase
  adds tests for its pure functions.

---

## 2. Engine patterns reference (for implementers)

Read these before writing code:

- **State + persistence:** `stateBlob()` / `applyState()` / `extractState()` /
  `fileScad()` in `src/main.js` (~lines 114–220). The blob is embedded base64 in a
  `/* KIRKHAM-STATE-V1 … */` header. New fields are added to the blob and read
  defensively in `applyState` (missing → defaults), so v1 files keep loading. Keep
  the tag `KIRKHAM-STATE-V1` (the format is forward-compatible by field addition).
- **History:** `snapshot()` / `commit(label)` / `applySnap()` (~lines 221–550).
  New per-state collections must be cloned in `snapshot` and restored in `applySnap`.
- **A→B sync:** `SYNC_COLL` + `propagateEdit` (~lines 249–319). New collections get
  an entry with an identity function.
- **Tool template:** `setupDoors(info)` (~line 1903) is the canonical
  marker-based tool: a `THREE.Group` of marker meshes, `rebuildMarkers/placeMarkers/
  colorMarkers`, `refreshVis` (dedicated vs. select-mode visibility), pick → select →
  drag → `commit`. `setupFurniture` shows footprint objects; `setupRoof` shows
  plane-picked objects.
- **Geometry builders:** `buildWallGeo` / `buildFurnitureGeo` / `buildDoorLeaves` —
  merge `THREE.BoxGeometry` parts via `mergeGeometries`, dispose parts, per-vertex
  color when multi-colored. New builders are registered in `rebuildWalls()` and as
  meshes in `build()`'s mesh table (`V.meshes["<lvl>-<key>"]`, with
  `userData.level`, added to the level group so they ride stack offset + floor
  filter), and in `GLB_NAMES` for export.
- **SCAD export:** `roomsToScad(...)` in `src/scad.js` — every domain is a data
  table + a parametric module; flattened-box domains (furniture) emit
  `[x, y, z, sx, sy, sz, "color", level]` rows drawn by `furniture_parts()`.
  Wall-aligned domains (mouldings) emit segment rows drawn by a
  `translate+rotate+cube` module (like walls). The exported file must remain a
  valid standalone OpenSCAD model.
- **UI wiring:** React components render elements with stable ids; the engine
  attaches handlers in `build()` / `setupTools()`. Subpanels in the right panel are
  shown/hidden by the engine via `style.display`.

---

## 3. The mode system

### 3.1 Modes

A **mode** scopes the editor to one domain. Switching modes changes: (a) the tool
set in the bottom toolbar, (b) the inspector sections in the right panel, (c) canvas
emphasis (focus dimming), (d) pick priority, (e) marker visibility. Modes do NOT
change the model — they are pure view/tool scoping.

| Key | Mode | Tools (first = default) | Domain objects | Canvas emphasis |
|-----|------|------------------------|----------------|-----------------|
| `1` | **Layout** | Select `V` · Walls `W` · Measure `M` | walls, rooms | everything full; labels available |
| `2` | **Doors** | Select `V` · Place Door `D` | doors (+ casing) | doors/casings full; walls ghost 0.35; furniture/cabinets ghost 0.15; roof hidden-style |
| `3` | **Windows** | Select `V` · Place Window `N` | windows (+ casing) | windows/glass full; walls ghost 0.35; rest ghost 0.15 |
| `4` | **Moulding** | Select `V` · Apply Moulding `A` | mouldings | mouldings full; walls 0.85 (mouldings sit on them); furniture/cabinets ghost 0.15; roof hidden |
| `5` | **Cabinets** | Select `V` · Place Cabinet `C` | cabinets | cabinets full; walls 0.5; furniture ghost 0.25; roof hidden |
| `6` | **Furniture** | Select `V` · Place Furniture `F` | furniture | furniture full; walls 0.5; cabinets 0.25 |
| `7` | **Structure** | Select `V` · Stairs `S` · Roof `R` · Measure `M` | stairs, roof cuts/skylights | all full; roof ghosts while Roof tool active (existing behavior) |
| `8` | **Tour** | Walk (only tool) | — | all full, labels hidden (existing walk behavior) |

Global, mode-independent: orbit (Space / middle-drag), pan (right-drag / arrows),
3D/Plan toggle, floor filter, undo/redo, zoom (P2), scenario strip, Render, Save.
The standalone **Orbit** tool is removed from the toolbar (Space/middle-drag covers
it; Tour mode covers "just looking"). The Measure tool appears in Layout and
Structure; `M` works in any mode by temporarily switching to it (one-shot overlay
tool — implement as: pressing `M` in any mode activates measure within the current
mode's toolbar without changing mode).

Mode is **session UI state, not model state** — it is NOT persisted to the `.scad`
header. On load, the editor opens in Layout mode.

### 3.2 Mode bar (React)

`src/ui/components/ModeBar.tsx` — a horizontal segmented control rendered in the
**top bar center** (replacing the current centered 3D/Plan seg, which moves right of
it): `Layout · Doors · Windows · Moulding · Cabinets · Furniture · Structure · Tour`.
Each segment shows its key number in a faint chip on hover (`title="Doors — 2"`).
Active segment uses the existing `.tool.active` styling. Element: `#mode-bar` with
`.tool[data-mode="layout"]` … wired by the engine like `#view-mode`.

### 3.3 Engine: mode manager (`src/main.js`)

```js
const MODES = {
  layout:    { tools: ["select","edit","measure"],            focus: {...} },
  doors:     { tools: ["select","doors"],                     focus: {...} },
  windows:   { tools: ["select","windows"],                   focus: {...} },
  moulding:  { tools: ["select","moulding"],                  focus: {...} },
  cabinets:  { tools: ["select","cabinets"],                  focus: {...} },
  furniture: { tools: ["select","furniture"],                 focus: {...} },
  structure: { tools: ["select","stairs","roof","measure"],   focus: {...} },
  tour:      { tools: ["walk"],                               focus: {...} },
};
let uiMode = "layout";
function setUiMode(m) { ... }   // exposed as V.setUiMode
```

`setUiMode(m)`:
1. Sets `uiMode`, toggles `.active` on `#mode-bar` segments.
2. Shows only that mode's tool buttons in the bottom toolbar (buttons carry
   `data-modes="layout structure"`; the React toolbar renders ALL tool buttons once,
   the engine hides non-mode ones via `style.display`).
3. Calls `setMode(defaultTool)` — the mode's first tool. If the previously active
   tool belongs to the new mode, keep it.
4. Shows only inspector sections whose `data-mode` matches (see §3.5).
5. Applies focus dimming (§3.4).
6. Restricts `setupSelect` picking to the mode's domains plus walls/rooms
   (read-only info clicks are always allowed; in Doors mode clicking a wall shows
   the wall panel but with an "Add door (D)" affordance instead of "Edit points").
7. Updates the hint line (`#toolinfo`).

Selection is cleared on mode switch (`V.clearSelections()`), mirroring Figma's
page-switch behavior and avoiding cross-domain panel states.

Keyboard: digits `1`–`8` (when not in an input and no Cmd/Ctrl) call `setUiMode`;
per-mode tool keys (V, W, M, D, N, A, C, F, S, R) call `setMode` if the tool is in
the current mode. Keep existing R/F semantics *inside* tools (rotate/flip) — tool
hotkeys are checked only when they don't collide with an active tool's own key
handler; concretely: tool-switch keys are handled in the global keydown ONLY if no
object is selected in the active tool, otherwise the tool's `onKey` wins (e.g. `R`
rotates the selected stair; with nothing selected `R` switches to the Roof tool in
Structure mode).

### 3.4 Focus dimming

```js
// per-mode emphasis: meshKey-pattern → opacity (1 = full). Patterns match the
// V.meshes key suffix: floor, wall, door, doorglass, arc, glass, stair, furn,
// cab, mld, roof, roofglass.
focus: { wall: 0.35, furn: 0.15, ... }    // unlisted keys = 1.0
```

`applyFocus(focusSpec)` in `main.js`: for every mesh in `V.meshes`, set
`material.transparent/opacity` from the spec (cloning the material once per mesh on
first dim, caching as `mesh.userData.dimMat` — do NOT mutate shared materials, e.g.
`floorMat` is shared by both levels). Opacity 1 restores the original material.
The roof keeps its special always-cast-shadow handling: focus dimming for the roof
sets the same `setRoofView("hidden")` path rather than a material override.
Floors and the active domain are never dimmed. Dimmed meshes also get
`userData.noPick = true`, which `pickMeshes` honors (skip), so ghosted objects
can't steal clicks.

### 3.5 Right panel: Design / Scene tabs

`RightPanel.tsx` gets two real tabs (currently a decorative single "Design" tab):

- **Design** (default): the selection inspector. Contains the existing per-domain
  subpanels (`#edit-controls`, `#door-controls`, …) plus new ones (door style,
  moulding, cabinet). Each subpanel root carries `data-mode` (space-separated list)
  and the engine hides panels not in the current mode *in addition to* the existing
  selection-driven show/hide. Subpanel headers state scope explicitly:
  `"3 doors selected"` / `"New doors will use these settings"` when nothing is
  selected (fixes G4).
- **Scene**: Display toggles (walls/labels/framing/roof/explode/grid), Dimensions
  (wall height, doors open), Sun, Export/Save/Reset — exactly the sections that are
  global today, moved verbatim (same ids, so engine wiring is untouched).

Tab state is plain React `useState`; both tab contents stay mounted (`display:none`
when inactive) so engine id-wiring never breaks.

---

## 4. New domain objects

Units are feet everywhere. All new geometry follows the pure-parts pattern:
`<domain>Parts(obj)` returns axis-aligned or leaf-local boxes consumed by both the
three.js builder and `scad.js`.

### 4.1 Doors v2 (`src/doors.js`, new module)

**Model.** Extend each door object (backward compatible — all new fields optional):

```js
door = {
  wall, t, w, side, hinge,            // existing
  style: "slab",                      // "slab" | "panel2" | "panel5" | "glazed15" | "french" | "double"
  color: "#8a5a3c",                   // leaf color
  casing: true,                       // casing trim around the opening (both faces)
}
```

**Style catalog** (`DOOR_STYLES`, exported):

| id | label | leaf construction |
|----|-------|-------------------|
| `slab` | Slab | one box, 0.15 thick |
| `panel2` | 2-Panel Shaker | stiles 0.38 w, top rail 0.38, mid rail 0.5, bottom rail 0.75; 2 recessed panels (0.07 thick, centered) |
| `panel5` | 5-Panel | stiles 0.38; 5 stacked recessed panels separated by 0.3 rails |
| `glazed15` | 15-Lite Glazed | stiles/rails 0.38; 3×5 glass lite grid, muntins 0.1 |
| `french` | French Pair | two `glazed15` leaves of w/2, hinged at opposite jambs, mirrored swing |
| `double` | Double Slab | two slab leaves of w/2, opposite jambs |

**Pure functions** (in `src/doors.js`):

```js
// LEAF-LOCAL frame: x along the leaf from the hinge (0..leafW), y = thickness
// across (centered on 0, total 0.15), z = up (0..leafH).
// Returns { solids: [box...], glass: [box...] } where box =
//   { x0,x1, y0,y1, z0,z1, color }.
export function doorLeafParts(styleId, leafW, leafH, color)

// Leaves for a door: [{ hingeT: 0|1, swingSign: ±1, w: leafW }] — one entry for
// single styles, two for french/double (hinges at both jamb ends, meeting mid).
export function doorLeaves(styleId, w)

// Casing parts in WALL-LOCAL frame (x along wall, y across, z up), both faces:
// two legs + head per face, cross-section CASING_W=0.30 × CASING_T=0.07 proud of
// each wall face. Returns [box...]. Interrupt nothing (casing surrounds opening).
export function casingParts(openingW, openingH, wallT)
```

**Viewer** (`src/main.js`):
- `buildDoorLeaves(level)` rewritten: for each door, for each leaf from
  `doorLeaves`, compute hinge point + open angle exactly as today (`doorFrame` —
  for the second leaf, mirror: hinge at the other jamb, angle mirrored), then
  transform each `doorLeafParts` box by the leaf rotation matrix
  (`makeRotationZ(ang).setPosition(...)`). Solid boxes → `<lvl>-door` mesh with
  per-vertex color (leaf color); glass boxes → new mesh key `<lvl>-doorglass`
  using the existing window glass material. Swing arcs unchanged (per leaf).
- `buildWallGeo`: when `door.casing`, append `casingParts` boxes oriented by the
  wall angle (reuse `bandBox`-style transform) into the wall mesh — color is wall
  color; casing reads by relief, which is sufficient at this fidelity.
- New mesh keys registered in `build()`, `rebuildWalls()`, `GLB_NAMES`
  (`Main-DoorGlass` / `Lower-DoorGlass`).

**Inspector** (`RightPanel.tsx`, inside `#door-controls`, `data-mode="doors"`):
- Style cards: a 3×2 grid of buttons `#door-style .style-card[data-style=…]`, each
  an inline SVG front-elevation glyph (24×40) of the style. Engine wires clicks:
  with selection → retype selection + `commit("Door style")`; without → set default
  for new doors.
- `Width` NumField (1.5–8), `Color` input, existing Flip swing / Flip hinge /
  Delete buttons. Casing `Toggle id="t-doorcasing"`.

**SCAD** (`src/scad.js`):
- Door openings continue to be subtracted exactly as today (unchanged cut logic).
- Replace the current leaf drawing with a flattened parts table: for each door,
  flatten its leaves' `doorLeafParts` boxes through the same rotation math into
  world space; emit `DOOR_PARTS = [ [x, y, z, sx, sy, sz, "color", level], … ]`
  rows *for axis-aligned leaves* — but leaves are rotated by swing, so instead emit
  leaf-local rows plus placement:
  `DOOR_LEAVES = [ [level, hx, hy, angDeg, leafW, leafH], … ]` and
  `DOOR_LEAF_PARTS = [ [leafIdx, x0, y0, z0, sx, sy, sz, glass(0|1), "color"], … ]`,
  drawn by `module door_leaves()` =
  `for(p) translate hinge → rotate([0,0,ang]) → translate part → cube`.
  Casing: emit into a `CASINGS` segment table drawn with the same
  translate/rotate/cube pattern as walls. Glass parts go into the existing
  glass-colored union. Swing arcs keep the existing arc drawing (per leaf).
- The legacy `door()` module is deleted; `-D DOOR_OPEN` keeps working (angle
  parameter feeds the leaf rotation).

**Sync (`SYNC_COLL`):** doors already sync by wall; unchanged (style/color/casing
are properties of the same object, so property-edit propagation covers them).

### 4.2 Moulding (`src/moulding.js`, new module)

**Model.** Mouldings are applied **per room, per kind** — one assignment paints the
room's full interior perimeter; that matches how trim is actually specified, and
gives one-click application. New top-level collection:

```js
mouldings = [ { room: 4, kind: "base", profile: "stepped", h: 0.45, d: 0.06,
                color: "#f0ece4" }, … ]
// room = index into rooms/roomLoops · kind = "base" | "crown" | "chair"
// h = profile height (ft) · d = depth proud of the wall face (ft)
// invariant: at most ONE moulding per (room, kind) — re-applying replaces.
```

Kind defaults: base `h .45 d .06 z=floor`, crown `h .35 d .05 z=wallH−h`,
chair `h .2 d .04 z=2.7`.

**Profiles** (`MOULDING_PROFILES`): each profile is a list of stacked sub-boxes as
fractions of (h, d), bottom-up — pure data, drawn identically in three.js and SCAD:

| id | label | sub-boxes (zFrac0, zFrac1, dFrac) |
|----|-------|------------------------------------|
| `square` | Square | (0, 1, 1.0) |
| `stepped` | Stepped | (0, .8, .7), (.8, 1, 1.0) |
| `cove` | Cove | (0, .55, 1.0), (.55, .8, .66), (.8, 1, .33) |

(For crown, sub-boxes are mirrored vertically — the deep face is at the top.)

**Pure functions:**

```js
// The wall RUNS of a room's interior perimeter at a given level: walk the room's
// loop edges; each run = { ax, ay, bx, by } displaced INWARD (toward the room
// interior) by WALL_T/2 + d/2 along the edge normal; the inward side is determined
// by the loop winding (use signed area to orient the loop CCW first).
// Base & chair runs are INTERRUPTED at door openings on that wall (reuse the
// solidSpans interval subtraction over the door spans, mapping wall-t spans onto
// the run); crown runs are continuous. Windows interrupt a run only if the
// profile's z-band intersects the window band (chair rail vs. low sills).
export function mouldingRuns(graph, roomLoops, doors, windows, mld, wallH)
  // → [ { ax, ay, bx, by }, … ]   (already split at openings)

// Stacked boxes for one run: profile sub-boxes × run length, in WALL-RUN-LOCAL
// frame (x along run 0..len, y across centered, z 0..h). → [box…]
export function mouldingRunParts(profileId, kind, len, h, d)
```

**Viewer:** `buildMouldingGeo(level)` → mesh `<lvl>-mld` (per-vertex color from
`mld.color`), rotated/translated per run like `pushWallBox`. Registered in
`build()`, `rebuildWalls()`, `GLB_NAMES` (`Main-Moulding`/`Lower-Moulding`).
zBase per kind: base 0, chair 2.7, crown `wallH − h` (crown follows the wall-height
slider because `buildMouldingGeo` reads live `wallH`).

**Tool** (`setupMoulding(info)` in `main.js`, standard template):
- Hover (in Apply tool): the room under the cursor highlights (reuse the floor-face
  centroid lookup from `setupSelect.roomAt`); a floating hint shows
  `"Apply base · stepped to Kitchen"`.
- Click a room → if a moulding of the current kind exists there, **select** it;
  otherwise **create** one from the inspector's current kind/profile/dims and
  select it. `commit("Apply base moulding")`.
- Select tool (in Moulding mode): clicking near a moulded wall base/crown selects
  that room's moulding (pick = nearest run within 0.6 ft of the click point at the
  profile's z-band).
- Shift = multi-select (e.g. select base in 4 rooms, change profile once).
- Delete removes selected mouldings. `commit("Delete moulding")`.
- "Apply to all rooms on this level" button `#mld-all` (applies current settings to
  every room on the visible level; one commit).

**Inspector** (`#moulding-controls`, `data-mode="moulding"`): kind segmented control
(`Base · Chair · Crown`), profile cards (SVG cross-section glyphs), `Height` and
`Depth` NumFields, color input, count label, Delete + Apply-to-level buttons.

**Persistence/sync:** `mouldings` added to `stateBlob`, `applyState`, `snapshot`,
`applySnap`; `SYNC_COLL.mouldings = { id: (o) => o.room + ":" + o.kind }`.

**SCAD:** emit `MLD_RUNS = [ [level, ax, ay, bx, by, z0, h, d, profileCode, crown(0|1), "color"], … ]`
+ `module mouldings()` that, per row, per profile sub-box: `translate([ax,ay,z])
rotate([0,0,atan2(by-ay,bx-ax)]) translate([0,-dd/2,zz]) cube([len, dd, hh])`.
Profile fractions are duplicated as SCAD constants (3 profiles × 3 numbers — keep
them in sync with `MOULDING_PROFILES` via a generated comment). Mouldings are
unioned with the walls so the export stays one manifold per level.

### 4.3 Cabinets (`src/cabinets.js`, new module)

Cabinets become their own first-class domain (the legacy `furniture` "cabinet" type
remains for old files; the Furniture inspector drops it from the *new piece* type
list but still renders existing ones).

**Model.** New top-level collection:

```js
cabinets = [ { level, x, y, w, d, h, dir,        // footprint + facing, like furniture
               kind: "base",                      // "base" | "wall" | "tall"
               front: "shaker",                   // "slab" | "shaker"
               drawers: 1,                        // 0..3 top drawer rows (base/tall only)
               counter: true,                     // countertop slab (base only)
               mount: 0,                          // bottom z-offset from floor (wall: 4.5)
               color: "#9aa3ad", counterColor: "#dcd8d0" }, … ]
```

Kind defaults: base `w 2, d 2, h 3, mount 0, counter true`; wall `w 2, d 1.083,
h 2.5, mount 4.5, counter false`; tall `w 2, d 2, h 7, mount 0, counter false`.

**Pure function** `cabinetParts(c)` → `[box…]` (axis-aligned, leaf-local z from
`mount`), same box record as `furnitureParts`:

- **Toe kick** (base/tall): footprint inset 0.25 on the front face, height 0.3,
  color `shade(color, -0.25)`.
- **Carcass**: box from toe-kick top (or `mount`) to `h − counterT` (base) / `h`.
- **Fronts**: split `w` into door bays of max 1.75 each (`nDoors = ceil(w/1.75)`).
  Per bay: `slab` → one 0.08-thick box proud of the front face; `shaker` → frame
  rails/stiles 0.2 wide × 0.08 thick + recessed center panel 0.03 thick. Drawer
  rows (height 0.55 each, at the top, full bay width) reduce the door height; each
  drawer face matches the front style (slab face or shaker mini-frame).
- **Pulls**: 0.04×0.04×0.35 bar per door (vertical, latch side) and per drawer
  (horizontal, centered), color `#3a3a3a`.
- **Countertop** (base with `counter`): slab `counterT = 0.13` with 0.1 overhang on
  the front + exposed sides; `counterColor`.
- All front geometry is placed on the `dir` face via the same `backRect`/`sideRects`
  helpers pattern as `furniture.js` (import `shade` from there).

**Tool** (`setupCabinets(info)`, standard template, closest analog `setupFurniture`):
- **Place Cabinet (C):** click the floor → the cabinet **snaps its back to the
  nearest wall** within 3 ft (`nearestWall`), `dir` facing away from the wall,
  position grid-snapped along it; no wall nearby → free placement facing `+y`.
- **Drag** slides along its wall (project drag onto the wall axis) when wall-backed,
  free 2D move otherwise. **Adjacency snap:** while dragging, if an end lands
  within 0.4 ft of another cabinet's end on the same wall, snap flush.
- R rotate, Delete, Shift multi-select — identical to furniture.
- Markers + body both pickable (like furniture/stairs).

**Inspector** (`#cabinet-controls`, `data-mode="cabinets"`): Kind segmented control
(Base/Wall/Tall — retypes selection, applies kind defaults to d/h/mount), front
style cards (Slab/Shaker), `Width`/`Depth`/`Height` NumFields, `Drawers` stepper
(0–3), `Counter` toggle, `Mount height` NumField (wall cabinets), two color inputs,
Rotate/Delete buttons.

**Viewer:** `buildCabinetGeo(level)` → mesh `<lvl>-cab` (vertex colors), registered
in `build()`/`rebuildWalls()`/`GLB_NAMES` (`Main-Cabinets`/`Lower-Cabinets`).

**Persistence/sync:** add `cabinets` to blob/snapshot/sync
(`SYNC_COLL.cabinets = { id: (o) => o.kind }`); SCAD: flatten `cabinetParts` to
`CAB_PARTS` rows `[x, y, z, sx, sy, sz, "color", level]` drawn by the **existing**
`furniture_parts()`-style module (add `module cab_parts()` duplicating it over the
new table — keep tables separate so levels/domains stay readable).

### 4.4 Labels (`src/normalize.js`, Phase 7)

Labels are **positionable text annotations** carried by the state header only —
there is **no SCAD geometry** (annotations don't belong in the exported model).
They replace the old derived room-name divs with a real, editable collection.

**Model.** New top-level collection:

```js
labels = [ { text, x, y, level }, … ]
// text  = display string · x, y = world feet at the label anchor · level = 0|1
```

`labels` starts as the **null sentinel** ("legacy state, needs seeding"). On load
`applyState` assigns it only when `Array.isArray(s.labels)`; otherwise it stays
null, and `build()` seeds one label per named room from `seedLabels(rooms)` the
first time `rooms` exists (a silent migration — no commit; the next auto-save
persists it). Rooms are not renameable, so a seeded label can never go stale.

**Pure functions** (`src/normalize.js`, shared with tests):

```js
// coerce a partial/legacy record to the full shape.
normLabel(l)  → { text: String(l.text ?? "Label"), x: +l.x||0, y: +l.y||0,
                  level: l.level === 0 ? 0 : 1 }
// one label per NAMED room (skip "Stair"), centered on the room footprint.
seedLabels(rooms) → [{ text: r.name, x: r.x+r.w/2, y: r.y+r.d/2, level: r.level }, …]
```

**Rendered labels** (`src/main.js`). `buildLabels()` renders `V.labels =
labels.map((lb,i) => { el, lb, i })` into `#labels` (`V.labelHost`); `placeLabels`
projects each to `(lb.x, lb.y, levelZ(lb.level)+0.3)` every frame. `.dim` when
`level === 0`; hidden when `!levelVisible(lb.level)`. `rebuildWalls()` rebuilds the
divs, so every model-changing path (applySnap/applyState restores + tool edits)
re-renders them. Selected divs get `.label.sel` (the orange `#ff8c42` accent).

**Tool** (`setupLabels(info)`, standard closure contract). Labels stay
`pointer-events:none` until the tool toggles `labels-live` on `V.labelHost` via
`setMarkersVisible` (so labels are clickable/draggable in **Labels mode AND the
Select tool**, matching the `sel || m === "labels"` pattern). `V.labelDown` is
registered on each div by `buildLabels`: a div click selects (Shift = multi) and
starts a drag; the drag unprojects the pointer onto the plane `z =
levelZ(level)+0.3` and live-updates `lb.x/lb.y`, committing `"Move label"` on
release (both Plan and 3D, via ray-plane). The drag's move/up are listened at the
window level (the div holds pointer capture, so they don't reach the canvas — and
a drag can begin in Select mode where `route()` wouldn't call the tool). With the
Labels TOOL active, a canvas click that misses any label **adds** a label at the
floor point, selects it, commits `"Add label"`, and focuses `#label-text` for
immediate rename. `onKey`: Delete/Backspace remove; Escape clears. `duplicateSel`
clones +1/+1 ft; `selBox` is each anchor ±1 ft. `select(i)` (Layers panel) only
selects — `V.selectObject` centers the viewport afterwards (see below).

**Jump-to-selection (all domains).** `V.selectObject(kind, i)` centers the
viewport on every Layers click, not just labels: rooms center on the room rect;
every other domain centers on `tool.selBox()` after `tool.select(i)`. Without
this, a sidebar click on a Rooms row (whose names mirror the seeded labels) was
invisible — the original bug report.

**`V.centerOn(x, y, z)` contract** (defined in `build()` next to `V.frameBox`): a
**pan-only** recenter that preserves zoom and orbit — Plan moves the ortho camera
+ target in XY (keeping `center.z`); 3D shifts both camera and target by the same
delta so `(x,y,z)` lands at the view center. The move is a ~280 ms ease-in-out
glide (an instant jump over a short pan reads as "nothing happened"); a newer
`centerOn` call cancels an in-flight glide. (Viewport clicks select but do NOT
center — only the Layers row jump centers.)

**Mode.** `MODES.labels = { tools: ["select","labels"], focus: {} }`; key `9`.
Entering Labels mode force-shows `V.labelHost` regardless of `#t-labels`; leaving
restores the checkbox's state (handled in `setUiMode`). First-person walk still
hides/restores the host independently.

**Persistence/sync:** `labels` added to `stateBlob`, `applyState`, `snapshot`,
`applySnap`, and `SYNC_COLL` (`{ id: (o) => o.text }`). `modelIndex().labels` feeds
the Layers panel. No `scad.js` change.

---

## 5. Cross-cutting upgrades

### 5.1 NumField (typed + scrubbed numeric input)

`src/ui/components/controls.tsx`: new `NumField` component —
`{ id, label, min, max, step, value, suffix?: "ft" | "°" | "" }`. Renders
`label + <input type="text"> + suffix`. Uncontrolled (engine reads/writes
`.value` and fires the same handlers as sliders — the engine wiring contract is:
`input` event on commit-less live change, `change` on commit, identical to slider
ids today, so **NumField replaces a Slider by keeping the same element id**).
Behavior (implemented inside the component, self-contained):
- Typing accepts `3.5`, `3'6"`, `3' 6"`, `42"` → feet float; Enter/blur dispatches
  `change`; Escape reverts.
- Drag horizontally on the **label** scrubs the value by `step` per 4px
  (Figma-style), dispatching `input` during and `change` on release.
- Up/Down arrows step; Shift = ×10.
- Display formats feet as `3' 6"` via the same ft-in convention as `ftIn()`.
Replace sliders with NumFields for: door width, window width/sill/height, stair
4 dims, furniture 3 dims, cabinet dims, moulding h/d. Keep real sliders for
continuous scene values: wall height, doors-open angle, sun az/el, eye/fov.

### 5.2 Live Layers panel

Engine: after every `commit`, `applySnap`, and `switchState`, dispatch
`window.dispatchEvent(new CustomEvent("kirkham:model", { detail: modelIndex() }))`
where `modelIndex()` returns a cheap listing:

```js
{ rooms: [{ i, name, color, level }],
  doors: [{ i, label: "Door 3' — Kitchen", level, style }],
  windows: […], mouldings: […], cabinets: […], furniture: […], stairs: […],
  roof: [{ kind: "sky"|"cut", i }] }
```

`LeftPanel.tsx` → new `LayersPanel` subcomponent: React `useState` updated by the
event listener; collapsible groups per domain (Rooms, Doors, Windows, Moulding,
Cabinets, Furniture, Stairs, Roof), rows show name + count badge in the header.
Row click → `window.viewer.selectObject(kind, i)`; engine implements
`V.selectObject` by switching to the owning mode (`setUiMode`) and selecting in the
domain tool (each tool already has a selection set — expose a `select(i)` on each
tool's returned object). Group eye icon toggles `V.setDomainVisible(kind, bool)`
(sets the domain meshes + markers `visible`; session-only, not persisted).
The old static room list is replaced by the Rooms group.

### 5.3 Duplicate

`Cmd/Ctrl+D` duplicates the active tool's selection (doors/windows: same wall,
`t + 0.08` clamped; cabinets/furniture/stairs: offset `x+1, y+1`; skylights/cuts:
offset 1,1). New objects become the selection. One `commit("Duplicate …")`.
Implemented per-tool as `duplicateSel()` invoked from the global keydown via the
active tool. Alt-drag-to-duplicate is **out of scope** (deferred).

### 5.4 Zoom + viewport polish

- Top bar (right of view toggle): zoom readout `#zoom-pct` (plan: ortho zoom as %,
  3D: dolly distance mapped to %) — click opens nothing (display only), `Shift+1`
  zoom-to-fit (re-fit ortho / reframe perspective to model bounds), `Shift+2`
  zoom-to-selection (frame the active tool's selection bounds).
- Replace scenario `prompt()`/`confirm()` with an inline `<input>` swap on
  double-click and a two-click confirm (`✕` → `Sure?`) for delete.

### 5.5 Hints carry shortcuts

Every `HINTS` entry and inspector button `title` includes its shortcut in
Figma style: `"Place Door — D"`. The bottom toolbar buttons get
`<span class="kbd">D</span>` chips.

---

## 6. Persistence & export summary (delta)

`stateBlob()` v stays `1` with **additive fields** (loader is field-defensive):
`mouldings`, `cabinets`, per-door `style/color/casing`, plus new defaults
(`doorStyle`, `doorColor`, `doorCasing`, `mldKind`, `mldProfile`, `mldH`, `mldD`,
`mldColor`, `cabKind`, `cabFront`, …). `snapshot()`/`applySnap()` add `mouldings`,
`cabinets`. `SYNC_COLL` adds both. `GLB_NAMES` adds doorglass/mld/cab meshes.

`roomsToScad(...)` signature grows: `(rooms, doors, windows, roof, stairs,
furniture, mouldings, cabinets)` — doors now carry style fields through
`exportDoors`. New SCAD tables/modules: `DOOR_LEAVES` + `DOOR_LEAF_PARTS` +
`door_leaves()`, `CASINGS` + `casings()`, `MLD_RUNS` + `mouldings()`,
`CAB_PARTS` + `cab_parts()`. The file must still compile standalone:
`openscad floorplan.scad -o out.stl` (CI check in tests when an `openscad` binary
is on PATH; otherwise text-level assertions).

---

## 7. Ordered implementation plan

Execute phases **in order**; each phase ends with: `npm run build` green,
`node --test tests/` green, and a manual smoke note. Do not start a phase until
the previous one's acceptance criteria pass. Within a phase, operations are
ordered.

### Phase 0 — Safety net

| # | Operation | Files |
|---|-----------|-------|
| 0.1 | `git init`; commit everything (respecting `.gitignore`) as `baseline: pre-mode-redesign` | — |
| 0.2 | Add `tests/model.test.mjs` (Node `node:test`, run via `node --test tests/`): (a) `deriveWallGraph(ROOMS)` returns nodes/walls/loops with no dangling indices; (b) `splitWall`+`deleteNode`+`weldGroup` round-trip keeps loop integrity; (c) `roomsToScad(...)` output contains `MODE`, `LVL`, every table header, balanced braces/brackets; (d) state blob: `extractState(fileScad-like text)` inverse of embed (replicate the b64 helpers in the test); (e) `furnitureParts` boxes stay inside footprint ± overhang. Add `"test": "node --test tests/"` to package.json scripts | `tests/model.test.mjs`, `package.json` |
| 0.3 | If `which openscad` succeeds, add `tests/scad-compile.test.mjs` that writes `roomsToScad` output to a temp file and asserts `openscad <f> -o tmp.stl` exits 0; skip (not fail) when the binary is absent | `tests/scad-compile.test.mjs` |

**Accept:** `npm run build` + `node --test tests/` pass; git log shows baseline.

### Phase 1 — Mode system & chrome restructure

| # | Operation | Files |
|---|-----------|-------|
| 1.1 | Create `ModeBar.tsx` (§3.2); mount in `TopBar` (modes center; 3D/Plan + zoom area to its right; Render stays far right) | `src/ui/components/ModeBar.tsx`, `TopBar.tsx` |
| 1.2 | `BottomToolbar.tsx`: drop the Orbit tool; add `data-modes` to each tool button per §3.1 (`walls→layout`, `doors→doors`, `windows→windows`, `stairs/roof→structure`, `furniture→furniture`, `walk→tour`, `measure→layout structure`, `select→all but tour`); add `.kbd` shortcut chips | `BottomToolbar.tsx`, `styles.css` |
| 1.3 | Engine: add `MODES` table, `uiMode`, `setUiMode` (§3.3) — wire `#mode-bar`; hide/show toolbar buttons + inspector subpanels by `data-mode(s)`; clear selections on switch; keep `updateOrbit` semantics (Space/middle-drag) | `src/main.js` |
| 1.4 | Keyboard: digits 1–8 → modes; per-mode tool keys (V W M D N A C F S R) with the selected-object precedence rule of §3.3; extend `HINTS` with shortcuts (§5.5) | `src/main.js` |
| 1.5 | Focus dimming: `applyFocus` (§3.4) + `focus` spec per mode + `noPick` gating in `pickMeshes`; Doors/Windows/Moulding/Cabinets modes ghost per the table | `src/main.js` |
| 1.6 | RightPanel: Design/Scene tabs (§3.5); move Display/Dimensions/Sun/Export sections under Scene unchanged ids; add `data-mode` to every selection subpanel; subpanel headers state scope (selected vs. defaults) | `RightPanel.tsx` |
| 1.7 | Update README "Tools (HUD)" → "Modes" section | `README.md` |

**Accept:** build+tests green. Manually: 1–8 switch modes with correct tool sets,
dimming, and inspector sections; Space-orbit works in every mode; Walls tool
editing, doors, windows, stairs, furniture, roof, walk, measure all still function;
save/restore round-trips; Scene tab controls all work.

### Phase 2 — Figma-grade fundamentals

| # | Operation | Files |
|---|-----------|-------|
| 2.1 | `NumField` component (§5.1) + swap in for door/window/stair/furniture dimension sliders (same ids, same `input`/`change` contract) | `controls.tsx`, `RightPanel.tsx` |
| 2.2 | `modelIndex()` + `kirkham:model` event in `commit`/`applySnap`/`switchState`; `V.selectObject(kind, i)`; per-tool `select(i)` API; `V.setDomainVisible` | `src/main.js` |
| 2.3 | `LayersPanel` React component replacing the static room list (§5.2) | `LeftPanel.tsx`, `styles.css` |
| 2.4 | `Cmd/Ctrl+D` duplicate per tool (§5.3) | `src/main.js` |
| 2.5 | Zoom readout + `Shift+1` fit / `Shift+2` selection (§5.4) | `src/main.js`, `TopBar.tsx` |
| 2.6 | Inline scenario rename/delete (drop `prompt`/`confirm`) | `src/main.js` |

**Accept:** build+tests green; layers reflect an added door immediately; clicking a
layer row switches mode and selects; duplicate works in every domain; typing
`3'6"` into a door width NumField sets 3.5 and commits once.

### Phase 3 — Doors mode

| # | Operation | Files |
|---|-----------|-------|
| 3.1 | `src/doors.js`: `DOOR_STYLES`, `doorLeafParts`, `doorLeaves`, `casingParts` (§4.1) — pure, no three.js imports | `src/doors.js` |
| 3.2 | Tests: every style's parts stay within the leaf bbox; glass only in glazed styles; french/double produce two leaves spanning w; casing boxes clear the opening | `tests/doors.test.mjs` |
| 3.3 | Viewer: rewrite `buildDoorLeaves` + add `<lvl>-doorglass` mesh; casing into `buildWallGeo`; register meshes + `GLB_NAMES` | `src/main.js` |
| 3.4 | Inspector: style cards + width NumField + color + casing toggle in `#door-controls`; engine wiring (selection retype vs. defaults) | `RightPanel.tsx`, `src/main.js` |
| 3.5 | Persistence: door style/color/casing fields + defaults in blob; `normDoor` migration helper (missing style → `slab`, casing → false so legacy files render identically) | `src/main.js` |
| 3.6 | SCAD: `DOOR_LEAVES`/`DOOR_LEAF_PARTS`/`CASINGS` tables + modules; delete legacy `door()` leaf; keep opening cuts + arcs + `DOOR_OPEN` | `src/scad.js`, `src/walls.js` (`exportDoors` carries style) |
| 3.7 | Extend scad tests for the new tables; openscad compile test still passes | `tests/` |

**Accept:** all six styles render with correct lites/panels and swing in 3D + plan;
french doors open as a mirrored pair; casing visible both faces; `.scad` export
opens in OpenSCAD with identical doors; legacy file loads as slab doors.

### Phase 4 — Moulding mode

| # | Operation | Files |
|---|-----------|-------|
| 4.1 | `src/moulding.js`: `MOULDING_PROFILES`, `mouldingRuns`, `mouldingRunParts` (§4.2) — pure | `src/moulding.js` |
| 4.2 | Tests: runs lie on interior offsets (point-in-room-poly checks for run midpoints); base runs are split at door spans; crown runs continuous; profile sub-box fractions sum sensibly (z coverage = [0,1], d ≤ 1) | `tests/moulding.test.mjs` |
| 4.3 | Viewer: `buildMouldingGeo(level)` + `<lvl>-mld` meshes, hooked into `rebuildWalls`, `GLB_NAMES` | `src/main.js` |
| 4.4 | Tool `setupMoulding` (§4.2): hover-highlight room, click apply/select, shift-multi, delete, apply-to-level; register in `setupTools` ids list + mode table | `src/main.js`, `BottomToolbar.tsx` |
| 4.5 | Inspector `#moulding-controls` (kind seg / profile cards / NumFields / color) | `RightPanel.tsx`, `src/main.js` |
| 4.6 | Persistence + `SYNC_COLL.mouldings`; SCAD `MLD_RUNS` + `mouldings()` unioned into level walls | `src/main.js`, `src/scad.js` |

**Accept:** one click bases an entire room, interrupted at doors; crown hugs the
wall-height slider live; per-room selection/edit/delete works; export compiles;
`mouldings` survive save/reload and A→B sync.

### Phase 5 — Cabinets mode

| # | Operation | Files |
|---|-----------|-------|
| 5.1 | `src/cabinets.js`: `CABINET_KINDS`, `cabinetParts` (§4.3) — pure; reuse `shade` from `furniture.js` | `src/cabinets.js` |
| 5.2 | Tests: parts inside footprint (+counter overhang); bay math (`w=4.5` → 3 doors); drawer rows reduce door height; wall kind floats at `mount` | `tests/cabinets.test.mjs` |
| 5.3 | Viewer mesh `<lvl>-cab` + `GLB_NAMES`; `rebuildWalls` hook | `src/main.js` |
| 5.4 | Tool `setupCabinets` (§4.3): wall-snap place, slide-along-wall drag, adjacency snap, rotate, multi-select, delete, duplicate | `src/main.js`, `BottomToolbar.tsx` |
| 5.5 | Inspector `#cabinet-controls` (kind seg, front cards, NumFields, drawers stepper, counter toggle, mount, colors) | `RightPanel.tsx`, `src/main.js` |
| 5.6 | Persistence + sync + SCAD `CAB_PARTS` + `cab_parts()`; Furniture inspector drops "cabinet" from the new-type list (legacy pieces still render) | `src/main.js`, `src/scad.js`, `src/furniture.js` |

**Accept:** placing along the kitchen wall snaps back-to-wall and flush to
neighbors; shaker fronts + pulls + counters render; wall cabinets float at 4.5 ft;
export compiles; save/reload round-trips.

### Phase 6 — Consolidation & polish

| # | Operation | Files |
|---|-----------|-------|
| 6.1 | Structure mode: verify stairs+roof+measure coexist cleanly (marker visibility per §3.1); Tour mode: walk-only toolbar, walk panel auto-shown | `src/main.js` |
| 6.2 | Hints/tooltips audit: every tool + inspector button shows its shortcut; `#toolinfo` per mode | `src/main.js`, components |
| 6.3 | README: rewrite the UI section around modes; document new domains + scad tables | `README.md` |
| 6.4 | Full regression pass: build, tests, manual checklist (every mode, every tool, save→reload→export→openscad compile, A→B sync incl. mouldings/cabinets, .glb export names) | — |

**Accept:** checklist clean; final commit per phase already made (`feat: phase N — …`).

### Phase 7 — Labels mode  *(implemented)*

| # | Operation | Files |
|---|-----------|-------|
| 7.1 | `src/normalize.js`: pure `normLabel` (defaults/coercion, level clamped 0/1) + `seedLabels(rooms)` (one label per named, non-"Stair" room, centered); imported into main.js | `src/normalize.js`, `src/main.js` |
| 7.2 | Data model: `labels = [{ text, x, y, level }]` with the null-sentinel/seed migration; added to `stateBlob`/`applyState`/`snapshot`/`applySnap`/`SYNC_COLL`/`modelIndex` | `src/main.js` |
| 7.3 | Rendered labels: rewrite `buildLabels`/`placeLabels` from the collection; `.label.sel` + `#labels.labels-live` CSS; rebuilt in `rebuildWalls()` | `src/main.js`, `styles.css` |
| 7.4 | Labels mode + `setupLabels` tool (select / drag / add / rename / delete / duplicate / selBox / select-i); `V.centerOn`; wired at every registration site (ids, HINTS, TOOL_KEYS, refreshEditors, clearSelections, DOMAINS, setMode, TOOL_OBJ, duplicateActive, selectionBox, route, updateOverlays, setupSelect/PANELS, MODE_KEYS 9) | `src/main.js` |
| 7.5 | React chrome: ModeBar entry (key 9), `tool-labels` button (`L`) + Select gains `labels`, `#label-controls` subpanel, LeftPanel `Labels` group, labels icon | `ModeBar.tsx`, `BottomToolbar.tsx`, `RightPanel.tsx`, `LeftPanel.tsx`, `icons.tsx` |
| 7.6 | Tests: `tests/labels.test.mjs` (normLabel/seedLabels + header round-trip) + state-compat null-sentinel case; README modes table | `tests/labels.test.mjs`, `tests/state-compat.test.mjs`, `README.md` |

**Accept:** build+tests green; labels are draggable in the viewport and appear in
the Layers panel; clicking a label row jumps (pan-only) the viewport to it; labels
survive save/reload and A→B sync; no SCAD geometry change.

---

## 8. Out of scope (explicitly deferred)

- Collaborative/multiplayer anything (per product direction).
- Alt-drag duplicate, copy/paste across files.
- True curved moulding profiles (sweeps) — box-stepped profiles only.
- Cabinet appliance library, sink/cooktop cutouts in counters.
- Auto-merged continuous countertops across a cabinet run.
- Persisting UI mode / panel state into the `.scad` header.
