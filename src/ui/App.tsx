import React, { useEffect, useRef } from "react";
import TopBar from "./components/TopBar";
import LeftPanel from "./components/LeftPanel";
import RightPanel from "./components/RightPanel";
import BottomToolbar from "./components/BottomToolbar";

export default function App() {
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;                 // boot the engine exactly once
    booted.current = true;
    // The viewer engine boots on import (its build() runs immediately). We import
    // it only AFTER this commit, so every control element it wires to already
    // exists in the DOM.
    import("../main.ts").catch((e) => console.error("viewer engine failed:", e));
  }, []);

  return (
    <>
      {/* canvas host: the engine appends its <canvas> here and draws label/measure
          overlays into #labels / #overlays. Sits behind the chrome (z-index 0). */}
      <div id="app">
        <div id="labels" />
        <div id="overlays" />
        <div id="status"><div>Starting renderer…</div><div className="bar"><i /></div></div>
      </div>

      <TopBar />
      <LeftPanel />
      <RightPanel />
      <BottomToolbar />
    </>
  );
}
