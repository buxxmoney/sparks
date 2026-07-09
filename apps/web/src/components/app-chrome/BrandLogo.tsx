"use client";

import Image from "next/image";
import { Link } from "@astryxdesign/core/Link";
import sparksMark from "@/assets/sparks-icon.png";

// The Sparks brand lockup in the app chrome: the waveform mark (PNG asset) with
// the wordmark and tagline rendered as HTML text — "Sparks" in Orbitron, the
// tagline in Orbit (both loaded in layout.tsx via next/font). Text beats the
// full-lockup PNG here: it stays crisp at bar height and never ships a 4500px
// bitmap for a 30px slot. Shown in full on every viewport, mobile included.
// Links home so the logo doubles as a "back to sites" affordance.
//
// Fixed row height, matching the two-line text stack's rendered size
// (20px * 1.3 line-height + 2px gap + 10px * 1.3 line-height ≈ 41px). Both the
// compact (icon-only) and full renders are pinned to this height so the
// header bar is the SAME total height in both sidebar states — otherwise the
// icon-only header is shorter than the icon+text header, which shifts the
// header's bottom edge and breaks the fixed-height divider line in Topbar.tsx
// that's meant to run flush into the sidenav's own divider below it.
const LOCKUP_HEIGHT = 41;

// `compact` drops the wordmark/tagline down to the icon alone — used when the
// header's logo cell has shrunk to match a collapsed (icon-only) sidenav.
export function BrandLogo({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/dashboard" aria-label="Sparks — home">
      <span style={{ display: "inline-flex", alignItems: "center", gap: 11, height: LOCKUP_HEIGHT }}>
        <Image src={sparksMark} alt="" priority style={{ height: 32, width: "auto" }} />
        {!compact && (
          <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span
              style={{
                fontFamily: "var(--font-orbitron), var(--font-sans), sans-serif",
                fontWeight: 600,
                fontSize: 20,
                lineHeight: 1.3,
                letterSpacing: "0.03em",
                color: "var(--color-text-primary, #171717)",
              }}
            >
              Sparks
            </span>
            <span
              style={{
                fontFamily: "var(--font-orbit), var(--font-sans), sans-serif",
                fontSize: 10,
                lineHeight: 1.3,
                letterSpacing: "0.05em",
                whiteSpace: "nowrap",
                color: "var(--color-text-secondary, #737373)",
              }}
            >
              Energy Reconcilliation
            </span>
          </span>
        )}
      </span>
    </Link>
  );
}
