"use client";

import { AppShell } from "@astryxdesign/core/AppShell";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { AppSideNav } from "./Sidebar";
import { Topbar } from "./Topbar";

// Routes that render bare (no app shell): auth screens + the root redirect.
// These bring their own full-screen layout (AuthShell).
function isBareRoute(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith("/auth") || pathname.startsWith("/invite");
}

export function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/";
  // Lifted (not left uncontrolled inside SideNav) so Topbar can size the
  // header's logo cell to match — see Sidebar.tsx's AppSideNav comment.
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  // Auth screens and the root redirect render bare (they bring their own
  // full-screen AuthShell layout).
  if (isBareRoute(pathname)) {
    return <>{children}</>;
  }

  return (
    <AppShell
      topNav={<Topbar isSidebarCollapsed={isSidebarCollapsed} />}
      sideNav={
        <AppSideNav isCollapsed={isSidebarCollapsed} onCollapsedChange={setIsSidebarCollapsed} />
      }
      // Config form (not a <MobileNav> element!) — passing an element disables
      // AppShell's built-in drawer wiring entirely, which left mobile with no
      // hamburger and no way to navigate. With the config form the shell
      // transports the sideNav content into its own drawer below `md` and
      // injects the toggle into the top bar.
      mobileNav={{ breakpoint: "md" }}
      // "section" draws hairline dividers between the nav areas and the
      // content — a full-width line under the top bar and a full-height line
      // beside the sidebar, which frame the Sparks logo in the top-left corner.
      variant="section"
      contentPadding={4}
      height="fill"
    >
      {/* Center page content and cap its width so wide viewports don't leave
          all the whitespace on the right. Pages fill this container; the
          footer sits below them, pushed to the viewport bottom on short pages. */}
      <div
        style={{
          width: "100%",
          maxWidth: 1160,
          marginInline: "auto",
          minHeight: "100%",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ flexGrow: 1 }}>{children}</div>
        <footer
          style={{
            marginTop: 40,
            borderTop: "1px solid var(--color-border, #ebebeb)",
            paddingBlock: 16,
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--color-text-secondary, #737373)",
          }}
        >
          <span>© 2026 Sparks Metering (Pty) Ltd. All rights reserved.</span>
          <span>Live metering &amp; billing reconciliation</span>
        </footer>
      </div>
    </AppShell>
  );
}
