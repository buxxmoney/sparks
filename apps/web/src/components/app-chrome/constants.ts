// Shared between Topbar and Sidebar so the header's logo cell can be sized to
// match the sidenav exactly — same hairline, same pixel widths — which is what
// makes the vertical divider between them read as one continuous line instead
// of two misaligned ones. Widths mirror @astryxdesign/core's SideNav defaults
// (260px expanded; --spacing-12 = 48px collapsed).
export const HAIRLINE = "1px solid var(--color-border, #ebebeb)";
export const SIDENAV_WIDTH = 260;
export const SIDENAV_WIDTH_COLLAPSED = 48;
