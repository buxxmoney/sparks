"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Theme, MediaTheme } from "@astryxdesign/core/theme";
import { LinkProvider } from "@astryxdesign/core/Link";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

// Astryx theme + Next.js Link integration. Wraps the whole app so every Astryx
// component renders with the neutral theme tokens and routes through next/link.
// MediaTheme mode="light" pins light mode so Astryx's light-dark() tokens match
// the light app background (until we adopt a full dark-mode toggle).
export function Providers({ children }: { children: ReactNode }) {
  return (
    <Theme theme={neutralTheme}>
      <MediaTheme mode="light">
        <LinkProvider component={Link}>{children}</LinkProvider>
      </MediaTheme>
    </Theme>
  );
}
