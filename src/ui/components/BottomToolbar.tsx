import React from "react";
import { Icon } from "./icons";

// Every tool button is rendered ONCE; the engine shows/hides them per the active
// mode via `data-modes` (space-separated list of modes the tool belongs to, §3.1).
// The standalone Orbit tool is gone — orbit is Space-hold / middle-drag in every
// mode (and Tour mode is "just looking"). `kbd` is the single-key shortcut chip.
// Moulding/Cabinets have no tools yet (they arrive in Phases 4/5); their toolbars
// show only Select for now.
const TOOLS = [
  { id: "tool-select", key: "select", label: "Select", kbd: "V", modes: "layout doors windows moulding cabinets furniture structure labels" },
  { id: "tool-walk", key: "walk", label: "Walk", kbd: "", modes: "tour" },
  { id: "tool-measure", key: "measure", label: "Measure", kbd: "M", modes: "layout structure" },
  { id: "tool-edit", key: "walls", label: "Walls", kbd: "W", modes: "layout" },
  { id: "tool-doors", key: "doors", label: "Doors", kbd: "D", modes: "doors" },
  { id: "tool-windows", key: "windows", label: "Windows", kbd: "N", modes: "windows" },
  { id: "tool-moulding", key: "moulding", label: "Moulding", kbd: "A", modes: "moulding" },
  { id: "tool-cabinets", key: "cabinets", label: "Cabinet", kbd: "C", modes: "cabinets" },
  { id: "tool-stairs", key: "stairs", label: "Stairs", kbd: "S", modes: "structure" },
  { id: "tool-furniture", key: "furniture", label: "Furniture", kbd: "F", modes: "furniture" },
  { id: "tool-roof", key: "roof", label: "Roof", kbd: "R", modes: "structure" },
  { id: "tool-labels", key: "labels", label: "Label", kbd: "L", modes: "labels" },
];

export default function BottomToolbar() {
  return (
    <div className="toolbar-wrap">
      {/* engine writes hints / measure readings into #toolinfo */}
      <div id="toolinfo">Click any object to select it. Hold Space (or middle-drag) to orbit.</div>
      <div className="toolbar">
        {TOOLS.map((t, i) => (
          <div
            key={t.id}
            id={t.id}
            className={"tool" + (i === 0 ? " active" : "")}
            data-modes={t.modes}
            title={t.kbd ? `${t.label} — ${t.kbd}` : t.label}
          >
            <span className="ti">{Icon[t.key]}</span>
            <span>{t.label}</span>
            {t.kbd ? <span className="kbd">{t.kbd}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
