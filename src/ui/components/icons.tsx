import React from "react";

const P = (d: string) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

export const Icon: Record<string, React.ReactNode> = {
  select: P("M4 4l7 16 2.5-6.5L20 11z"),                                  // cursor / move
  orbit: P("M21 12a9 9 0 1 1-3-6.7M21 3v6h-6"),                           // orbit / rotate
  measure: P("M3 8h18v8H3zM7 8v3M11 8v4M15 8v3M19 8v4"),                  // ruler
  walls: P("M5 19l8-8 6 6M11 13l-4-4 9-5"),                               // pen / node
  doors: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 21V4h9v17" /><path d="M4 21h16" /><circle cx="12.5" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  ),
  windows: P("M4 4h16v16H4zM12 4v16M4 12h16"),                            // window
  moulding: P("M4 20h16M4 20v-3h12v-2h4M8 17v-2h8"),                      // stepped trim profile
  cabinets: P("M5 3h14v18H5zM12 3v18M8 7v3M16 7v3"),                      // cabinet doors + pulls
  stairs: P("M4 20v-4h4v-4h4v-4h4V4"),                                    // stairs (ascending steps)
  roof: P("M3 12l9-7 9 7M6 11v8h12v-8"),                                  // roof
  furniture: P("M4 11V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3M3 11h18v6M5 17v2M19 17v2"),  // sofa / furniture
  labels: P("M7 7h10M7 12h7M5 4h11l3 3v13H5z"),                                        // tag / label

  walk: (                                                                  // first-person walker
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="4" r="2" fill="currentColor" stroke="none" />
      <path d="M12 7v6M12 9l-4-1M12 9l4 2M12 13l-2.5 7M12 13l3 6" />
    </svg>
  ),
};

// Figma-style align/distribute glyphs: a reference line (stroke) plus two/three
// bars (filled) that snap to it. Used by the multi-select align bar in #edit-controls.
const alignSvg = (children: React.ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round">
    {children}
  </svg>
);
const bar = (k: number, x: number, y: number, w: number, h: number) =>
  <rect key={k} x={x} y={y} width={w} height={h} rx="1" fill="currentColor" stroke="none" />;
const ln = (x1: number, y1: number, x2: number, y2: number) =>
  <line key="l" x1={x1} y1={y1} x2={x2} y2={y2} />;

export const Align: Record<string, React.ReactNode> = {
  left:    alignSvg(<>{ln(4, 3, 4, 21)}{bar(1, 4, 7, 14, 4)}{bar(2, 4, 14, 9, 4)}</>),
  hcenter: alignSvg(<>{ln(12, 3, 12, 21)}{bar(1, 5, 7, 14, 4)}{bar(2, 8, 14, 8, 4)}</>),
  right:   alignSvg(<>{ln(20, 3, 20, 21)}{bar(1, 6, 7, 14, 4)}{bar(2, 11, 14, 9, 4)}</>),
  top:     alignSvg(<>{ln(3, 4, 21, 4)}{bar(1, 7, 4, 4, 14)}{bar(2, 14, 4, 4, 9)}</>),
  vcenter: alignSvg(<>{ln(3, 12, 21, 12)}{bar(1, 7, 5, 4, 14)}{bar(2, 14, 8, 4, 8)}</>),
  bottom:  alignSvg(<>{ln(3, 20, 21, 20)}{bar(1, 7, 6, 4, 14)}{bar(2, 14, 11, 4, 9)}</>),
  distH:   alignSvg(<>{bar(1, 3, 6, 3, 12)}{bar(2, 10.5, 6, 3, 12)}{bar(3, 18, 6, 3, 12)}</>),
  distV:   alignSvg(<>{bar(1, 6, 3, 12, 3)}{bar(2, 6, 10.5, 12, 3)}{bar(3, 6, 18, 12, 3)}</>),
};

// small monochrome glyphs for the Layers list
export const Layer: Record<string, React.ReactNode> = {
  frame: P("M5 3v18M19 3v18M3 5h18M3 19h18"),
  square: P("M4 4h16v16H4z"),
  open: P("M4 4h16v16H4z M4 4l16 16"),
};
