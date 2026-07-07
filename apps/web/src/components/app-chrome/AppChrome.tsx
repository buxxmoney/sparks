"use client";

import { AppShell } from "@astryxdesign/core/AppShell";
import { MobileNav } from "@astryxdesign/core/MobileNav";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppSideNav, NavSections } from "./Sidebar";
import { Topbar } from "./Topbar";

// Routes that render bare (no app shell): auth screens + the root redirect.
// These bring their own full-screen layout (AuthShell).
function isBareRoute(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith("/auth") || pathname.startsWith("/invite");
}

function titleFor(pathname: string): string {
  if (pathname === "/dashboard") return "Overview";
  if (pathname === "/admin") return "Operator admin";
  if (/^\/sites\/new$/.test(pathname)) return "New Site";
  if (/\/settings$/.test(pathname)) return "Site Settings";
  if (/^\/sites\/[^/]+$/.test(pathname)) return "Site Dashboard";
  if (/\/invoices\/[^/]+$/.test(pathname)) return "Invoice";
  if (/\/invoices$/.test(pathname)) return "Invoices";
  if (/\/reconciliation\/[^/]+$/.test(pathname)) return "Reconciliation";
  if (/\/reconciliation$/.test(pathname)) return "Reconciliations";
  return "Sparks";
}

export function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/";

  // Auth screens and the root redirect render bare (they bring their own
  // full-screen AuthShell layout).
  if (isBareRoute(pathname)) {
    return <>{children}</>;
  }

  return (
    <AppShell
      topNav={<Topbar title={titleFor(pathname)} />}
      sideNav={<AppSideNav />}
      mobileNav={
        <MobileNav header="Sparks">
          <NavSections />
        </MobileNav>
      }
      contentPadding={4}
      height="fill"
    >
      {/* Center page content and cap its width so wide viewports don't leave
          all the whitespace on the right. Pages fill this container. */}
      <div style={{ width: "100%", maxWidth: 1160, marginInline: "auto" }}>{children}</div>
    </AppShell>
  );
}
