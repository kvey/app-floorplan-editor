// Presentational controls that render the exact DOM ids/classes the viewer
// engine (src/main.js) wires to. They are intentionally UNCONTROLLED
// (defaultChecked / defaultValue) so the engine remains the source of truth and
// can freely read .checked/.value and write .textContent without React fighting it.
import React from "react";
// @ts-ignore — pure parse/format helpers (also used by Node tests)
import { parseFeet, clamp, formatField } from "../ftparse";

export function Toggle(props: { id: string; label: string; defaultChecked?: boolean; hint?: string }) {
  return (
    <label className="toggle" htmlFor={props.id}>
      <input type="checkbox" id={props.id} defaultChecked={props.defaultChecked} />
      <span>{props.label}{props.hint ? <span className="h"> {props.hint}</span> : null}</span>
    </label>
  );
}

export function Slider(props: {
  id: string; label: string; min: number; max: number; step: number; value: number; suffix?: string;
}) {
  const suffix = props.suffix ?? "";
  return (
    <div className="prop">
      <span className="k">{props.label}</span>
      <input type="range" id={props.id} min={props.min} max={props.max} step={props.step} defaultValue={props.value} />
      <span className="v" id={props.id + "-v"}>{props.value}{suffix}</span>
    </div>
  );
}

// NumField (§5.1): a typed + scrubbed numeric input that DROP-IN replaces a
// Slider. It keeps the SAME element-id contract the engine wires to:
//   • <input id={id}> — the engine reads `.value` (decimal feet/number) and
//     listens for `input` (live scrub) + `change` (commit), exactly like a range.
//   • <span id={id+"-v"}> — kept (hidden) so any legacy engine readout write is
//     harmless. The visible value lives IN the input itself (ft-in formatted).
//
// ENGINE CONTRACT (settled for Phase 3+):
//   - On every value the NumField commits, it sets input.value to the DECIMAL
//     number string FIRST, then dispatches `input`/`change` (so the engine's
//     `+e.target.value` reads stay correct), then reformats input.value to ft-in
//     for the resting display.
//   - When the ENGINE pushes a value into the field (selection sync), it sets
//     input.value to the raw number and dispatches a `kirkham:fmt` CustomEvent on
//     the input; NumField listens and reformats for display. (Engine helper in
//     main.js: numField()/setNumField().)
// Self-contained behavior: type "3'6\"", drag the label to scrub, Up/Down to step
// (Shift ×10), Enter/blur commits, Escape reverts.
export function NumField(props: {
  id: string; label: string; min: number; max: number; step: number; value: number; suffix?: string;
}) {
  const suffix = props.suffix ?? "";
  const ref = React.useRef<HTMLInputElement>(null);
  const lastCommitted = React.useRef<number>(props.value);

  // Push a decimal number → input (display formatted) and fire the engine events.
  const emit = (num: number, kind: "input" | "change") => {
    const el = ref.current; if (!el) return;
    const v = clamp(num, props.min, props.max);
    el.value = String(v);                                  // engine reads decimal
    el.dispatchEvent(new Event(kind, { bubbles: true }));  // engine handler runs here
    if (kind === "change") lastCommitted.current = v;
    el.value = formatField(v, suffix);                     // resting ft-in display
  };

  const commitFromText = () => {
    const el = ref.current; if (!el) return;
    const n = parseFeet(el.value);
    if (n == null) { el.value = formatField(lastCommitted.current, suffix); return; }  // revert
    const v = clamp(n, props.min, props.max);
    // de-dupe: don't re-commit the same value (e.g. Enter then the blur it triggers)
    if (v === lastCommitted.current) { el.value = formatField(v, suffix); return; }
    emit(n, "change");
  };

  React.useEffect(() => {
    const el = ref.current; if (!el) return;
    // initial resting display
    el.value = formatField(props.value, suffix);
    lastCommitted.current = props.value;
    // the engine re-formats by setting el.value (raw number) + dispatching this:
    const onFmt = () => {
      const n = parseFeet(el.value);
      if (n != null) { lastCommitted.current = n; el.value = formatField(n, suffix); }
    };
    el.addEventListener("kirkham:fmt", onFmt as EventListener);
    return () => el.removeEventListener("kirkham:fmt", onFmt as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); commitFromText(); ref.current?.blur(); return; }
    if (e.key === "Escape") {
      e.preventDefault();
      if (ref.current) ref.current.value = formatField(lastCommitted.current, suffix);
      ref.current?.blur();
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const dir = e.key === "ArrowUp" ? 1 : -1;
      const cur = parseFeet(ref.current?.value ?? "") ?? lastCommitted.current;
      emit(cur + dir * props.step * (e.shiftKey ? 10 : 1), "change");
    }
  };

  // Label drag = Figma scrub: step per 4px, input events during, change on release.
  const onLabelDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const base = parseFeet(ref.current?.value ?? "") ?? lastCommitted.current;
    const big = e.shiftKey;
    const move = (ev: MouseEvent) => {
      const dpx = ev.clientX - startX;
      const steps = Math.round(dpx / 4) * (big || ev.shiftKey ? 10 : 1);
      emit(base + steps * props.step, "input");
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const cur = parseFeet(ref.current?.value ?? "") ?? lastCommitted.current;
      emit(cur, "change");                                  // commit on release
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div className="prop numfield">
      <span className="k scrub" onMouseDown={onLabelDown} title="Drag to scrub">{props.label}</span>
      <input
        type="text" id={props.id} ref={ref} className="numinput"
        defaultValue={formatField(props.value, suffix)}
        onKeyDown={onKeyDown}
        onBlur={commitFromText}
        onFocus={(e) => e.currentTarget.select()}
      />
      <span className="v" id={props.id + "-v"} style={{ display: "none" }} />
    </div>
  );
}

// A generic engine button (the engine attaches onclick by id). `cls` lets the
// caller pick the visual style (e.g. "tb-btn" for the top-bar primary button).
export function Btn(props: { id: string; children: React.ReactNode; cls?: string; disabled?: boolean; title?: string }) {
  return (
    <div id={props.id} title={props.title} className={(props.cls ?? "tool") + (props.disabled ? " disabled" : "")}>
      {props.children}
    </div>
  );
}
