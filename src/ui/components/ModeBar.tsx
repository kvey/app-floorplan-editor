import React from "react";

// The mode bar (§3.2): a horizontal segmented control in the top-bar center.
// Each segment carries data-mode + its key number; the engine wires #mode-bar
// .tool[data-mode] exactly like #view-mode, toggling .active and showing the
// matching tool buttons / inspector sections. Modes are SESSION UI state only —
// they are never persisted to the .scad header. The editor opens in Layout.
const MODES = [
  { mode: "layout", label: "Layout", key: "1" },
  { mode: "doors", label: "Doors", key: "2" },
  { mode: "windows", label: "Windows", key: "3" },
  { mode: "moulding", label: "Moulding", key: "4" },
  { mode: "cabinets", label: "Cabinets", key: "5" },
  { mode: "furniture", label: "Furniture", key: "6" },
  { mode: "structure", label: "Structure", key: "7" },
  { mode: "tour", label: "Tour", key: "8" },
  { mode: "labels", label: "Labels", key: "9" },
];

export default function ModeBar() {
  return (
    <div className="seg modebar" id="mode-bar">
      {MODES.map((m, i) => (
        <div
          key={m.mode}
          className={"tool" + (i === 0 ? " active" : "")}
          data-mode={m.mode}
          title={`${m.label} — ${m.key}`}
        >
          <span>{m.label}</span>
          <span className="modekey">{m.key}</span>
        </div>
      ))}
    </div>
  );
}
