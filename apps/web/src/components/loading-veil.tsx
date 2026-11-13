"use client";

import { Spinner } from "@astryxdesign/core/Spinner";
import type { ReactNode } from "react";

/**
 * Shows that the content underneath is being replaced.
 *
 * Used where a control swaps what a card displays (a different billing period, a
 * different chart range) and the answer takes a moment: the previous content stays
 * in place, dimmed, with a spinner over it. Without this the old figures sit there
 * unchanged after the click, and there is no way to tell a slow load from a hang.
 *
 * Keeping the old content mounted (rather than swapping in a skeleton) holds the
 * card at its size, so the page does not jump while waiting.
 */
export function LoadingVeil({
  active,
  label = "Loading…",
  children,
}: {
  active: boolean;
  label?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ position: "relative" }} aria-busy={active}>
      <div
        style={{
          opacity: active ? 0.35 : 1,
          pointerEvents: active ? "none" : undefined,
          transition: "opacity 120ms ease",
        }}
      >
        {children}
      </div>
      {active ? (
        <div
          role="status"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            fontSize: 14,
          }}
        >
          <Spinner size="md" aria-label={label} />
          <span>{label}</span>
        </div>
      ) : null}
    </div>
  );
}
