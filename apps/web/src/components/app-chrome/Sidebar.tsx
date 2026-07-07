"use client";

import { usePathname } from "next/navigation";
import {
  SideNav,
  SideNavHeading,
  SideNavSection,
  SideNavItem,
} from "@astryxdesign/core/SideNav";
import { Badge } from "@astryxdesign/core/Badge";
import {
  LayoutDashboard,
  Bell,
  Building,
  Gauge,
  FileText,
  Scale,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { client } from "@/lib/client";
import { useOrganization } from "@/lib/useOrganization";
import { useRPC } from "@/lib/useRPC";

// Derive the active site id from the URL. "new" is the create-site route, not a
// site id, so it must not surface the per-site sub-nav.
function useNavContext() {
  const pathname = usePathname() || "/";
  const match = pathname.match(/^\/sites\/([^/]+)/);
  const siteId = match && match[1] !== "new" ? match[1] : undefined;
  return { pathname, siteId };
}

const ICON_SIZE = 18;

// Shared navigation body rendered inside BOTH the desktop SideNav and the
// mobile drawer (MobileNav accepts the same SideNavSection/SideNavItem children),
// so the two stay in sync from one source.
export function NavSections() {
  const { pathname, siteId } = useNavContext();
  const { isPlatformOperator, isOrgOwner } = useOrganization();
  const { data: unread } = useRPC(() => client.alerts.unreadCount(), []);
  const unreadCount = unread?.count ?? 0;

  return (
    <>
      <SideNavSection title="Platform">
        <SideNavItem
          label="Overview"
          icon={<LayoutDashboard size={ICON_SIZE} />}
          href="/dashboard"
          isSelected={pathname === "/dashboard"}
        />
        {isOrgOwner ? (
          <SideNavItem
            label="Organization"
            icon={<Building size={ICON_SIZE} />}
            href="/organization"
            isSelected={pathname === "/organization"}
          />
        ) : null}
        {isPlatformOperator ? (
          <SideNavItem
            label="Operator admin"
            icon={<ShieldCheck size={ICON_SIZE} />}
            href="/admin"
            isSelected={pathname === "/admin"}
          />
        ) : null}
        <SideNavItem
          label="Alerts"
          icon={<Bell size={ICON_SIZE} />}
          href="/alerts"
          isSelected={pathname === "/alerts"}
          endContent={
            unreadCount > 0 ? <Badge variant="warning" label={String(unreadCount)} /> : undefined
          }
        />
      </SideNavSection>

      {siteId ? (
        <SideNavSection title="Current site">
          <SideNavItem
            label="Live dashboard"
            icon={<Gauge size={ICON_SIZE} />}
            href={`/sites/${siteId}`}
            isSelected={pathname === `/sites/${siteId}`}
          />
          <SideNavItem
            label="Invoices"
            icon={<FileText size={ICON_SIZE} />}
            href={`/sites/${siteId}/invoices`}
            isSelected={pathname.startsWith(`/sites/${siteId}/invoices`)}
          />
          <SideNavItem
            label="Reconciliations"
            icon={<Scale size={ICON_SIZE} />}
            href={`/sites/${siteId}/reconciliation`}
            isSelected={pathname.startsWith(`/sites/${siteId}/reconciliation`)}
          />
          <SideNavItem
            label="Settings"
            icon={<Settings size={ICON_SIZE} />}
            href={`/sites/${siteId}/settings`}
            isSelected={pathname.endsWith("/settings")}
          />
        </SideNavSection>
      ) : null}
    </>
  );
}

// Persistent desktop sidebar.
export function AppSideNav() {
  return (
    <SideNav
      header={
        <SideNavHeading
          icon={<Logo size={22} />}
          heading="Sparks"
          subheading="Energy Reconciliation"
          headingHref="/dashboard"
        />
      }
    >
      <NavSections />
    </SideNav>
  );
}
