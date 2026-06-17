import React, { useEffect, useState } from "react";
import { Btn } from "./controls";

// ---- Live Layers panel (§5.2) ----------------------------------------------
// The engine dispatches a `kirkham:model` CustomEvent (detail = modelIndex())
// after every commit / applySnap / switchState, and once at boot. This panel is
// a thin React mirror of that event: collapsible per-domain groups with count
// badges, rows that select their object, and a per-group eye toggle that
// hides/shows the domain (session-only). It does NOT own model state — it only
// reflects what the engine reports, keeping the uncontrolled id-wiring intact.

type Row = { i: number; name?: string; label?: string; color?: string; level?: number; kind?: string };
type Model = Record<string, Row[]>;

// domain key → display title + the noun the count badge uses. Order = render order.
const GROUPS: { key: string; title: string }[] = [
  { key: "rooms", title: "Rooms" },
  { key: "doors", title: "Doors" },
  { key: "windows", title: "Windows" },
  { key: "moulding", title: "Moulding" },
  { key: "cabinets", title: "Cabinets" },
  { key: "furniture", title: "Furniture" },
  { key: "stairs", title: "Stairs" },
  { key: "roof", title: "Roof" },
  { key: "labels", title: "Labels" },
];
// Moulding/Cabinets are empty until Phases 4/5 — render them ONLY when non-empty.
const HIDE_WHEN_EMPTY = new Set(["moulding", "cabinets"]);

function LayersPanel() {
  const [model, setModel] = useState<Model>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [hidden, setHidden] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const onModel = (e: Event) => setModel(((e as CustomEvent).detail || {}) as Model);
    window.addEventListener("kirkham:model", onModel as EventListener);
    return () => window.removeEventListener("kirkham:model", onModel as EventListener);
  }, []);

  const rowLabel = (key: string, r: Row) => {
    if (key === "rooms") return (r.name || "Room") + (r.level === 0 ? " · lower" : "");
    const lvl = r.level === 0 ? " · lower" : "";
    return (r.label || r.name || "Item") + lvl;
  };

  const toggleEye = (key: string) => {
    const next = !hidden[key];
    setHidden((h) => ({ ...h, [key]: next }));
    (window as any).viewer?.setDomainVisible?.(key, !next);
  };

  return (
    <div className="section">
      <div className="section-h">Layers</div>
      {GROUPS.map(({ key, title }) => {
        const rows = model[key] || [];
        if (!rows.length && HIDE_WHEN_EMPTY.has(key)) return null;
        const isCollapsed = !!collapsed[key];
        const isHidden = !!hidden[key];
        return (
          <div className="layer-grp" key={key}>
            <div className="layer-group lg-head">
              <span className="lg-toggle" onClick={() => setCollapsed((c) => ({ ...c, [key]: !isCollapsed }))}>
                {isCollapsed ? "▸" : "▾"} {title}
              </span>
              <span className="lg-right">
                <span className="lg-count">{rows.length}</span>
                <span
                  className={"lg-eye" + (isHidden ? " off" : "")}
                  title={isHidden ? "Show " + title : "Hide " + title}
                  onClick={() => toggleEye(key)}
                >
                  {isHidden ? "🚫" : "👁"}
                </span>
              </span>
            </div>
            {!isCollapsed && (
              <div className="layers">
                {rows.map((r) => (
                  <div
                    className={"layer" + (isHidden ? " dim" : "")}
                    key={key + ":" + r.i + ":" + (r.kind || "")}
                    onClick={() => (window as any).viewer?.selectObject?.(key, r.i)}
                  >
                    {r.color ? <span className="sw" style={{ background: r.color }} /> : <span className="ico">·</span>}
                    <span className="nm">{rowLabel(key, r)}</span>
                  </div>
                ))}
                {!rows.length && <div className="layer dim"><span className="nm muted">None</span></div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function LeftPanel() {
  return (
    <div className="panel left">
      <div className="section">
        <div className="section-h">Levels</div>
        {/* engine wires #floor-filter .tool[data-floor] */}
        <div className="seg" id="floor-filter" style={{ flexDirection: "column" }}>
          <div className="tool active" data-floor="both">Both floors</div>
          <div className="tool" data-floor="1">Main level</div>
          <div className="tool" data-floor="0">Lower level</div>
        </div>
      </div>

      <div className="section">
        <div className="section-h">Scenario · A → B</div>
        {/* The engine renders the A→B walkthrough strip, step list, and
            play/prev/next controls into #scenario (see renderScenario in main.js). */}
        <div id="scenario" className="scenario" />
      </div>

      {/* Live layers (§5.2): reflects the kirkham:model event, replacing the old
          static ROOMS list. */}
      <LayersPanel />

      <div className="section">
        <div className="section-h">History</div>
        <div className="btns">
          <Btn id="undo">↶ Undo</Btn>
          <Btn id="redo">↷ Redo</Btn>
        </div>
        {/* engine fills #history + writes #saved */}
        <div id="history" />
        <div id="saved" />
      </div>
    </div>
  );
}
