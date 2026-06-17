import React from "react";
import ModeBar from "./ModeBar";

export default function TopBar() {
  return (
    <div className="topbar">
      <div className="tb-logo">K</div>
      <div className="tb-title">Floor Plan Studio</div>
      <span className="tb-chip">Local</span>
      <div className="tb-spacer" />
      {/* Mode bar (§3.2): the 8 domain modes, centered. Engine wires #mode-bar. */}
      <ModeBar />
      <div className="tb-spacer" />
      {/* 3D / Plan view — engine wires #view-mode .tool[data-view]. Sits right of modes. */}
      <div className="seg" id="view-mode" style={{ width: 138 }}>
        <div className="tool active" data-view="persp">3D</div>
        <div className="tool" data-view="plan">Plan</div>
      </div>
      {/* Zoom readout (§5.4): engine updates #zoom-pct each frame (only on change).
          Shift+1 zoom-to-fit · Shift+2 zoom-to-selection. Display-only. */}
      <span className="tb-zoom" id="zoom-pct" title="Shift+1 fit · Shift+2 selection">100%</span>
      {/* primary action — engine wires #render-server (single instance lives here) */}
      <div id="render-server" className="tb-btn">▶&nbsp; Render</div>
    </div>
  );
}
