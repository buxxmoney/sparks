"use client";

import { MobileNav } from "@astryxdesign/core/MobileNav";
import type { ReactNode } from "react";

/**
 * Right-hand slide-out settings panel.
 *
 * Settings are an aside, not a destination: opening them shouldn't tear the operator
 * away from the live dashboard they're reading, and an inline block shoved between the
 * header and the cards pushed that whole dashboard down the page every time it opened.
 * A drawer leaves the page where it was and closes back onto it.
 *
 * Built on the design system's `MobileNav` — despite the name it is simply the system's
 * slide-out drawer (native `<dialog>` + `showModal()`), which buys the browser's own top
 * layer, backdrop, focus trap, body scroll lock and Escape handling rather than a
 * hand-rolled overlay. `side="end"` is the right edge in LTR. AppShell keeps its own
 * instance for mobile navigation; this one is fully controlled and independent of it.
 */
export function SettingsDrawer({
  isOpen,
  onOpenChange,
  title,
  children,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <MobileNav
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      side="end"
      // Wide enough for the settings cards' own fields at their natural width; the
      // drawer caps itself at the viewport, so it becomes near-full-width on a phone.
      width={440}
      header={title}
      label={title}
    >
      {children}
    </MobileNav>
  );
}
