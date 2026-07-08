import { getDb, member, siteAccess, sites, user } from "@sparks/db";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { auth } from "./auth";

// Layered authorization for the oRPC surface (docs/02 §4.1):
//   requireSession → requireOrg → requireSiteAccess(role?) → requirePlatformOperator
// requireSession runs once per request when the auth context is built (index.ts);
// the remaining guards are invoked per-procedure with their target id.

export interface AuthContext {
  userId: string;
  sessionId: string;
  organizationId: string;
  // Raw request headers, when the context was built from a real HTTP request.
  // Carried so owner-guarded org.* procedures can call the better-auth org APIs
  // with the caller's session. Absent in unit tests that build a context inline.
  headers?: Headers;
}

export interface SiteAccessContext extends AuthContext {
  siteId: string;
  /** The caller's effective level on this site (org owners = "org_owner"). */
  level: EffectiveLevel;
}

export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * A precondition for the operation isn't met (e.g. no invoice/tariff for the
 * period, entity not found). Surfaced to the client with its message (unlike an
 * unexpected error, which is sanitized to a generic 500).
 */
export class PreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreconditionError";
  }
}

/**
 * Layer 1 — requireSession. Establishes (userId, sessionId, selected org) from a
 * REAL better-auth session cookie. There is no spoofable identity fallback: the
 * old x-user-id/x-session-id header shim is honored ONLY under NODE_ENV==='test'
 * (unit tests that cannot mint a cookie). The selected organization travels as
 * x-organization-id and is validated against the user's membership here, so a
 * caller can never operate inside an org they do not belong to.
 */
export async function requireSession(c: Context): Promise<AuthContext> {
  let session: { user?: { id: string }; session?: { id: string } } | null = null;
  try {
    session = await auth.api.getSession({ headers: c.req.raw.headers });
  } catch {
    session = null;
  }

  const organizationId = c.req.header("x-organization-id") || "";

  if (session?.user) {
    // The selected org travels in a client header (from localStorage). If it's stale
    // or belongs to another account — e.g. a different user signs in on the same
    // browser — DON'T brick the whole session with a 403. Degrade to "no org
    // selected" so discovery endpoints (session.listMemberships, session.me) still
    // work and the user can pick a valid org. Org-scoped procedures stay safe: they
    // fail closed via requireOrg / requireSiteAccess (an empty org matches nothing).
    const validOrg =
      organizationId && (await hasMembership(session.user.id, organizationId))
        ? organizationId
        : "";
    return {
      userId: session.user.id,
      sessionId: session.session?.id || "",
      organizationId: validOrg,
      headers: c.req.raw.headers,
    };
  }

  // Test-only shim: allow explicit identity headers so unit/integration tests can
  // exercise procedures without a browser session. NEVER available in prod/dev.
  if (process.env.NODE_ENV === "test") {
    const userId = c.req.header("x-user-id");
    const sessionId = c.req.header("x-session-id");
    if (userId && sessionId) {
      return { userId, sessionId, organizationId, headers: c.req.raw.headers };
    }
  }

  throw new UnauthorizedError("Missing or invalid session");
}

/** True if the user is a better-auth `member` of the organization. */
async function hasMembership(userId: string, organizationId: string): Promise<boolean> {
  const db = getDb();
  const membership = await db.query.member.findFirst({
    where: and(eq(member.userId, userId), eq(member.organizationId, organizationId)),
  });
  return Boolean(membership);
}

/** True if the user is an org-level `owner` (better-auth member role). */
export async function isOrgOwner(ctx: AuthContext): Promise<boolean> {
  if (!ctx.organizationId) return false;
  const db = getDb();
  const ownerMember = await db.query.member.findFirst({
    where: and(
      eq(member.userId, ctx.userId),
      eq(member.organizationId, ctx.organizationId),
      eq(member.role, "owner"),
    ),
  });
  return Boolean(ownerMember);
}

/**
 * Layer 2 — requireOrg. Confirms the procedure's target organization matches the
 * caller's session-validated org context. (Membership itself is validated when the
 * context is built — see requireSession — so this is the per-procedure tenant guard.)
 */
export async function requireOrg(authContext: AuthContext, expectedOrgId?: string): Promise<void> {
  if (expectedOrgId && authContext.organizationId !== expectedOrgId) {
    throw new ForbiddenError("Organization mismatch");
  }
}

/** Owner-only org guard: caller must be an org `owner` of the target org. */
export async function requireOrgOwner(
  authContext: AuthContext,
  expectedOrgId?: string,
): Promise<void> {
  await requireOrg(authContext, expectedOrgId);
  if (!(await isOrgOwner(authContext))) {
    throw new ForbiddenError("Organization owner access required");
  }
}

// Per-site access levels, lowest → highest. Org owners sit above all of these.
export type SiteLevel = "viewer" | "editor" | "site_admin";
export type EffectiveLevel = SiteLevel | "org_owner";

const LEVEL_RANK: Record<EffectiveLevel, number> = {
  viewer: 1,
  editor: 2,
  site_admin: 3,
  org_owner: 4,
};

// Normalise a stored site_access.role into a canonical level, mapping the legacy
// values (owner → site_admin, site_manager → editor) so old grants keep working.
export function normalizeSiteLevel(role: string | null | undefined): SiteLevel {
  switch (role) {
    case "site_admin":
    case "owner": // legacy
      return "site_admin";
    case "editor":
    case "site_manager": // legacy
      return "editor";
    default:
      return "viewer";
  }
}

export function meetsLevel(actual: EffectiveLevel, required: SiteLevel): boolean {
  return LEVEL_RANK[actual] >= LEVEL_RANK[required];
}

export interface RequireSiteAccessOptions {
  /** Minimum level the caller must hold on the site (default: any access). */
  minLevel?: SiteLevel;
}

/**
 * Layer 3 — requireSiteAccess. Grants access to a site when EITHER:
 *   (a) the caller is an org `owner` (owners reach every site in their org at the
 *       highest effective level), OR
 *   (b) the caller has an explicit `site_access` grant whose level meets `minLevel`.
 * The site must belong to the caller's org. Returns the caller's effective level.
 */
export async function requireSiteAccess(
  authContext: AuthContext,
  siteId: string,
  options?: RequireSiteAccessOptions,
): Promise<SiteAccessContext> {
  const db = getDb();

  const site = await db.query.sites.findFirst({
    where: eq(sites.id, siteId),
  });

  if (!site) {
    throw new UnauthorizedError("Site not found");
  }

  if (site.organizationId !== authContext.organizationId) {
    throw new ForbiddenError("Site belongs to different organization");
  }

  // (a) Org owners reach all sites in their org at the top level.
  if (await isOrgOwner(authContext)) {
    return { ...authContext, siteId, level: "org_owner" };
  }

  // (b) Explicit per-site grant.
  const access = await db.query.siteAccess.findFirst({
    where: and(eq(siteAccess.siteId, siteId), eq(siteAccess.userId, authContext.userId)),
  });

  if (!access) {
    throw new ForbiddenError("No access to site");
  }

  const level = normalizeSiteLevel(access.role);
  if (options?.minLevel && !meetsLevel(level, options.minLevel)) {
    throw new ForbiddenError(
      `This action needs ${options.minLevel.replace("_", " ")} access to the site.`,
    );
  }

  return { ...authContext, siteId, level };
}

/** Editor-or-above: can act on the site (upload, reconcile, download, reply). */
export function requireSiteEditor(authContext: AuthContext, siteId: string) {
  return requireSiteAccess(authContext, siteId, { minLevel: "editor" });
}

/** Site-admin-or-above (incl. org owner): can manage the site's access grants. */
export function requireSiteAdmin(authContext: AuthContext, siteId: string) {
  return requireSiteAccess(authContext, siteId, { minLevel: "site_admin" });
}

/**
 * Layer 4 — requirePlatformOperator. Cross-tenant admin gate for `fleet.*` and
 * tariff-library writes. Reads the global `isPlatformOperator` flag from the
 * better-auth user row.
 */
export async function requirePlatformOperator(userId: string): Promise<void> {
  const db = getDb();
  const row = await db.query.user.findFirst({
    where: eq(user.id, userId),
    columns: { isPlatformOperator: true },
  });

  if (!row?.isPlatformOperator) {
    throw new ForbiddenError("Platform operator access required");
  }
}
