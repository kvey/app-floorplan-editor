import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// NOTE: no <StrictMode> — the viewer engine (src/main.js) runs its one-time
// build() on import, and StrictMode's double-invoked effects would boot it twice.
createRoot(document.getElementById("root")!).render(<App />);
