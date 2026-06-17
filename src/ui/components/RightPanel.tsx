import React, { useState } from "react";
import { Toggle, Slider, NumField, Btn } from "./controls";
import { Align } from "./icons";

// The right panel has two real tabs (§3.5):
//  • Design — the selection inspector (per-domain subpanels). Each subpanel root
//    carries data-mode (space-separated); the engine hides panels not in the
//    current mode IN ADDITION TO the existing selection-driven show/hide.
//  • Scene  — the global Display / Dimensions / Sun / Export sections, moved here
//    VERBATIM (identical element ids, so the engine wiring is untouched).
// Both tabs stay MOUNTED (display:none toggle via React state) so the engine's
// id-wiring never breaks — every element exists at boot.
// Door-style front-elevation glyphs (~24×40) for the inspector style cards.
// Each is a small SVG schematic of the leaf face: slab plain, panel2/5 recessed
// rects, glazed15 a 3×5 lite grid, french two glazed halves, double two slabs.
const G = (children: React.ReactNode) => (
  <svg viewBox="0 0 24 40" width={24} height={40} className="door-glyph" aria-hidden>
    <rect x={1} y={1} width={22} height={38} rx={1} fill="none" stroke="currentColor" strokeWidth={1.4} />
    {children}
  </svg>
);
const rect = (x: number, y: number, w: number, h: number, key?: any) =>
  <rect key={key} x={x} y={y} width={w} height={h} fill="none" stroke="currentColor" strokeWidth={1} />;
const grid = (ox: number, ow: number) => {
  const cols = 3, rows = 5, x0 = ox + 2, y0 = 3, w = ow - 4, h = 34;
  const out: React.ReactNode[] = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++)
    out.push(rect(x0 + (c * w) / cols + 0.5, y0 + (r * h) / rows + 0.5, w / cols - 1, h / rows - 1, `${c}-${r}`));
  return out;
};
const DOOR_GLYPHS: { id: string; label: string; svg: React.ReactNode }[] = [
  { id: "slab", label: "Slab", svg: G(null) },
  { id: "panel2", label: "2-Panel", svg: G([rect(5, 4, 14, 14, "a"), rect(5, 22, 14, 14, "b")]) },
  { id: "panel5", label: "5-Panel", svg: G([0, 1, 2, 3, 4].map((i) => rect(5, 3 + i * 7, 14, 5.5, i))) },
  { id: "glazed15", label: "15-Lite", svg: G(grid(0, 24)) },
  { id: "french", label: "French", svg: G([<line key="m" x1={12} y1={1} x2={12} y2={39} stroke="currentColor" strokeWidth={1} />, ...grid(0, 12), ...grid(12, 12)]) },
  { id: "double", label: "Double", svg: G(<line x1={12} y1={1} x2={12} y2={39} stroke="currentColor" strokeWidth={1} />) },
  // sliding styles: an offset slab with a slide arrow (barn), and a two-panel
  // single-lite slider (patio) with the moving panel arrowed.
  { id: "sliding", label: "Sliding", svg: G([
    rect(6, 4, 16, 28, "p"),
    <path key="a" d="M5 36 H19 M16.5 33.5 L19 36 L16.5 38.5" fill="none" stroke="currentColor" strokeWidth={1.2} />,
  ]) },
  { id: "slidingGlass", label: "Glass Slider", svg: G([
    <line key="m" x1={12} y1={1} x2={12} y2={39} stroke="currentColor" strokeWidth={1} />,
    rect(4, 4, 6, 26, "g1"), rect(14, 4, 6, 26, "g2"),
    <path key="a" d="M14 35 H21 M19 33 L21 35 L19 37" fill="none" stroke="currentColor" strokeWidth={1.2} />,
  ]) },
];

// Moulding profile cross-section glyphs (~24×24): the stacked sub-boxes of each
// profile drawn in side elevation (z up, depth right). Mirrors MOULDING_PROFILES
// in src/moulding.js: each entry is [zFrac0, zFrac1, dFrac]. The wall face is the
// left edge; depth grows to the right. (Crown is the same profile mirrored at
// build time — the card glyph shows the base orientation.)
const MLD_PROFILES: { id: string; label: string; boxes: [number, number, number][] }[] = [
  { id: "square", label: "Square", boxes: [[0, 1, 1.0]] },
  { id: "stepped", label: "Stepped", boxes: [[0, 0.8, 0.7], [0.8, 1, 1.0]] },
  { id: "cove", label: "Cove", boxes: [[0, 0.55, 1.0], [0.55, 0.8, 0.66], [0.8, 1, 0.33]] },
];
const mldGlyph = (boxes: [number, number, number][]) => {
  const W = 18, H = 30, x0 = 3;            // wall face at x0, depth grows right
  return (
    <svg viewBox="0 0 24 36" width={24} height={36} className="door-glyph" aria-hidden>
      <line x1={x0} y1={2} x2={x0} y2={34} stroke="currentColor" strokeWidth={1} opacity={0.4} />
      {boxes.map(([zf0, zf1, df], i) => {
        const y = 3 + (1 - zf1) * H, h = (zf1 - zf0) * H, w = df * W;
        return <rect key={i} x={x0} y={y} width={w} height={h} fill="none" stroke="currentColor" strokeWidth={1.2} />;
      })}
    </svg>
  );
};

// Cabinet front-style glyphs (~24×40): a small front-elevation of a door face.
// slab = a plain panel; shaker = a framed panel with a recessed center + pull.
const CAB_FRONTS: { id: string; label: string; svg: React.ReactNode }[] = [
  { id: "slab", label: "Slab", svg: G(<line key="p" x1={18} y1={14} x2={18} y2={26} stroke="currentColor" strokeWidth={1.6} />) },
  { id: "shaker", label: "Shaker", svg: G([rect(5, 5, 14, 30, "f"), <line key="p" x1={16} y1={13} x2={16} y2={27} stroke="currentColor" strokeWidth={1.6} />]) },
];

export default function RightPanel() {
  const [tab, setTab] = useState<"design" | "scene">("design");
  return (
    <div className="panel right">
      <div className="tabs">
        <span className={"tab" + (tab === "design" ? " on" : "")} onClick={() => setTab("design")}>Design</span>
        <span className={"tab" + (tab === "scene" ? " on" : "")} onClick={() => setTab("scene")}>Scene</span>
      </div>

      {/* ---- DESIGN tab: the selection inspector ---- */}
      <div className="tab-body" style={{ display: tab === "design" ? "block" : "none" }}>
        <div className="section">
          <div className="section-h">Selection</div>
          {/* engine shows/hides each subpanel by style.display per active tool AND
              by data-mode per active mode. */}
          <div id="edit-controls" className="subpanel" data-mode="layout" style={{ display: "none" }}>
            <span id="sel-count">0 selected</span>
            {/* Figma-style align/distribute — acts on every selected control point.
                Align needs ≥2 points, distribute ≥3; the engine toggles .disabled. */}
            <div id="align-controls" className="align-bar">
              <Btn id="align-left" cls="align-btn" disabled title="Align left edges">{Align.left}</Btn>
              <Btn id="align-hcenter" cls="align-btn" disabled title="Align horizontal centers">{Align.hcenter}</Btn>
              <Btn id="align-right" cls="align-btn" disabled title="Align right edges">{Align.right}</Btn>
              <span className="align-sep" />
              <Btn id="align-top" cls="align-btn" disabled title="Align top edges">{Align.top}</Btn>
              <Btn id="align-vcenter" cls="align-btn" disabled title="Align vertical centers">{Align.vcenter}</Btn>
              <Btn id="align-bottom" cls="align-btn" disabled title="Align bottom edges">{Align.bottom}</Btn>
              <span className="align-sep" />
              <Btn id="dist-h" cls="align-btn" disabled title="Distribute horizontally">{Align.distH}</Btn>
              <Btn id="dist-v" cls="align-btn" disabled title="Distribute vertically">{Align.distV}</Btn>
            </div>
            <div className="btns"><Btn id="weld-sel" disabled title="Weld selected endpoints into one">⊕ Weld</Btn><Btn id="del-sel" disabled title="Delete — Del">✕ Delete</Btn></div>
          </div>
          <div id="door-controls" className="subpanel" data-mode="doors" style={{ display: "none" }}>
            <span id="door-count">0 selected</span>
            <div id="door-style" className="style-grid">
              {DOOR_GLYPHS.map((g) => (
                <button key={g.id} className="style-card" data-style={g.id} title={g.label}>
                  {g.svg}
                  <span className="style-lbl">{g.label}</span>
                </button>
              ))}
            </div>
            <NumField id="t-doorwidth" label="Width" min={1.5} max={8} step={0.5} value={2.6} suffix="ft" />
            <div className="prop">
              <span className="k">Color</span>
              <input type="color" id="door-color" defaultValue="#8a5a3c" style={{ flex: 1, height: 22, padding: 0, border: "none", background: "none" }} />
            </div>
            <Toggle id="t-doorcasing" label="Casing" />
            <div className="btns"><Btn id="flip-door" disabled title="Flip swing — F">⇄ Flip swing</Btn><Btn id="flip-hinge" disabled title="Flip hinge — G">⮃ Flip hinge</Btn></div>
            <div className="btns"><Btn id="del-door" disabled title="Delete — Del">✕ Delete</Btn></div>
          </div>
          <div id="window-controls" className="subpanel" data-mode="windows" style={{ display: "none" }}>
            <span id="win-count">0 selected</span>
            <NumField id="t-winwidth" label="Width" min={1.5} max={10} step={0.5} value={3} suffix="ft" />
            <NumField id="t-winsill" label="Sill" min={0} max={6} step={0.25} value={1.2} suffix="ft" />
            <NumField id="t-winheight" label="Height" min={0.5} max={8} step={0.25} value={2} suffix="ft" />
            <div className="btns"><Btn id="del-win" disabled title="Delete — Del">✕ Delete</Btn></div>
          </div>
          <div id="moulding-controls" className="subpanel" data-mode="moulding" style={{ display: "none" }}>
            <span id="mld-count">New mouldings will use these settings</span>
            {/* kind segmented control (Base · Chair · Crown) */}
            <div id="mld-kind" className="seg" style={{ marginTop: 6 }}>
              <div className="tool active" data-kind="base">Base</div>
              <div className="tool" data-kind="chair">Chair</div>
              <div className="tool" data-kind="crown">Crown</div>
            </div>
            {/* profile cards (cross-section glyphs) */}
            <div id="mld-profile" className="style-grid">
              {MLD_PROFILES.map((p) => (
                <button key={p.id} className="style-card" data-profile={p.id} title={p.label}>
                  {mldGlyph(p.boxes)}
                  <span className="style-lbl">{p.label}</span>
                </button>
              ))}
            </div>
            <NumField id="t-mldh" label="Height" min={0.1} max={1.5} step={0.05} value={0.45} suffix="ft" />
            <NumField id="t-mldd" label="Depth" min={0.02} max={0.3} step={0.01} value={0.06} suffix="ft" />
            <div className="prop">
              <span className="k">Color</span>
              <input type="color" id="mld-color" defaultValue="#f0ece4" style={{ flex: 1, height: 22, padding: 0, border: "none", background: "none" }} />
            </div>
            <div className="btns"><Btn id="mld-all" title="Apply to every room on the visible level">⊞ Apply to level</Btn><Btn id="del-mld" disabled title="Delete — Del">✕ Delete</Btn></div>
          </div>
          <div id="cabinet-controls" className="subpanel" data-mode="cabinets" style={{ display: "none" }}>
            <span id="cab-count">New cabinets will use these settings</span>
            {/* kind segmented control (Base · Wall · Tall) — retype applies kind
                defaults to d/h/mount, keeps x/y/w. */}
            <div id="cab-kind" className="seg" style={{ marginTop: 6 }}>
              <div className="tool active" data-kind="base">Base</div>
              <div className="tool" data-kind="wall">Wall</div>
              <div className="tool" data-kind="tall">Tall</div>
            </div>
            {/* front-style cards (Slab · Shaker) */}
            <div id="cab-front" className="style-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
              {CAB_FRONTS.map((f) => (
                <button key={f.id} className="style-card" data-front={f.id} title={f.label}>
                  {f.svg}
                  <span className="style-lbl">{f.label}</span>
                </button>
              ))}
            </div>
            <NumField id="t-cabw" label="Width" min={1} max={8} step={0.5} value={2} suffix="ft" />
            <NumField id="t-cabd" label="Depth" min={0.5} max={3} step={0.25} value={2} suffix="ft" />
            <NumField id="t-cabh" label="Height" min={1} max={8} step={0.5} value={3} suffix="ft" />
            {/* drawers stepper (0–3) */}
            <div className="prop">
              <span className="k">Drawers</span>
              <div id="cab-drawers" className="seg" style={{ flex: 1 }}>
                <div className="tool active" data-drawers="0">0</div>
                <div className="tool" data-drawers="1">1</div>
                <div className="tool" data-drawers="2">2</div>
                <div className="tool" data-drawers="3">3</div>
              </div>
            </div>
            <Toggle id="t-cabcounter" label="Countertop" defaultChecked />
            {/* mount height — shown/meaningful for wall cabinets */}
            <NumField id="t-cabmount" label="Mount" min={0} max={6} step={0.25} value={0} suffix="ft" />
            <div className="prop">
              <span className="k">Color</span>
              <input type="color" id="cab-color" defaultValue="#9aa3ad" style={{ flex: 1, height: 22, padding: 0, border: "none", background: "none" }} />
            </div>
            <div className="prop">
              <span className="k">Counter</span>
              <input type="color" id="cab-countercolor" defaultValue="#dcd8d0" style={{ flex: 1, height: 22, padding: 0, border: "none", background: "none" }} />
            </div>
            <div className="btns"><Btn id="rot-cab" title="Rotate — R">⟳ Rotate</Btn><Btn id="del-cab" disabled title="Delete — Del">✕ Delete</Btn></div>
          </div>
          <div id="stairs-controls" className="subpanel" data-mode="structure" style={{ display: "none" }}>
            <span id="stair-count">0 selected</span>
            <NumField id="t-stairwidth" label="Width" min={2} max={12} step={0.5} value={3} suffix="ft" />
            <NumField id="t-stairrun" label="Run" min={2} max={20} step={0.5} value={4} suffix="ft" />
            <NumField id="t-stairrise" label="Rise" min={0} max={12} step={0.1} value={4.3} suffix="ft" />
            <NumField id="t-stairdrop" label="Drop" min={0} max={12} step={0.1} value={0} suffix="ft" />
            <Slider id="t-stairsteps" label="Steps" min={2} max={24} step={1} value={6} />
            <div className="btns"><Btn id="add-flight" title="Add a turning flight + landing">＋ Flight</Btn><Btn id="del-flight" title="Remove the last flight">－ Flight</Btn></div>
            <div className="btns"><Btn id="rot-stair" title="Rotate — R">⟳ Rotate</Btn><Btn id="flip-stair" title="Flip — F">⇅ Flip</Btn></div>
            <div className="btns"><Btn id="del-stair" disabled title="Delete — Del">✕ Delete</Btn></div>
          </div>
          <div id="furniture-controls" className="subpanel" data-mode="furniture" style={{ display: "none" }}>
            <span id="furn-count">0 selected</span>
            <div className="prop">
              <span className="k">Type</span>
              <select id="furn-type" className="furn-sel" style={{ flex: 1 }} />
            </div>
            <NumField id="t-furnwidth" label="Width" min={0.5} max={14} step={0.5} value={2} suffix="ft" />
            <NumField id="t-furndepth" label="Depth" min={0.5} max={14} step={0.5} value={2} suffix="ft" />
            <NumField id="t-furnheight" label="Height" min={0.5} max={6} step={0.1} value={3} suffix="ft" />
            <div className="prop">
              <span className="k">Color</span>
              <input type="color" id="furn-color" defaultValue="#b89a72" style={{ flex: 1, height: 22, padding: 0, border: "none", background: "none" }} />
            </div>
            <div className="btns"><Btn id="rot-furn" title="Rotate — R">⟳ Rotate</Btn><Btn id="del-furn" disabled title="Delete — Del">✕ Delete</Btn></div>
          </div>
          <div id="roof-controls" className="subpanel" data-mode="structure" style={{ display: "none" }}>
            <div className="btns"><Btn id="roof-kind" title="Toggle add: Skylight / Cut">＋ Skylight</Btn><Btn id="del-roof" disabled title="Delete — Del">✕ Delete</Btn></div>
            <span id="roof-count">0 selected</span>
            <Slider id="t-skyw" label="Width" min={1} max={14} step={0.5} value={3} suffix=" ft" />
            <Slider id="t-skyd" label="Depth" min={1} max={14} step={0.5} value={3} suffix=" ft" />
          </div>
          {/* Labels (Phase 7): positionable scene text annotations. The text input
              is uncontrolled — the engine wires input (live) / change (commit). */}
          <div id="label-controls" className="subpanel" data-mode="labels" style={{ display: "none" }}>
            <span id="label-count">New labels will use these settings</span>
            <div className="prop">
              <span className="k">Text</span>
              <input type="text" id="label-text" className="furn-sel" style={{ flex: 1 }} placeholder="Label" />
            </div>
            <div className="btns"><Btn id="label-del" disabled title="Delete — Del">✕ Delete</Btn></div>
          </div>
          {/* First-person walkthrough: drop into the model at eye level (Tour mode) */}
          <div id="walk-controls" className="subpanel" data-mode="tour" style={{ display: "none" }}>
            <div className="muted" style={{ fontSize: 11, lineHeight: 1.5, marginBottom: 6 }}>
              Click the floor to <b>drop in</b> · drag to look · <b>WASD</b>/arrows to walk · scroll to step · <b>Q/E</b> eye height · <b>Esc</b> to exit. Then hit <b>▶ Render</b> to render this eye-level view in Blender.
            </div>
            <Slider id="t-eye" label="Eye height" min={1} max={10} step={0.25} value={5.5} suffix=" ft" />
            <Slider id="t-fov" label="Field of view" min={30} max={100} step={5} value={70} suffix="°" />
            <div className="prop"><span className="k">Heading</span><span className="v" id="fp-head-v" style={{ minWidth: 70 }}>—</span></div>
            <div className="btns"><Btn id="fp-center">⦿ Drop in center</Btn></div>
          </div>
          {/* Wall + Room are read-only properties shown by the Select tool in every
              non-tour mode. The "Edit points" shortcut is layout-only; in doors mode
              the engine shows the "Add door — D" hint instead (§3.3 item 6). */}
          <div id="wall-controls" className="subpanel" data-mode="layout doors windows moulding cabinets furniture structure" style={{ display: "none" }}>
            <div className="prop"><span className="k">Type</span><span className="v" style={{ flex: 1, textAlign: "left" }}>Wall</span></div>
            <div className="prop"><span className="k">Length</span><span className="v" id="wall-len">—</span></div>
            <div className="prop"><span className="k">Level</span><span className="v" id="wall-level" style={{ minWidth: 70 }}>—</span></div>
            <div className="btns"><div id="wall-edit-points" className="tool" onClick={() => (window as any).viewer?.setMode?.("edit")}>✎ Edit points</div></div>
            <div id="wall-mode-hint" className="muted" style={{ display: "none", fontSize: 11, lineHeight: 1.5, marginTop: 6 }} />
          </div>
          <div id="room-controls" className="subpanel" data-mode="layout doors windows moulding cabinets furniture structure" style={{ display: "none" }}>
            <div className="prop">
              <span className="k">Room</span>
              <span className="sw" id="room-color" style={{ width: 12, height: 12, borderRadius: 3 }} />
              <span className="v" id="room-name" style={{ flex: 1, textAlign: "left", minWidth: 0 }}>—</span>
            </div>
            <div className="prop"><span className="k">Level</span><span className="v" id="room-level" style={{ minWidth: 70 }}>—</span></div>
            <div className="prop"><span className="k">Size</span><span className="v" id="room-dims" style={{ minWidth: 90 }}>—</span></div>
            <div className="prop"><span className="k">Area</span><span className="v" id="room-area">—</span></div>
          </div>
          <div className="muted" id="sel-empty" style={{ fontSize: 11, lineHeight: 1.5 }}>
            Click any object in the canvas to see its properties. Hold <b>Space</b> (or middle-drag) to orbit.
          </div>
        </div>
      </div>

      {/* ---- SCENE tab: global Display / Dimensions / Sun / Export ---- */}
      <div className="tab-body" style={{ display: tab === "scene" ? "block" : "none" }}>
        <div className="section">
          <div className="section-h">Display</div>
          <Toggle id="t-walls" label="Walls" defaultChecked />
          <Toggle id="t-labels" label="Room labels" />
          <Toggle id="t-framing" label="Framing (studs)" />
          <Toggle id="t-roof" label="Roof" hint="(lights main when off)" />
          <Toggle id="t-explode" label="Explode levels" defaultChecked />
          <Toggle id="t-grid" label="Snap to 1 ft grid" defaultChecked />
        </div>

        <div className="section">
          <div className="section-h">Dimensions</div>
          <Slider id="t-height" label="Wall height" min={2} max={12} step={0.5} value={8} suffix=" ft" />
          <Slider id="t-dooropen" label="Doors open" min={0} max={110} step={5} value={80} suffix="°" />
        </div>

        <div className="section">
          <div className="section-h">Sun</div>
          <Slider id="t-sunaz" label="Direction" min={0} max={360} step={5} value={235} suffix="°" />
          <Slider id="t-sunel" label="Height" min={5} max={89} step={1} value={45} suffix="°" />
        </div>

        {/* Reference plan (engine wires #ref-upload / #ref-clear / #ref-status /
            t-refshow / t-refopacity / t-refwidth / t-refx / t-refy): an uploaded
            image onion-skinned over the top-down Plan view for tracing. */}
        <div className="section">
          <div className="section-h">Reference plan</div>
          <div className="btns">
            <Btn id="ref-upload" title="Upload an image to trace over in Plan view">⬆ Upload image…</Btn>
            <Btn id="ref-clear" title="Remove the reference image">✕ Remove</Btn>
          </div>
          <div className="muted" id="ref-status" style={{ fontSize: 11, lineHeight: 1.5, margin: "4px 0 6px" }}>
            No image loaded.
          </div>
          <Toggle id="t-refshow" label="Show overlay" defaultChecked />
          <Slider id="t-refopacity" label="Opacity" min={5} max={100} step={5} value={50} suffix="%" />
          <NumField id="t-refwidth" label="Width" min={2} max={1000} step={1} value={50} suffix="ft" />
          <NumField id="t-refx" label="Offset X" min={-1000} max={1000} step={1} value={0} suffix="ft" />
          <NumField id="t-refy" label="Offset Y" min={-1000} max={1000} step={1} value={0} suffix="ft" />
        </div>

        <div className="section">
          <div className="section-h">Export</div>
          <div className="btns">
            <Btn id="export">⬇ .scad</Btn>
            <Btn id="export-glb">⬇ .glb</Btn>
          </div>
          <div className="btns">
            <Btn id="save-server">💾 Save .scad</Btn>
            <Btn id="reset">↺ Reset</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
