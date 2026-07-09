"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  SideNav,
  SideNavSection,
  SideNavItem,
  useSideNavCollapse,
} from "@astryxdesign/core/SideNav";
import { Badge } from "@astryxdesign/core/Badge";
import {
  LayoutDashboard,
  Bell,
  Building,
  Building2,
  Gauge,
  FileText,
  Scale,
  Settings,
  ShieldCheck,
} from "lucide-react";

import { client } from "@/lib/client";
import { useOrganization } from "@/lib/useOrganization";
import { useRPC } from "@/lib/useRPC";
import { HAIRLINE } from "./constants";

// Derive the active site id from the URL. "new" is the create-site route, not a
// site id, so it must not surface the per-site sub-nav.
function useNavContext() {
  const pathname = usePathname() || "/";
  const match = pathname.match(/^\/sites\/([^/]+)/);
  const siteId = match && match[1] !== "new" ? match[1] : undefined;
  return { pathname, siteId };
}

const ICON_SIZE = 18;

// Navigation body of the SideNav. On mobile, AppShell transports the whole
// SideNav (this included) into its drawer automatically — one source of truth
// for both. Kept as its own component so sections stay readable.
function NavSections() {
  const { pathname, siteId } = useNavContext();
  const { isPlatformOperator, isOrgOwner } = useOrganization();
  // The sidebar persists across client navigation, so a one-shot fetch goes stale as
  // alerts arrive or are read. Poll so the unread badge stays current.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 20_000);
    return () => clearInterval(id);
  }, []);
  const { data: unread } = useRPC(() => client.alerts.unreadCount(), [tick]);
  const unreadCount = unread?.count ?? 0;

  return (
    <>
      <SideNavSection title="Platform">
        <SideNavItem
          label="Sites"
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

// Sticky sidebar footer: the active organization in a square-cornered box,
// with the copyright line under a hairline that matches the shell dividers.
// Both collapse gracefully when the sidebar is in icon-only mode.
function OrgFooter() {
  const { isCollapsed } = useSideNavCollapse();
  const { organizationId, orgRole } = useOrganization();
  const { data: memberships } = useRPC(() => client.session.listMemberships(), []);
  const org = memberships?.find((m) => m.organizationId === organizationId);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          border: HAIRLINE,
          borderRadius: "var(--radius-inner, 4px)",
          padding: isCollapsed ? 6 : "8px 10px",
          justifyContent: isCollapsed ? "center" : "flex-start",
        }}
        title={org?.organizationName}
      >
        <span
          style={{
            display: "inline-flex",
            width: 26,
            height: 26,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "var(--radius-inner, 4px)",
            background: "var(--color-accent, #262626)",
            color: "var(--color-on-accent, #ffffff)",
            flexShrink: 0,
          }}
        >
          <Building2 size={14} />
        </span>
        {!isCollapsed && (
          <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {org?.organizationName ?? "Organization"}
            </span>
            {orgRole ? (
              <span style={{ fontSize: 11, color: "var(--color-text-secondary, #737373)" }}>
                {orgRole.charAt(0).toUpperCase() + orgRole.slice(1)}
              </span>
            ) : null}
          </span>
        )}
      </div>
      {!isCollapsed && (
        <div
          style={{
            borderTop: HAIRLINE,
            paddingTop: 8,
            fontSize: 11,
            color: "var(--color-text-secondary, #737373)",
            whiteSpace: "nowrap",
          }}
        >
          © Sparks Metering 2026
        </div>
      )}
    </div>
  );
}

// Persistent desktop sidebar. Collapse state is controlled from AppChrome
// (rather than left uncontrolled here) so the header's logo cell in Topbar can
// read the same boolean and size itself to match — that's what keeps the
// vertical divider between header-logo and sidenav continuous at any width.
export function AppSideNav({
  isCollapsed,
  onCollapsedChange,
}: {
  isCollapsed: boolean;
  onCollapsedChange: (isCollapsed: boolean) => void;
}) {
  return (
    <SideNav
      collapsible={{ isCollapsed, onCollapsedChange }}
      footer={<OrgFooter />}
    >
      <NavSections />
    </SideNav>
  );
}
