# Floor-Plan Viewer — OpenSCAD → WebGL

A browser viewer that compiles an OpenSCAD model **in the browser** (real
OpenSCAD, via WebAssembly) and renders it with **three.js / WebGL**. The model
is a 3D "exploded dollhouse" reconstruction of the listing floor plan.

## Run it

```bash
./serve.sh            # builds the React UI + serves it & the render backend on :8000
# then open http://localhost:8000/
```

`serve.sh` runs `npm install` (first time), `npm run build` (Vite), then
**`server.py`** (stdlib only — no pip installs), which serves the built UI from
`dist/` AND a small backend (see *Backend: save + Blender render* below).

For **live UI development** use Vite's dev server (hot reload), with the Python
backend running alongside for `/api/*`:

```bash
python3 server.py 8000 &   # render/save backend
npm run dev                # Vite on :5173, proxies /api → :8000
```

### UI stack — React + TypeScript (Figma-style)

The chrome is a **React + TypeScript** app (Vite) styled like Figma: a top bar
(with the **mode bar** centered, the 3D/Plan toggle + a **zoom readout** to its
right, and **▶ Render** far right), a left **Levels / Scenario / Layers / History**
panel, a right properties panel with two tabs — **Design** (the selection
inspector, per-domain subpanels) and **Scene** (the global Display · Dimensions ·
Sun · Export sections) — and a floating bottom **toolbar**. The proven Three.js
viewer (`src/main.js`) is kept as the canvas
**engine**: React renders the control elements the engine wires to (by id) and
then dynamically imports the engine after mount, so the UI is fully reskinned
without touching the rendering/editing core. `three` is bundled by Vite
(`three/addons/*` aliased to `three/examples/jsm/*`); no CDN importmap. This
OpenSCAD build is single-threaded, so no `COOP`/`COEP` headers are needed.

Controls are **Figma-style**: left-drag selects, **hold Space or middle-drag to
orbit**, scroll to zoom, right-drag (or arrow keys) to pan. The Scene tab toggles
room labels, walls, **framing** (renders walls as stud framing — top/bottom
plates with 16"-on-center studs — instead of solid panels), and whether the two
levels are exploded apart or stacked.

## How it works

```
src/rooms.js ──► tools/gen-scad.mjs ──► floorplan.scad
     │                                        │
     │  (labels, colors)        OpenSCAD-wasm compiles to STL
     ▼                                        ▼
  src/main.js ◄───────────────── three.js renders + tints + labels
```

1. **`src/rooms.js`** is the single source of truth: every room as a rectangle
   (feet) with a level, color, and name.
2. **`tools/gen-scad.mjs`** emits **`floorplan.scad`** from that table. The
   `.scad` is a normal OpenSCAD file — open it in the OpenSCAD GUI directly.
3. **`vendor/`** holds the official [`openscad-wasm`](https://github.com/openscad/openscad-wasm)
   runtime (release `2022.03.20`). `src/main.js` boots it, writes `floorplan.scad`
   into its virtual FS, and runs `callMain([... "-o","/out.stl"])`.
4. STL carries **no color**, so the viewer classifies each triangle by position
   — floor vs wall by height, room tint by which rectangle the centroid lands in
   — reusing `rooms.js`. That keeps geometry, colors, and labels in sync from a
   **single compile**.
5. Labels are HTML elements projected to screen each frame. In **Labels** mode
   they become positionable (draggable) annotations carried by the saved state;
   they seed once from the room names on first load.

### Regenerating the model

Edit `src/rooms.js`, then:

```bash
node tools/gen-scad.mjs        # rewrites floorplan.scad
```

### The OpenSCAD model

`floorplan.scad` is parametric and driveable from the CLI:

```bash
openscad floorplan.scad -o model.stl                 # whole exploded model
openscad floorplan.scad -D ROOM=5 -D MODE=0 -o r.stl # one room's floor slab
#   ROOM = -1  all rooms (default)
#   MODE = 0   floor only · 1  walls only · 2  both (default)
```

The viewer compiles `ROOM=-1 MODE=2` (the whole model) once. The per-room
`-D ROOM=n` path exists for tooling/experiments and as a fallback colouring
strategy (one tinted STL per room).

## How the plan was derived from the image

`src/rooms.js` is **measured from the source floor-plan image**, not eyeballed:

1. **Footprints** — detected the tan (main level) and gray (lower level) floor
   fills to isolate each plan's pixel bounding box.
2. **Scale** — the two back bedrooms span the full width, so their printed
   dimensions calibrate the scale: `12'3" → 135 px` and `11'6" → 127 px` both
   give **≈ 11.03 px/ft**. Cross-checked against the lower plan (identical
   276 px width).
3. **Wall grid** — accumulated vertical/horizontal wall lines (non-floor pixels
   flanked by floor) to locate partitions; the strong central partition lands at
   X ≈ 12.8 ft, the Living/Dining wall at Y ≈ 15.2 ft, etc.
4. **Room boxes** — scanned each room's floor mask outward to the surrounding
   walls and converted px → ft. Boxes that reproduce the printed label exactly
   are marked `✓` in `rooms.js` — e.g. **Living Room 19'5"×14'8"**, both
   bedrooms, Foyer 9'2"×6'0", Dining 14'6"×11'0", Bath 5'8"×10'7".
5. **Non-rectangular rooms** — two rooms are traced polygons, not rectangles:
   - The central **Patio** court: back-left corner chamfered by a diagonal
     (flood-filled from the stippled-concrete fill → 5-point polygon). It's a
     *walled* court, so its polygon drives the walls around it — they follow the
     chamfer and the court closes as a clean manifold hole.
   - The **bent Hall**: a narrow vertical corridor that wraps *right* around the
     patio (its right edge follows the patio's left wall, then the diagonal) and
     continues up past the court to the kitchen/bedrooms — an 8-point polygon
     traced from the wood-floor corridor.

   A room may carry a `poly: [[x,y],…]` (absolute feet); the generator extrudes
   it for the floor and its edges become wall segments (incl. the chamfer
   diagonal), while `x/y/w/d` stays the bounding box for the label and color.

### Unified graph: floors always match walls

The editable model (`src/walls.js`) is one shared graph of **NODES** (endpoints,
feet) and **WALL** segments between them, derived once from the rooms (corners
within 0.7 ft snap to one node), then the graph is the source of truth.

**Floors are computed from the walls** so they can never disagree: `floorFaces()`
builds a **planar arrangement** of a level's walls — splitting every segment at
T-junctions and crossings — and traces *every* bounded region. Each enclosed area
becomes one floor slab (tinted by the smallest original room over its centroid),
so no wall-enclosed region is ever missing a floor, and floors update live as
walls move. (This replaced per-room floors, which left enclosed gaps — e.g. the
garage, hall and courtyard — unfloored.)

Each wall segment is thickened with `hull()` of its two endpoints, so **any
orientation works**, including the **chamfered courtyard's diagonal**. Floors are
`ShapeGeometry` of each room loop. Everything is rebuilt procedurally in three.js,
so editing is **realtime** — no recompile per edit.

**Export (`floorplan.scad`)** is generated separately by `src/scad.js` and uses a
CSG **shell** so the exported solid is never disjointed: per level,
`union(rooms grown by WALL_OUT) − union(rooms shrunk by WALL_IN)` yields a single
continuous wall network — adjacent rooms share *one* partition (not two), with a
continuous exterior shell — then doors are subtracted and drawn with a leaf +
swing arc. (`WALL_OUT` bridges the measured sub-foot room gaps.) Result: one
connected manifold per level.

**Doors are placed on a specific wall**: `{wall, t (0..1 along it), w}`. The cut
splits the segment's `0..1` span; the leaf + swing arc are oriented to the wall
(`atan2`), so even diagonal walls get correct openings. Initial doors are seeded
from the detected set (`tools/detect-doors.py`, `tools/detect-hall-doors.py`).

### Viewer & tools (realtime)

Soft shadows (`PCFSoftShadowMap`), ACES tone mapping, hemisphere + warm key
light, shadow-catcher ground, and a **realistic clear blue sky** backdrop — a
physically-based atmosphere (`three/addons/objects/Sky.js`, Preetham model) with
no clouds, oriented Z-up, whose sun glow + blue tint **track the editor's sun
angle**. The sky dome forces its depth to the far plane so it always sits behind
the model from any orbit angle and from inside in first person; it's added to the
scene *after* the model bounding box is measured so its size doesn't skew camera
framing. **Arrow keys pan** the camera; **Space / middle-drag orbits**, scroll zooms.

**View toggle (3D view / Plan (top)):** a second `OrthographicCamera` looks
straight down (+Y up) for a true top-down **orthographic plan**, auto-fit to the
footprint (`fitOrtho`, re-fit on resize) and **locked top-down** — pan + zoom
only, no rotation (even after wall edits). Everything (labels, measure, wall/door
tools) reads `V.camera`, so all tools work identically in plan view.

Interaction is **Figma-style**: a default **Select** tool where clicking *any*
object — a room, a wall, a door, a window, or a skylight — selects it and shows
its properties in the right panel (rooms/walls are read-only: name · level · size
· area · length; doors/windows/skylights are editable: slide, resize, flip,
delete). Selecting a door/window/skylight starts a drag to reposition it; a wall
offers an **Edit points** shortcut into the Walls tool (Layout mode only). **Orbit
is deliberate** — left-drag never orbits in Select; you orbit by holding
**Space** or **middle-drag** (always, in every mode). Right-drag pans, wheel
zooms.

### Modes

The editor is organized into **modes** — each scopes the whole UI (the bottom
toolbar, the right-panel inspector, canvas emphasis, and picking) to one design
domain. Switch with the **mode bar** in the top-bar center, or press its number:

| Key | Mode | Tools (first = default) |
|-----|------|-------------------------|
| `1` | **Layout** | Select `V` · Walls `W` · Measure `M` |
| `2` | **Doors** | Select `V` · Place Door `D` |
| `3` | **Windows** | Select `V` · Place Window `N` |
| `4` | **Moulding** | Select `V` · Apply Moulding `A` |
| `5` | **Cabinets** | Select `V` · Place Cabinet `C` |
| `6` | **Furniture** | Select `V` · Place Furniture `F` |
| `7` | **Structure** | Select `V` · Stairs `S` · Roof `R` · Measure `M` |
| `8` | **Tour** | Walk (first-person, only tool) — its panel auto-opens on entering the mode |
| `9` | **Labels** | Select `V` · Label `L` — click the floor to add a positionable text label, drag to move, rename in the panel; clicking a label row in the Layers panel jumps (pan-only) the viewport to it |

Modes are **pure view/tool scoping — they never change the model**, and they are
**session-only** (not saved to the `.scad` header): the editor always opens in
**Layout**. Switching a mode **clears the selection** (Figma's page-switch
behavior). A domain mode **dims everything outside its domain** (focus dimming —
e.g. Doors mode ghosts walls, furniture, and cabinets and hides the roof so the
doors read), and ghosted objects can't steal clicks. Floors are never dimmed.
Inspector subpanel headers state scope: *"3 doors selected"* when you have a
selection, *"New doors will use these settings"* when you don't (so a slider reads
as a placement default, not a silent edit).

**Keyboard:** digits `1`–`8` switch modes; single letters switch the tool **within
the current mode** (`V` Select · `W` Walls · `D` Door · `N` Window · `A` Moulding ·
`C` Cabinet · `F` Furniture · `S` Stairs · `R` Roof · `M` Measure). A tool's own key
wins when it has a selection — e.g. `R` rotates a selected stair, but with nothing
selected `R` switches to the Roof tool. `M` activates Measure in any mode that
includes it. **⌘/Ctrl-D duplicates** the active tool's selection (doors/windows
clone on the same wall offset along it; cabinets/furniture/stairs/roof openings
offset by 1 ft). Every toolbar button, mode segment, and inspector action carries
its shortcut in its tooltip (and the toolbar shows a `kbd` chip).

### Numeric entry, live Layers, zoom

- **NumFields** (`src/ui/components/controls.tsx`) replace the dimension sliders for
  every discrete length — door/window/stair/furniture/cabinet/moulding sizes. A
  NumField is a typed **+** scrubbed input that **drops in for a Slider keeping the
  same element id** (the engine still reads `.value` and listens for `input`/`change`),
  so the wiring is unchanged. You can **type** `3.5`, `3'6"`, `3' 6"`, or `42"` (all
  → feet), **drag the label** to scrub (Figma-style, `step` per 4px, Shift ×10),
  **Up/Down** to step, Enter/blur to commit, Esc to revert; the resting display is
  ft-in. Continuous scene values (wall height, doors-open angle, sun, eye/fov) keep
  real sliders.
- **Live Layers panel** (`LeftPanel.tsx`): the old static room list is replaced by a
  panel that mirrors the live document. After every commit / undo-redo / scenario
  switch the engine dispatches a `kirkham:model` event (`modelIndex()`) and the panel
  re-renders **collapsible per-domain groups** (Rooms · Doors · Windows · Moulding ·
  Cabinets · Furniture · Stairs · Roof · Labels) with count badges. **Clicking a
  row** switches to the owning mode, selects the object (`V.selectObject`), and
  **glides the viewport** to center on it (pan-only `V.centerOn`, ~280 ms ease —
  zoom and orbit are preserved); the **group eye icon** hides/shows that domain's
  meshes + markers (session-only, `V.setDomainVisible`).
- **Zoom** (`#zoom-pct` in the top bar): a live readout (ortho zoom in plan, dolly
  distance in 3D). **Shift+1** zoom-to-fit (reframe to model bounds), **Shift+2**
  zoom-to-selection (frame the active tool's selection).
- **Inline scenario edit:** rename a scenario step by **double-clicking** its chip
  (an inline `<input>`) and delete with a **two-click confirm** — no `window.prompt`
  / `confirm`.

Tools:
- **Select** — click any object → properties; drag to reposition editable ones.
  Available in every mode except Tour. Orbit with **Space** / **middle-drag**.
- **Walk** — first-person "drop-in" (Street View style): keeps your view until you
  **click a floor spot** to stand there at eye level, then **drag to look · WASD /
  arrows to walk · scroll to step · Q/E eye height · Esc to exit**. ▶ Render
  renders this eye-level view in Blender. (See *First-person walkthrough* below.)
- **Measure** — click two points; distance in feet-inches.
- **Walls** — Figma-style vector editing of the wall graph with **multi-select**:
  - **Select** — click a node (orange when selected), **Shift-click** to add/remove,
    or **drag a marquee** over empty space to box-select; click empty / **Esc**
    clears. Selection count + actions show in the HUD.
  - **Move** — drag any selected node and the *whole selection* moves together
    (grid-snapped). Moving **never welds** — you choose when to weld. While
    dragging, **live dimension guides** show the distance from the dragged point
    to the nearest wall in each cardinal direction (ray-cast, labelled in ft-in).
  - **Weld** — the explicit **⊕ Weld** button merges all selected points into one
    (`weldGroup`, at their centroid). This is the deliberate weld action, separate
    from moving.
  - **Add** — click a wall to insert a control point (`splitWall`) and drag it out.
  - **Delete** — **✕ Delete** button, **Alt-click**, or the **Delete** key removes
    every selected point (`deleteNode`), **punching holes** in the walls.
  - Endpoints **snap to a 1 ft grid** (toggle).
- **Doors** — click a wall to place a doorway. Doors use the **same selection
  model as walls**: clicking a door **selects** it (Shift = multi), **drag** to
  slide it along its wall — clicking **never deletes**. **⇄ Flip swing** reverses
  the swing side (`door.side`, `F`); **⮃ Flip hinge** swaps the hinge jamb
  (`G`); **✕ Delete** / Delete key removes selected doors. Each door renders as a
  real **leaf + quarter-circle swing arc** (correctly angled even on the diagonal
  wall) and rides along when its wall moves. **Door styles** (Phase 3, `src/doors.js`):
  the inspector's style cards retype the selection (or set the default for new
  doors) among **Slab · 2-Panel Shaker · 5-Panel · 15-Lite Glazed · French pair ·
  Double slab** — pure `doorLeafParts`/`doorLeaves` geometry shared by the viewer
  and SCAD, with glazed/french styles emitting glass lites into a separate
  `*-doorglass` mesh. Each door also carries a **leaf colour** and an optional
  **casing** toggle (trim around the opening on both faces, `casingParts`). All
  fields persist; legacy styleless doors load as plain slabs (`normDoor`).
- **Windows** — click a wall to place a window; same selection model (click /
  Shift-multi / drag to slide / Delete). A window cuts only its band of the wall
  (sill below + header above stay solid) and fills it with a **translucent glass
  pane**. Per-window **Width**, **Sill** (vertical position off the floor), and
  **Height** sliders resize the selected windows (and set the defaults for new
  ones). All persisted and exported to `.scad` (`window_cut` + `window_glass`,
  carrying per-window sill/height).
- **Roof** — a flat slab over the main level (sits on top of the main walls,
  `z = LEVEL_Z[1] + WALL_H`). It is tiled from the wall-enclosed faces so it is
  **seamless**, and supports two kinds of opening:
  - **Cuts** — open to the sky (no glass). The **central patio light court is a
    default cut**, so the patio reads as an uncovered courtyard; click the roof
    (with **＋ Cut** active) to carve more.
  - **Skylights** — glazed openings (translucent panes). Click the roof to drop
    one; **Width/Depth** sliders resize the selection. Same selection model as the
    other tools (click / Shift-multi / **drag to move** / **Delete**).
  The roof toggle (HUD) shows it **solid**; when **off it is still in the scene
  with `castShadow=true`**, so the main level is lit *through* the openings — every
  skylight and the open patio drop a bright patch onto the floor below (the roof's
  material just goes transparent, the shadow stays). While the Roof tool is active
  the roof ghosts to translucent so openings stay legible. Persisted and exported
  to `.scad` (`roof()` minus `ROOF_CUTS`/`SKYLIGHTS`, plus `sky_glass()`).

### Stairs

Stairs are their own kind of object — a **solid stepped block** (a stack of
treads, each one step taller than the last). Like the roof, a stair is *not* a
room or a wall opening; it's defined by a footprint `{x, y, w, d}`, an ascent
`dir` (`+x`/`-x`/`+y`/`-y`), a `steps` count, and **two independent vertical
travels measured from its level floor** — `up` (feet climbed above the floor) and
`down` (feet dropped below it). The treads span `[floor − down, floor + up]`, so a
stair can **rise, drop, or do both** from a mid-flight landing (`src/rooms.js`
`STAIRS`). Each stair belongs to a `level`, so it rides that floor's **stack
offset and floor filter**.

The **Stairs tool** (HUD) edits them with the same selection model as the other
tools — click empty floor to **drop** a stair, click a stair (its marker *or* the
stepped body) to **select** it (Shift = multi), **drag** to slide it across the
floor (grid-snapped). The right panel resizes the selection: **Width** (across the
run), **Run** (depth along the ascent), **Rise** (travel up) and **Drop** (travel
down) — set independently — **Steps**, plus **⟳ Rotate** (turn 90°, footprint and
all — also `R`), **⇅ Flip** (reverse the ascent direction — also `F`), and **✕
Delete** (`Delete`/`Backspace`). Every edit commits to the **undo history** and
auto-saves. In the **Select** tool a stair is pickable too (its panel appears on
click). Two are seeded from the plan:

- **Front Steps** — the exterior stoop up to the main-floor front door (the door
  at `x≈2.6, y=0`). It rides the main group, so when the levels are **stacked**
  its base lands on grade and the top tread meets the entry threshold; **exploded**,
  it floats up with the main floor.
- **Interior Stair** — fills the lower-level **"Stair"** room (`x0, y40, 4×6`) and
  climbs a full inter-floor height (`WALL_H + SLAB`), meeting the main floor when
  the levels are stacked.

The step geometry is one pure function (`stairSteps` in `src/walls.js`) shared by
the three.js viewer (`buildStairsGeo`) and the OpenSCAD export, so both build
identical treads. Stairs cast/receive shadows, are persisted with the rest of the
edit state, and export to `.glb` (`Main-Stairs` / `Lower-Stairs`) and to `.scad`
(a `STAIRS` table + a parametric `stairs_solid()` module, drawn in absolute Z like
the floor slabs).

**Stairwell cuts.** A stair carves the walls *and* floors it passes through, so it
reads as cutting down/through and climbing up/into the levels it reaches. Detection
runs in the **real (stacked) frame** — floors spaced `WALL_H + SLAB` apart,
independent of the exploded view — so a stair on level *L* occupies
`[floor(L) − down, floor(L) + up]`. For every level, where that span overlaps the
level's wall band the overlapping **height range is removed from any wall the stair
crosses**, and where a floor slab lies inside the span the stair is **punched
through it** (so a descending stair opens a hole in the floor it drops through, and
a rising stair opens the floor above where it emerges).

The two openings are sized differently. **Walls** use the footprint **inset by
~0.5 ft**, so a stairwell's *own* perimeter walls survive — only walls the stair
genuinely passes through are cut. **Floors** clear the stair's **whole footprint
plus a headroom extension at the top** (`stairFloorOpening`), so a person can walk
the full flight rather than just the slice where it intersects — and that cut is
gated to the floor the stair's footprint actually sits over, so an exterior stair
meeting a threshold (its footprint outside the building, reached through a *door*)
doesn't punch the floor its headroom extension happens to reach into.

The same cuts are applied in the viewer (`stairWallCuts` subtracts wall spans + adds
the kept remnants below/above the opening; `stairFloorHoles` adds `THREE.Shape`
holes) and in the `.scad` export (`STAIR_WALL_CUTS` / `STAIR_FLOOR_CUTS` subtracted
in `level_walls` / `floor_slab`), over shared footprint math (`stairFloorOpening` in
`src/walls.js`) so the two agree.

### Furniture

Furniture is its own kind of object — like stairs, a piece is **not** a room or a
wall opening but a **footprint on a level's floor** with a *type*. Four types ship
(`src/furniture.js` `FURNITURE_TYPES`): **Cabinet**, **Island**, **Bed**, and
**Couch**. Each piece is `{ type, level, x, y, w, d (footprint, feet), h (height),
dir ("+x"/"-x"/"+y"/"-y" — the FRONT faces that way), color? }`. The per-type
geometry is one pure function, **`furnitureParts(f)`**, which returns a list of
axis-aligned **colored boxes** (body + countertop, frame + mattress + headboard +
pillows, seat + backrest + arms + cushions). Because it's pure it is the single
source of truth shared by the **three.js viewer** (`buildFurnitureGeo` merges the
boxes into one vertex-colored mesh per level) and the **OpenSCAD export** (`scad.js`
flattens it to a `FURN_PARTS` table drawn by `furniture_parts()`), so both build
identical pieces. Pieces live in their level group, so they ride the **stack offset
and floor filter** and cast/receive shadows.

The **Furniture tool** (HUD) edits them with the same selection model as the other
tools: pick a **Type** in the right panel, click empty floor to **drop** a piece,
click a piece (its marker *or* its body) to **select** it (Shift = multi), **drag**
to slide it across the floor (grid-snapped). The panel changes the selection's
**Type** (re-typing keeps the footprint), **Width** / **Depth** / **Height**
(centered resize), **Color** (a colour picker; unset pieces use the type's default
tone), **⟳ Rotate** (turn 90° — footprint and facing, also `R`), and **✕ Delete**
(`Delete`/`Backspace`). Selecting a piece **syncs the sliders/type/colour** to it.
Every edit commits to the **undo history** and auto-saves; in the **Select** tool a
piece is pickable too (its panel appears on click). Seven pieces are seeded into the
plan (`src/rooms.js` `FURNITURE`): a kitchen **island** + three base **cabinets**, a
**couch** in the living room, and a **bed** in each bedroom (headboards to the wall).
Furniture is persisted with the rest of the edit state and exports to **`.glb`**
(`Main-Furniture` / `Lower-Furniture`, vertex colours → Blender base colour) and to
**`.scad`** (the `FURN_PARTS` table + `furniture_parts()`, verified to compile to a
watertight manifold).

### Moulding

Moulding is **interior trim applied per room, per kind** — one click paints a
room's full interior perimeter, matching how trim is actually specified. A moulding
is `{ room, kind ("base" | "chair" | "crown"), profile, h (height, ft), d (depth
proud of the wall, ft), color }`, with **at most one per (room, kind)** —
re-applying replaces. Geometry is two pure functions in `src/moulding.js` shared by
the viewer (`buildMouldingGeo` → `*-mld` mesh) and the SCAD export:

- **`mouldingRuns`** walks the room loop's interior perimeter (oriented CCW),
  offsets each edge **inward** by `WALL_T/2 + d/2`, and **splits base/chair runs at
  door openings** on that wall (crown runs stay continuous); windows interrupt a run
  only where the profile's z-band meets the window band.
- **`mouldingRunParts`** stacks the chosen **profile** — `Square · Stepped · Cove`,
  each a list of sub-boxes as fractions of (h, d), mirrored vertically for crown —
  along each run. Crown follows the live **wall-height** slider (`z = wallH − h`);
  base sits at the floor, chair at 2.7 ft.

The **Apply Moulding** tool (`A`) **highlights the room under the cursor** with a
floating *"Apply base · stepped to Kitchen"* hint; clicking **creates** a moulding
from the inspector's current kind/profile/dims (or **selects** the room's existing
one of that kind). The **Select** tool picks a moulding by clicking near a moulded
wall at the profile's z-band. The inspector (kind segmented control · profile cards ·
**Height**/**Depth** NumFields · colour) edits the selection or sets defaults;
**⊞ Apply to level** bases/crowns/chairs **every room on the visible level** in one
commit; **✕ Delete** removes the selection. Mouldings persist, sync across A→B steps
(`SYNC_COLL.mouldings`, keyed `room:kind`), follow the **Walls** display toggle (they
are wall trim), and export to `.glb` (`Main-Moulding` / `Lower-Moulding`) and `.scad`
(an `MLD_RUNS` table + a `mouldings()` module unioned with the level walls).

### Cabinets

Cabinets are their own first-class domain (the legacy furniture "cabinet" box still
renders for old files, but new cabinets are real casework). A cabinet is a footprint
`{ level, x, y, w, d, h, dir }` plus **`kind` (Base · Wall · Tall)**, a **`front`
style (Slab · Shaker)**, **`drawers` (0–3 top rows)**, a **`counter`** flag, a
**`mount`** height (wall cabinets float at 4.5 ft), and body/counter colours. One
pure function **`cabinetParts(c)`** in `src/cabinets.js` returns the colored boxes —
**toe kick** (base/tall), **carcass**, **fronts** (split into door bays of ≤1.75 ft;
shaker bays get rails/stiles + a recessed panel; drawer rows reduce the door height),
**pulls**, and a **countertop** with overhang (base) — shared by the viewer
(`buildCabinetGeo` → `*-cab` mesh) and the SCAD export.

The **Place Cabinet** tool (`C`) clicks the floor to drop a cabinet that **snaps its
back to the nearest wall** within 3 ft (facing away, grid-snapped along it); with no
wall nearby it places free facing +y. **Dragging** a wall-backed cabinet **slides it
along its wall**, with **adjacency snap** flush to a neighbour's end; `R` rotates
free pieces, Shift multi-selects, Delete removes. The inspector (kind segmented
control — retyping applies the kind's d/h/mount defaults · front-style cards ·
**Width/Depth/Height** NumFields · **Drawers** stepper · **Countertop** toggle ·
**Mount** NumField · two colour pickers · ⟳ Rotate · ✕ Delete) edits the selection or
sets defaults. Cabinets are **casework, not wall fabric** — they are **not** tied to
the Walls display toggle. They persist, sync across A→B steps
(`SYNC_COLL.cabinets`), and export to `.glb` (`Main-Cabinets` / `Lower-Cabinets`) and
`.scad` (a `CAB_PARTS` table + a `cab_parts()` module). Partial/legacy records fill
their kind defaults via `normCab`.

### First-person walkthrough ("drop in")

A **Google Street View-style** way to view the design from inside it. The **Walk**
tool (HUD) lets you **drop into a spot** at eye level and look around in true
first person — and because it drives the **same perspective camera** the Blender
backend reads, **▶ Render** renders the model from that exact eye-level angle (no
extra plumbing).

- **Keeps your viewport until you pick a spot.** Activating Walk does *not* move
  the camera — your current 3D view stays put while a **blue ring** previews where
  a click would drop you. Only the **first floor-click engages** first person
  (`engage()` in `setupFirstPerson`, `src/main.js`): the eye teleports to that
  point at **eye height**, facing the model centre.
- **Look + walk.** Once dropped in: **drag** to look around (mouse-look — eye
  fixed, yaw/pitch), **WASD / arrow keys** to walk the floor at eye height
  (smooth, frame-rate-independent), **scroll** to step forward/back, **Q/E** to
  raise/lower the eye, and **click another spot** to teleport there. **Esc** (or
  switching tools) **exits and restores your saved orbit view** — if you never
  dropped in, the live viewport is left exactly as it was.
- **Rides the level.** The eye sits at `levelZ(level) + eye`, so it honours the
  **explode/stack** offset and the **floor filter**; clicking a spot picks the
  level under the cursor. Room labels hide while inside (they read wrong from eye
  level).
- **Right panel** (`walk-controls`): **Eye height** and **Field of view** sliders,
  a live **Heading** readout (compass + degrees), and a **⦿ Drop in center**
  button.
- **Implementation.** `setupFirstPerson(info)` reuses `V.pcam` + `V.pctrl.target`
  and sets `V.fpActive` so the render loop stops OrbitControls from re-driving the
  camera and lets the tool position it each frame. Because `cameraState()` already
  reads `V.pcam.position` / `V.pctrl.target` / `fov`, the existing **`POST
  /api/render`** Blender path renders the eye-level view unchanged. (Walls default
  to a full **8 ft**, so a 5.5 ft eye sits inside real-height rooms.)

Global controls (live sliders/toggles): **wall height** (walls, door leaves and
endpoint handles follow), **doors open** (0° = shut → ~110° wide; every leaf
swings and its arc shows/hides together), **sun direction** + **sun height**, and
**grid-snap**. The standalone `.scad` honors the same via `-D WALL_H=…` /
`-D DOOR_OPEN=…`.

**Sun position:** the directional key light is driven by a compass **azimuth**
(direction the light shines from, 0–360°) and **elevation** (height above the
horizon, 5–89°); it always aims at the model center (`V.setSun`), so dragging
either slider sweeps every shadow in real time — including the roof's, which is
how the openings paint light onto the main floor. Persisted with the rest of the
edit state.

**Floor filter (Both / Main / Lower):** hides the other level — and **only the
shown floor is editable**. All picking (`pickMeshes` and the node/door/window
handle picks) is gated by `levelVisible`, so you can't grab, add, or drag
anything on a hidden floor; switching the filter clears selections on the
now-hidden level.

### Edit history

Every committed edit (endpoint move, door add/remove) snapshots the editable
state (node positions + doors). The HUD shows the **timeline**: click any entry
to jump to that state; **Undo/Redo** buttons and **⌘/Ctrl-Z · ⌘/Ctrl-Shift-Z**
step through it; a new edit after jumping truncates the redo tail.

The pure model logic (`src/walls.js`, `src/scad.js`) and the history logic are
unit-tested in Node, and **every reachable edit state is verified to stay a
watertight manifold** via the local OpenSCAD binary.

### A → B scenarios (and syncing edits across steps)

The home is modeled as an **ordered list of states**, from the **as-built** home
(`A` = `states[0]`) through optional modification **steps** to the **proposed**
home (`B` = `states[last]`). Each state is an independently-editable model with its
**own** undo/redo history; the left panel's `A → B` strip switches the active state
(▶ Play walks A → B), and **＋ Add step** forks the current model into a new editable
state. Switching states morphs the live model; later edits commit into that state.

**Sync edits across steps.** Because a step is a *fork* of its predecessor, the
same object exists in multiple states. The scenario panel's **🔗 Sync edits across
steps** toggle makes an edit in one step **apply to the same object in every other
step — where that object is still consistent**:

- **What syncs** — property edits (move a wall node, slide/resize a door or window,
  move/resize/rotate/retype/recolor a furniture piece or stair, move/resize a roof
  opening), plus single **adds** and **deletes** of a shared object.
- **Consistency gate** — a change is applied to another step only where the
  collection is **aligned** (same length) and the object at that index passes an
  **identity check**: a door/window on the **same wall**, **furniture of the same
  type**, a **stair of the same name**; node/loop edits additionally require
  **identical wall topology**. Steps that have structurally diverged are left
  untouched, so syncing never clobbers an intentional per-step difference.
- **Globals are already shared** — wall height, door-open angle, sun position, and
  room colours/names live outside the per-state snapshot, so they apply to every
  step inherently; only the per-state geometry (nodes, doors, windows, stairs,
  furniture, roof openings) needs syncing.
- Each propagated change lands as its **own `⇄ …` entry in the target step's
  history**, so it stays per-step undoable. Implemented in `propagateEdit`
  (`src/main.js`): it diffs the pre/post snapshot of the committed edit and writes
  the corresponding object into each other state's tip snapshot.

### Save / restore / export

**`floorplan.scad` on disk is the single source of truth** — there is no
`localStorage`. The full editable state (nodes, walls, room loops, doors *with
style/colour/casing*, windows, stairs, furniture, **mouldings**, **cabinets**,
**labels** (positionable text annotations — header-only, no SCAD geometry), roof
openings, wall height, door angle, sun, the per-domain placement defaults, **and the
whole A→B scenario list with per-step history**) is embedded as a **base64
block-comment header** at the top of `floorplan.scad`:

```
/* KIRKHAM-STATE-V1
<base64 JSON state>
KIRKHAM-STATE-V1 */
… the generated OpenSCAD geometry …
```

Because the state lives in an OpenSCAD `/* … */` comment, the file stays a
**valid, openable model** (verified: it still compiles to a watertight manifold).
base64 guarantees the blob can never contain a `*/` that would close the comment
early.

- **Auto-save → server → overwrite.** Every committed edit / slider change calls
  `saveState()`, which **debounces (~450 ms)** then POSTs the regenerated file
  (`fileScad()` = state header + `currentScad()`) to **`/api/save-scad`**, which
  **overwrites `floorplan.scad`** in the server's directory. Rapid slider drags
  coalesce into one write; the **💾 Save** button forces an immediate flush.
- **Restore on load.** Before any geometry is built, boot fetches
  **`GET /api/floorplan-scad`**, pulls the embedded state out of the header, and
  applies it — so a reload restores exactly what's on disk (no browser storage
  involved). If the file has no header yet (fresh / hand-generated), the measured
  seed plan is built and immediately auto-saved, migrating the file in place.
- **Reset** reloads with a flag that **skips** the embedded state (rebuilds the
  measured seed), then the first auto-save overwrites `floorplan.scad` with that
  clean default.
- The server endpoints are stdlib-only: `GET /api/floorplan-scad` reads the file,
  `POST /api/save-scad` writes it. In Vite dev, `/api/*` proxies to the backend, so
  the same source-of-truth file is used in dev and prod.

The header format is **`KIRKHAM-STATE-V1` and stays v1 by additive fields** — the
loader reads every field defensively (missing → default), so **older files keep
loading**. Doors without style fields normalize to plain slabs, absent
`mouldings`/`cabinets` keys default to empty, and legacy single-`rise` stairs migrate
to up/down — all through the **pure normalizers in `src/normalize.js`** (`normDoor` ·
`normFurn` · `normCab` · `migrateStair`), which `src/main.js` imports and
`tests/state-compat.test.mjs` exercises directly (the "legacy file loads" guarantee).

**Export .scad** regenerates `floorplan.scad` *from the current edited state* —
`exportRooms()`/`exportDoors()` turn the edited node loops + doors back into the
CSG-shell generator — so the downloaded OpenSCAD reflects your edits and stays a
clean connected manifold. Every domain is a **data table + a parametric module** in
`src/scad.js`: door openings are still subtracted from the walls, but the leaves are
now emitted as **`DOOR_LEAVES` + `DOOR_LEAF_PARTS`** (drawn by `door_leaves()` —
hinge-translate → rotate by the swing angle → per-part cube, with glazed/french
glass lites unioned into the glass), casing into **`CASINGS`**, mouldings into
**`MLD_RUNS`** (`mouldings()`, unioned with the level walls), and cabinets into
**`CAB_PARTS`** (`cab_parts()`). (Verified end-to-end in Node: edit → save → restore →
export compiles to a manifold and contains the edited coordinates.)

**Export .glb (Blender / PBR)** writes a binary **glTF 2.0** of the live model
(`exportGlb`, via three's `GLTFExporter`) so it drops straight into Blender for
**real-time physically-based rendering** (Eevee/Cycles) — no rebuild, no
re-materialing:
- Each mesh's **world matrix is baked** into a clone, so the export is correct
  whether levels are exploded or stacked. Editor helpers and swing-arc lines are
  skipped; meshes get readable names (`Main-Walls`, `Main-DoorGlass`,
  `Main-Moulding`, `Main-Cabinets`, `Roof`, `Skylights-Glass`, …) for the Blender
  outliner.
- Materials export as **Principled BSDF**: per-room **floor colors ride along as
  vertex colors** (`COLOR_0` → Blender base color), walls/doors/roof carry their
  roughness, and **glass becomes true transmissive glazing**
  (`KHR_materials_transmission`, thin-walled to stay importer-safe).
- The **sun exports as a directional light matching the editor's sun angle**. A
  glTF directional light shines along its node's local −Z and `GLTFExporter` reads
  the node orientation (not `light.target`), so the export calls `sun.lookAt()` to
  point the node in the editor's azimuth/elevation — otherwise the sun always
  pointed straight down. Its lux intensity is pre-scaled so Blender's importer
  (which divides by 683 lm/W) lands the sun at a usable ~3.5 W/m² daylight level.
- **Daylight comes through the openings.** The render script sets every glass
  object (windows + skylights) to **not cast shadows**, so the sun streams through
  the wall/roof openings onto the floor (the panes still render to camera). Glass
  that cast shadows would block the light and leave the interior dark.
- **Eevee with real bounce — the sun filters in through the openings.** The render
  uses **Eevee Next** (not a path tracer). To make daylight actually *stream
  through* the windows/skylights and *bounce* to fill the rooms — rather than a
  flat ambient wash — it: (1) makes the **sun strong** (~12 W/m², soft disc),
  (2) enables **raytracing** for correctly-occluded indirect light + glass
  refraction, and (3) **bakes an irradiance volume** over the building so the sun
  landing on the floor bounces up onto the walls/ceiling. The roof's shadow is
  baked into that volume, so the rooms are lit by light that came *through the
  openings*, not by uniform world ambient (verified: with the sky world turned to
  ~0 the rooms still fill from sun-bounce alone). The sky world is kept moderate as
  a fill/background. Renders are ~18-24 s (the irradiance bake works in Blender's
  background mode).
- **Realistic blue sky backdrop in renders.** The world shows a **clear blue
  gradient sky** (horizon haze → zenith deep blue, no clouds) — but *only to the
  camera*. A `Light Path ▸ Is Camera Ray` node mixes it against the existing
  moderate ambient, so the gradient is what you **see** behind the building while
  the rooms are still **lit** by the same controlled fill (the interior lighting is
  unchanged). Matches the viewer's sky.
- Verified end-to-end against a local Blender (`--background`): the `.glb` imports
  with 8 named objects, 5 PBR materials (Glass transmission = 1.0), the floor
  `Color` attribute, the Sun, and renders in **Eevee Next**.
- In Blender: **File ▸ Import ▸ glTF 2.0**, select `floorplan.glb`. For glass
  to refract in Eevee, enable *Render Properties ▸ Raytracing* (or render in
  Cycles); add a world HDRI if you want softer ambient fill.

### Backend: save + Blender render (`server.py`)

`server.py` (stdlib only) serves the viewer and adds the endpoints the HUD calls.
Both render round-trips are verified end-to-end against a local Blender.

- **Persistence (source of truth).** `GET /api/floorplan-scad` returns the on-disk
  `floorplan.scad` (state header + geometry) for the client to restore from on
  load; `POST /api/save-scad` **overwrites** `floorplan.scad` in the server's
  directory with the client's current model. This is the **auto-save target** — the
  client writes on every edit (debounced); the **💾 Save** button forces an
  immediate flush. (See *Save / restore / export* above for the embedded-state
  format.) No browser storage is used.
- **`🖼 Render in Blender`** → `POST /api/render` (async **job**). The client
  exports the live model to a `.glb` (in memory) and sends it with the **current
  3D camera** (position, target, vertical fov); the server returns a `jobId`
  immediately and runs the render on a worker thread:
  `blender -b --factory-startup --python tools/blender_render.py` imports the
  `.glb`, **rebuilds the exact client view**, and renders with Eevee. The finished
  PNG is shown in a **modal** in the client (with *Save PNG*).
  - **Live progress.** `tools/blender_render.py` prints `@P <a> <b> <secs> <label>`
    phase markers (Importing model · Placing camera & lights · Baking light bounce ·
    Rendering · …). The server parses them and **interpolates the bar by time**
    across the long blocking steps (the bake and render emit no sub-progress on
    their own), so the modal shows a moving progress bar + the current phase label.
    The client **polls `GET /api/render-status?id=…`** (~3×/s) and fetches the image
    from `GET /api/render-result?id=…` when `done`. Jobs are one-shot and swept
    after a TTL.
  - Camera match: the client sends Z-up world coords; the `.glb` is Y-up (glTF),
    so Blender's importer rotates geometry by `(x,y,z) → (x,-z,y)` on import. The
    render script applies that **same transform to the camera** (`to_blender`) so
    the view lines up instead of coming out Y/Z-swapped.
  - **Matches the on-screen filtering, lighting preserved:** the filtered export
    (`buildGlb(true)`) includes only the floor(s) the floor-filter shows and the
    skylight glass only when the roof is shown — so the render looks like the
    viewer. The **roof slab is always exported (opaque)**; when the roof is hidden
    the client sends it in `shadowOnly`, and the render script makes it
    **camera-invisible but shadow-casting** (`visible_camera=False`,
    `visible_shadow=True`). So a hidden roof still throws the skylight/patio light
    patches onto the main floor, exactly like the live view.
  - The server finds Blender via `$BLENDER`, then `PATH`, then the macOS app path;
    runs renders on threads (`ThreadingHTTPServer`) so the UI stays responsive;
    caps render width to 1600px; and returns JSON errors (shown in the modal) if
    Blender is missing, times out, or produces no image.

### Limits

- **Other rooms are modeled as rectangles.** Only the patio is currently a
  traced polygon; the pipeline now supports `poly` on any room, so others
  (e.g. angled corners on the living room) can be refined the same way.
- **The central core is the least precise part.** WC, closets, the second stair
  and the hall are drawn from their printed sizes + measured wall lines, but
  those partitions are faintly drawn in the source image. Lower-level service
  rooms (Laundry/Mech/Storage) are unlabeled and placed by position.
- **Walls default to full height** (`WALL_H = 8 ft`) so first-person walkthroughs
  read as real rooms; the slider (2–12 ft) still lets you drop them to a low
  "dollhouse" height to read the layout from above.
- **`callMain` is one-shot per wasm instance** (OpenSCAD calls `exit()`, which
  tears the runtime down). The browser loader sidesteps this by re-importing a
  fresh module per `OpenSCAD()` call — but we only compile once anyway.
- Fonts (`openscad.fonts.js`, ~8 MB) are **not** vendored, since labels are an
  HTML overlay rather than OpenSCAD `text()`. Add it back if you want in-model
  text.

## Why this approach (vs. a from-scratch OpenSCAD renderer)

Writing a real OpenSCAD interpreter (CSG evaluator + mesh kernel) in JS is a
large undertaking and would only ever support a subset of the language. Using
the **official OpenSCAD compiled to WebAssembly** gives full-fidelity rendering
of *any* `.scad` file for ~7.5 MB of runtime, and three.js handles the WebGL.
For this floor plan that means you can edit `floorplan.scad` (or point the
viewer at a different `.scad`) and it Just Works.

## Files

| Path | What |
|------|------|
| `index.html` | Vite entry (mounts the React UI into `#root`) |
| `src/ui/` | React + TypeScript Figma-style chrome (App, TopBar, Left/RightPanel, BottomToolbar, controls, styles) |
| `src/main.js` | three.js viewer **engine** — scene, tools, geometry; wired by the React UI via element ids |
| `vite.config.ts` · `tsconfig.json` · `package.json` | Vite + React + TS build (`three/addons/*` aliased to examples) |
| `src/rooms.js` | Source-of-truth room table (geometry + colors + labels) + seeded stairs/furniture |
| `src/walls.js` | Unified wall graph + node editing + per-domain exporters (`exportRooms`/`exportDoors`/`exportWindows`, `stairSteps`, …) |
| `src/scad.js` | OpenSCAD text generator (`roomsToScad`) — one data table + parametric module per domain |
| `src/furniture.js` | Furniture types + `furnitureParts()` (pure geometry shared by viewer + SCAD) |
| `src/doors.js` | Door styles (`DOOR_STYLES`) + `doorLeafParts`/`doorLeaves`/`casingParts` (pure, shared by viewer + SCAD) |
| `src/moulding.js` | Moulding profiles + `mouldingRuns`/`mouldingRunParts`/`mouldingZ` (pure, shared by viewer + SCAD) |
| `src/cabinets.js` | Cabinet kinds + `cabinetParts()` (pure casework geometry shared by viewer + SCAD) |
| `src/normalize.js` | Pure state normalizers/migrations (`normDoor`/`normFurn`/`normCab`/`migrateStair`) — the legacy-load path, shared with the tests |
| `tests/` | Node `node:test` suites (`npm test`): pure model/scad/parse/doors/moulding/cabinets geometry, state-compat (legacy load), and (when `openscad` is on PATH) an STL-compile check |
| `tools/gen-scad.mjs` | Generates `floorplan.scad` from `rooms.js` |
| `tools/blender_render.py` | Headless Blender render of a `.glb` from the client's camera (used by the backend) |
| `floorplan.scad` | Generated OpenSCAD model (also opens standalone) |
| `vendor/openscad*` | Official openscad-wasm runtime (release 2022.03.20) |
| `server.py` | Dev server + backend: `GET /api/floorplan-scad` (read the source-of-truth file) · `POST /api/save-scad` (auto-save overwrite) · `POST /api/render` (Blender → PNG) |
| `serve.sh` | Launches `server.py` |
