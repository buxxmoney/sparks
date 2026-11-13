"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { area as d3area, curveBumpX } from "d3-shape";
import { Maximize2, Minus, Plus } from "lucide-react";
import type { BillLine } from "./bill-breakdown-dialog";

/* ─────────────── Palette ───────────────
   Five categorical hues, one per charge category, validated with the dataviz
   checker in BOTH modes (lightness band, chroma floor, CVD separation,
   normal-vision floor, contrast). The worst adjacent pair sits in the tritan
   floor band, legal only with secondary encoding — every node carries a direct
   label, so identity never rests on colour alone. */
const SERIES: Record<BillLine["group"], { light: string; dark: string }> = {
  active_energy: { light: "#0c6c30", dark: "#1b9150" }, // Sparks brand green
  demand: { light: "#2a78d6", dark: "#3987e5" },
  reactive_energy: { light: "#eda100", dark: "#c98500" },
  fixed: { light: "#7a5bb5", dark: "#9085e9" },
  ancillary: { light: "#c2185b", dark: "#e0537f" },
};

const GROUP_TITLE: Record<BillLine["group"], string> = {
  active_energy: "Active energy",
  demand: "Demand",
  reactive_energy: "Reactive energy",
  fixed: "Fixed charges",
  ancillary: "Other charges",
};

function formatRand(cents: number): string {
  const r = cents / 100;
  const [whole, frac] = Math.abs(r).toFixed(2).split(".");
  return `${r < 0 ? "-" : ""}R ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}.${frac}`;
}

/**
 * A flow ribbon between two columns: a filled band following a horizontal-tangent
 * cubic (d3 `curveBumpX`), so it leaves and meets each node perfectly flat.
 *
 * Deliberately a FILLED area rather than a stroked centre-line. Stroking with a
 * round linecap sounds like the way to get soft ends, but a cap is a semicircle
 * of the stroke's own width — on an 80px-thick flow that is a 40px bulb erupting
 * past the node and over the labels. Filled bands keep their ends flush against
 * the node; softness comes from the curve and the spacing between streams.
 */
const ribbonPath = d3area<{ x: number; y0: number; y1: number }>()
  .x((d) => d.x)
  .y0((d) => d.y0)
  .y1((d) => d.y1)
  .curve(curveBumpX);

function ribbon(x0: number, y0: number, t0: number, x1: number, y1: number, t1: number): string {
  const mid = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const mt = (t0 + t1) / 2;
  return (
    ribbonPath([
      { x: x0, y0: y0 - t0 / 2, y1: y0 + t0 / 2 },
      { x: mid, y0: my - mt / 2, y1: my + mt / 2 },
      { x: x1, y0: y1 - t1 / 2, y1: y1 + t1 / 2 },
    ]) ?? ""
  );
}

interface FlowNode {
  key: string;
  label: string;
  amountCents: number;
  group: BillLine["group"];
  y: number;
  height: number;
  labelY: number;
}

/**
 * Push label anchors apart so text never overlaps, without moving the nodes.
 *
 * Node height is the money and must stay exactly proportional. But a R526 charge
 * is a few pixels tall while its label is ~13px, so small charges in sequence
 * produce colliding text. This walks anchors top-down enforcing a minimum pitch,
 * then corrects upward so the run stays inside the canvas.
 */
function spreadLabels(nodes: FlowNode[], minPitch: number, top: number, bottom: number): void {
  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1];
    if (nodes[i].labelY - prev.labelY < minPitch) nodes[i].labelY = prev.labelY + minPitch;
  }
  const overflow = nodes.length > 0 ? nodes[nodes.length - 1].labelY - bottom : 0;
  if (overflow > 0) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      nodes[i].labelY -= overflow;
      if (i > 0 && nodes[i].labelY - nodes[i - 1].labelY >= minPitch) break;
    }
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].labelY < top) nodes[i].labelY = top;
      if (i > 0 && nodes[i].labelY - nodes[i - 1].labelY < minPitch) {
        nodes[i].labelY = nodes[i - 1].labelY + minPitch;
      }
    }
  }
}

const MIN_ZOOM = 0.45;
const MAX_ZOOM = 3;

/**
 * Sankey of a bill: every charge flowing left→right into the period total.
 *
 * Why this form. The question behind a cost breakdown is "what is my money going
 * to?" — a part-to-whole question about magnitudes differing by orders of
 * magnitude (R17 396 demand beside a R526 surcharge). A Sankey answers it in the
 * geometry: ribbon width IS the amount, so the big costs are obvious without
 * reading a figure, and the flows visibly converge on one total.
 *
 * The diagram lives on its own pannable, zoomable canvas rather than being
 * squeezed into the dialog's width. Cost structures vary — a TOU tariff has
 * three energy bands, a block tariff five — so a fixed viewport would either
 * crush the busy cases or waste space on the simple ones. Giving it its own
 * coordinate space lets the layout breathe at its natural size and lets the
 * reader move to whatever they want to look at.
 *
 * Charges are coloured by category (5 hues, never one per line — past ~7 colour
 * classes adjacent ones blur), with each charge keeping its own ribbon into its
 * category node, so it reads at two depths.
 */
export function BillSankey({
  lines,
  totalCents,
  isDark,
}: {
  lines: BillLine[];
  totalCents: number;
  isDark: boolean;
}) {
  const gradientId = useId();
  const [hovered, setHovered] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  const hue = (g: BillLine["group"]) => (isDark ? SERIES[g].dark : SERIES[g].light);

  const charges = useMemo(() => lines.filter((l) => l.amountCents > 0), [lines]);

  /* ── Layout ───────────────────────────────────────────────────────────────
     Computed in the diagram's OWN coordinate space, at whatever size the data
     needs. The viewport then shows part of it; it is never scaled to fit. */
  const layout = useMemo(() => {
    const order: BillLine["group"][] = [
      "active_energy",
      "demand",
      "reactive_energy",
      "fixed",
      "ancillary",
    ];
    const groups = order
      .map((key) => ({ key, title: GROUP_TITLE[key], lines: charges.filter((l) => l.group === key) }))
      .filter((g) => g.lines.length > 0)
      .map((g) => ({ ...g, amountCents: g.lines.reduce((s, l) => s + l.amountCents, 0) }));

    const PAD_Y = 30;
    // Generous separation: the streams should read as distinct flows with air
    // between them, not as a stacked bar sliced into bands. This is the single
    // biggest difference between a modern flow diagram and a classical Sankey.
    const GAP = 26;
    const LABEL_ROOM = 34;
    const H = Math.max(380, PAD_Y * 2 + LABEL_ROOM + charges.length * 64);
    // Labels live in a gutter to the LEFT of the charge nodes, so text never
    // overlaps a flow and needs no halo to stay readable. Right-aligned against
    // the node, with the amount after it.
    const colChargeW = 10;

    const trackTop = PAD_Y;
    const trackHeight = H - PAD_Y * 2 - LABEL_ROOM;

    const chargeScale = (trackHeight - GAP * Math.max(0, charges.length - 1)) / (totalCents || 1);
    const chargeNodes: FlowNode[] = [];
    let cy = trackTop;
    for (const g of groups) {
      for (const line of g.lines) {
        const height = Math.max(2.5, line.amountCents * chargeScale);
        chargeNodes.push({
          key: line.key,
          label: line.label,
          amountCents: line.amountCents,
          group: g.key,
          y: cy,
          height,
          labelY: cy + height / 2,
        });
        cy += height + GAP;
      }
    }

    const groupScale = (trackHeight - GAP * Math.max(0, groups.length - 1)) / (totalCents || 1);
    const groupNodes: FlowNode[] = [];
    let gy = trackTop;
    for (const g of groups) {
      const height = Math.max(2.5, g.amountCents * groupScale);
      groupNodes.push({
        key: g.key,
        label: g.title,
        amountCents: g.amountCents,
        group: g.key,
        y: gy,
        height,
        labelY: gy + height / 2,
      });
      gy += height + GAP;
    }

    spreadLabels(chargeNodes, 22, trackTop + 6, H - PAD_Y);

    // The label column sizes to its content: a block tariff names charges like
    // "Summer · Block 5: above 3 000 kWh", which a lane sized for "Demand charge"
    // cannot hold. ~6.2px per character approximates 12.5px Inter's advance.
    //
    // The amount is RIGHT-anchored at `amountX`, so its own width grows leftward
    // — the lane has to clear the longest label AND the widest amount, or the two
    // run through each other. Widening the diagram is the right answer rather
    // than clamping: it lives on a pannable canvas, so horizontal room is cheap
    // and a collision is not.
    const longestLabel = chargeNodes.reduce((m, n) => Math.max(m, n.label.length), 0);
    const widestAmount = chargeNodes.reduce(
      (m, n) => Math.max(m, formatRand(n.amountCents).length),
      0,
    );
    const gutter = Math.ceil(longestLabel * 6.2) + 18 + Math.ceil(widestAmount * 6.6);
    const colChargeX = gutter + 16;
    // Amount sits immediately left of the node; the label ends before it.
    const amountX = colChargeX - 10;
    const colGroupX = colChargeX + colChargeW + 330;
    const colTotalX = colGroupX + 300;
    const W = colTotalX + 180;
    spreadLabels(groupNodes, 38, trackTop + 16, H - PAD_Y - 16);

    return {
      W,
      H,
      amountX,
      gutterWidth: gutter,
      widestAmountChars: widestAmount,
      // Streams sit slightly inside their node's height, so even adjacent flows
      // keep a sliver of surface between them at every point along their run.
      ribbonInset: 3,
      groups,
      chargeNodes,
      groupNodes,
      groupScale,
      trackTop,
      trackHeight,
      colCharge: { x: colChargeX, w: colChargeW },
      colGroup: { x: colGroupX, w: 12 },
      colTotal: { x: colTotalX, w: 16 },
    };
  }, [charges, totalCents]);

  /* ── Viewport: pan & zoom ────────────────────────────────────────────────
     The canvas is a window onto the layout above. Translation is in SCREEN px
     and applied outside the scale, so a drag moves the diagram exactly as far as
     the pointer travels at any zoom. */
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Re-fit whenever the shape of the data changes — a different tariff is a
  // different diagram, and keeping the old pan would strand the reader offscreen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refit on data shape, not identity
  useEffect(() => {
    reset();
  }, [layout.H, layout.chargeNodes.length, reset]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  };
  const endDrag = (e: React.PointerEvent) => {
    if (drag.current) (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    drag.current = null;
    setDragging(false);
  };

  // Ctrl/⌘+wheel zooms about the pointer; a plain wheel scrolls the dialog, so
  // the page never feels trapped by the canvas.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setZoom((z) => {
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
        // Keep the point under the cursor fixed while scaling.
        setPan((p) => ({
          x: cx - ((cx - p.x) / z) * next,
          y: cy - ((cy - p.y) / z) * next,
        }));
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  if (charges.length === 0 || totalCents <= 0) return null;

  const { chargeNodes, groupNodes, groups, colCharge, colGroup, colTotal, gutterWidth, widestAmountChars } =
    layout;
  const dim = (key: string, group: string) =>
    hovered !== null && hovered !== key && hovered !== group;

  const btn: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    border: "1px solid var(--sankey-rule)",
    background: "var(--sankey-surface)",
    color: "var(--sankey-ink-muted)",
    borderRadius: 3,
    cursor: "pointer",
    padding: 0,
  };

  return (
    <figure style={{ margin: 0, position: "relative" }}>
      <div
        ref={frameRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          position: "relative",
          height: 460,
          overflow: "hidden",
          background: "var(--sankey-surface)",
          cursor: dragging ? "grabbing" : "grab",
          touchAction: "none",
        }}
      >
        <div
          style={{
            // Translate in screen px, then scale — so a drag tracks the pointer
            // 1:1 regardless of zoom.
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
            width: layout.W,
          }}
        >
          <svg
            viewBox={`0 0 ${layout.W} ${layout.H}`}
            width={layout.W}
            height={layout.H}
            style={{ display: "block" }}
            role="img"
            aria-label={`Cost breakdown flow: ${groups
              .map((g) => `${g.title} ${formatRand(g.amountCents)}`)
              .join(", ")}, totalling ${formatRand(totalCents)}`}
          >
            <defs>
              {groups.map((g) => (
                <linearGradient key={g.key} id={`${gradientId}-${g.key}`} x1="0" x2="1" y1="0" y2="0">
                  {/* Flows fade along their length so crossing ribbons stay
                      individually readable rather than stacking into a slab. */}
                  <stop offset="0%" stopColor={hue(g.key)} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={hue(g.key)} stopOpacity={0.72} />
                </linearGradient>
              ))}
            </defs>

            {/* ── Charge → category ─────────────────────────────────────── */}
            {groups.map((g) => {
              const target = groupNodes.find((n) => n.key === g.key);
              if (!target) return null;
              // Arrivals get the same air as departures: without it the streams
              // separate along their run and then fuse back into a slab at the
              // node, which is the look this is trying to get away from.
              const ARRIVE_GAP = 5;
              const arriveGaps = ARRIVE_GAP * Math.max(0, g.lines.length - 1);
              const arriveScale =
                (Math.max(0, target.height - arriveGaps)) / (g.amountCents || 1);
              let offset = 0;
              return g.lines.map((line) => {
                const src = chargeNodes.find((n) => n.key === line.key);
                if (!src) return null;
                const endT = Math.max(2, line.amountCents * arriveScale);
                const ty = target.y + offset + endT / 2;
                offset += endT + ARRIVE_GAP;
                return (
                  <path
                    key={line.key}
                    d={ribbon(
                      colCharge.x + colCharge.w,
                      src.y + src.height / 2,
                      Math.max(2.5, src.height - layout.ribbonInset),
                      colGroup.x,
                      ty,
                      Math.max(2.5, endT - layout.ribbonInset),
                    )}
                    fill={`url(#${gradientId}-${g.key})`}
                    style={{
                      opacity: dim(line.key, g.key) ? 0.12 : 1,
                      transition: "opacity 160ms ease",
                    }}
                  />
                );
              });
            })}

            {/* ── Category → total ──────────────────────────────────────── */}
            {(() => {
              const ARRIVE_GAP = 6;
              const arriveGaps = ARRIVE_GAP * Math.max(0, groupNodes.length - 1);
              const scale = Math.max(0, layout.trackHeight - arriveGaps) / totalCents;
              let offset = 0;
              return groupNodes.map((n) => {
                const endT = Math.max(2, n.amountCents * scale);
                const ty = layout.trackTop + offset + endT / 2;
                offset += endT + ARRIVE_GAP;
                return (
                  <path
                    key={`to-total-${n.key}`}
                    d={ribbon(
                      colGroup.x + colGroup.w,
                      n.y + n.height / 2,
                      Math.max(2.5, n.height - layout.ribbonInset),
                      colTotal.x,
                      ty,
                      Math.max(2.5, endT - layout.ribbonInset),
                    )}
                    fill={`url(#${gradientId}-${n.key})`}
                    style={{
                      opacity: dim(n.key, n.key) ? 0.12 : 1,
                      transition: "opacity 160ms ease",
                    }}
                  />
                );
              });
            })()}

            {/* ── Charge nodes ──────────────────────────────────────────── */}
            {chargeNodes.map((n) => (
              <g
                key={n.key}
                onMouseEnter={() => setHovered(n.key)}
                onMouseLeave={() => setHovered(null)}
              >
                <rect
                  x={colCharge.x}
                  y={n.y}
                  width={colCharge.w}
                  height={n.height}
                  rx={colCharge.w / 2}
                  fill={hue(n.group)}
                  style={{ opacity: dim(n.key, n.group) ? 0.3 : 1, transition: "opacity 160ms ease" }}
                />
                {Math.abs(n.labelY - (n.y + n.height / 2)) > 1.5 ? (
                  <path
                    d={`M ${colCharge.x - 2} ${n.y + n.height / 2} L ${colCharge.x - 7} ${n.labelY}`}
                    stroke={hue(n.group)}
                    strokeWidth={1}
                    fill="none"
                    style={{ opacity: dim(n.key, n.group) ? 0.2 : 0.6 }}
                  />
                ) : null}
                <rect
                  x={colCharge.x - gutterWidth}
                  y={n.y - 5}
                  width={colGroup.x - colCharge.x + gutterWidth}
                  height={n.height + 10}
                  fill="transparent"
                />
                <text
                  x={layout.amountX - Math.ceil(widestAmountChars * 6.6) - 12}
                  y={n.labelY}
                  textAnchor="end"
                  dominantBaseline="middle"
                  style={{ fontSize: 12.5, fill: "var(--sankey-ink)" }}
                >
                  {n.label}
                </text>
                <text
                  x={layout.amountX}
                  y={n.labelY}
                  textAnchor="end"
                  dominantBaseline="middle"
                  style={{
                    fontSize: 12,
                    fill: "var(--sankey-ink-muted)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {formatRand(n.amountCents)}
                </text>
              </g>
            ))}

            {/* ── Category nodes ────────────────────────────────────────── */}
            {groupNodes.map((n) => (
              <g
                key={n.key}
                onMouseEnter={() => setHovered(n.key)}
                onMouseLeave={() => setHovered(null)}
              >
                <rect
                  x={colGroup.x}
                  y={n.y}
                  width={colGroup.w}
                  height={n.height}
                  rx={colGroup.w / 2}
                  fill={hue(n.group)}
                  style={{ opacity: dim(n.key, n.key) ? 0.3 : 1, transition: "opacity 160ms ease" }}
                />
                <text
                  x={colGroup.x + colGroup.w + 11}
                  y={n.labelY - 8}
                  dominantBaseline="middle"
                  style={{ fontSize: 13, fontWeight: 600, fill: "var(--sankey-ink)" }}
                >
                  {n.label}
                </text>
                <text
                  x={colGroup.x + colGroup.w + 11}
                  y={n.labelY + 9}
                  dominantBaseline="middle"
                  style={{
                    fontSize: 12,
                    fill: "var(--sankey-ink-muted)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {formatRand(n.amountCents)}
                </text>
              </g>
            ))}

            {/* ── Total ─────────────────────────────────────────────────── */}
            <rect
              x={colTotal.x}
              y={layout.trackTop}
              width={colTotal.w}
              height={layout.trackHeight}
              rx={colTotal.w / 2}
              fill="var(--sankey-total)"
            />
            <text
              x={colTotal.x + colTotal.w + 13}
              y={layout.trackTop + layout.trackHeight / 2 - 11}
              dominantBaseline="middle"
              style={{ fontSize: 12, fill: "var(--sankey-ink-muted)" }}
            >
              Total to date
            </text>
            <text
              x={colTotal.x + colTotal.w + 13}
              y={layout.trackTop + layout.trackHeight / 2 + 11}
              dominantBaseline="middle"
              style={{
                fontSize: 18,
                fontWeight: 700,
                fill: "var(--sankey-ink)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {formatRand(totalCents)}
            </text>
          </svg>
        </div>

        {/* ── Canvas controls ───────────────────────────────────────────── */}
        <div
          style={{ position: "absolute", right: 10, bottom: 10, display: "flex", gap: 4 }}
          // The controls sit on the canvas; a drag started here would pan it.
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            style={btn}
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.2))}
            aria-label="Zoom out"
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            style={btn}
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.2))}
            aria-label="Zoom in"
          >
            <Plus size={14} />
          </button>
          <button type="button" style={btn} onClick={reset} aria-label="Reset view">
            <Maximize2 size={13} />
          </button>
        </div>
      </div>

      <figcaption
        style={{
          fontSize: 11.5,
          color: "var(--sankey-ink-muted)",
          marginTop: 8,
          lineHeight: 1.5,
        }}
      >
        Ribbon thickness is the amount. Drag to move around the diagram; ⌘/Ctrl + scroll
        to zoom. Hover a charge to trace it through to the total.
      </figcaption>
    </figure>
  );
}
