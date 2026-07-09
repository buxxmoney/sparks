"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LogOut, User as UserIcon } from "lucide-react";
import { TopNav } from "@astryxdesign/core/TopNav";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { useSession } from "@/lib/useSession";
import { useRPC } from "@/lib/useRPC";
import { useOrganization } from "@/lib/useOrganization";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { client } from "@/lib/client";
import { signOut } from "@/lib/api";
import { BrandLogo } from "./BrandLogo";
import { SIDENAV_WIDTH, SIDENAV_WIDTH_COLLAPSED } from "./constants";

// The header's own row only occupies its content height (~32px) inside 8px of
// padding — nested flex wrappers with no explicit height of their own, so a
// border on the in-flow logo cell can't be bled out to reach the true y=0..48
// span of the bar (tried it: margin bleed only propagated partway through the
// unstyled ancestor chain). A viewport-fixed line, portaled to <body>, sidesteps
// that entirely and always lands at the real header edges regardless of the
// slot's internal layout.
// Measured with BrandLogo's LOCKUP_HEIGHT pinned so this is identical whether
// the sidenav is collapsed (icon-only) or expanded (icon+text) — before that
// fix the icon-only header was shorter, so this constant was only ever right
// for one of the two states and the divider fell short in the other.
const HEADER_HEIGHT = 58.5; // measured: where the sidenav's own right divider begins
// TopNav pads its whole row by 8px on every side (--spacing-2), so the logo
// cell's natural flow position starts at x=8, not x=0 — 8px short of the
// sidenav's actual left edge. Bleed it out with a matching negative margin so
// the cell's content area — and the icon centered within it — lines up with
// the divider (x=cellWidth) and the sidenav below it, instead of sitting
// noticeably off-center inside a box that's secretly 8px too far right.
const TOPNAV_PADDING = 8;

export function Topbar({ isSidebarCollapsed }: { isSidebarCollapsed: boolean }) {
  const { session } = useSession();
  const { organizationId } = useOrganization();
  const { data: memberships } = useRPC(() => client.session.listMemberships(), []);
  // Below the shell's `md` breakpoint the top bar is the only chrome and the
  // sidenav becomes a drawer (no persistent column to align with), so the
  // logo reverts to plain unboxed spacing and the box divider is skipped.
  const isCompact = useMediaQuery("(max-width: 768px)");
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const org = memberships?.find((m) => m.organizationId === organizationId);
  const email = session?.user?.email ?? "";
  // Name reads friendlier in the corner than an email address; fall back to
  // email for accounts that haven't set one (e.g. mid-invite).
  const name = session?.user?.name || email || "Account";
  // The org identity lives in the sidebar footer; the account menu repeats it
  // so it's still discoverable from the top bar.
  const orgName = org?.organizationName ?? "Organization";

  const handleSignOut = async () => {
    await signOut();
    // Hard navigation (not router.push): a full page load discards ALL cached
    // client state — the session (email shown here), the selected org, and every
    // useRPC result — so the app can't keep showing a signed-out user's identity
    // or data. A soft SPA nav left this component mounted with stale state.
    window.location.href = "/auth/login";
  };

  const cellWidth = isSidebarCollapsed ? SIDENAV_WIDTH_COLLAPSED : SIDENAV_WIDTH;

  return (
    <>
      <TopNav
        label="Top bar"
        // The brand logo lives in the `heading` slot (not `startContent`) because
        // TopNav's mobile-bar mode only renders `heading` + `endContent` — so this
        // is what keeps the logo top-left on mobile as well as desktop.
        heading={
          isCompact ? (
            <BrandLogo />
          ) : (
            <div
              style={{
                width: cellWidth,
                flexShrink: 0,
                marginInlineStart: -TOPNAV_PADDING,
                display: "flex",
                alignItems: "center",
                justifyContent: isSidebarCollapsed ? "center" : "flex-start",
                paddingInlineStart: isSidebarCollapsed ? 0 : 20,
              }}
            >
              <BrandLogo compact={isSidebarCollapsed} />
            </div>
          )
        }
        endContent={
          <DropdownMenu
            button={
              isCompact
                ? {
                    label: name,
                    icon: <UserIcon size={18} />,
                    isIconOnly: true,
                    variant: "ghost",
                  }
                : { label: name, variant: "ghost" }
            }
            items={[
              {
                type: "section",
                title: `${name} · ${orgName}`,
                // Email moved off the visible button; kept here so it's still
                // reachable, since it's still the account's login identity.
                items: [{ label: email || "No email on file", icon: UserIcon, isDisabled: true }],
              },
              { type: "divider" },
              { label: "Sign out", icon: LogOut, onClick: handleSignOut },
            ]}
          />
        }
      />
      {!isCompact &&
        mounted &&
        createPortal(
          <div
            aria-hidden
            style={{
              position: "fixed",
              top: 0,
              left: cellWidth,
              width: 1,
              height: HEADER_HEIGHT,
              background: "var(--color-border, #ebebeb)",
              pointerEvents: "none",
              zIndex: 40,
            }}
          />,
          document.body,
        )}
    </>
  );
}
