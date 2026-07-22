import { getDb, member, siteAccess, sites, user } from "@sparks/db";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { auth } from "./auth";
import { TtlCache } from "./cache";

// A single page load fans one auth check out across ~6 RPCs, each re-querying the
// same membership / owner / site-access rows. Cache those lookups for a few seconds
// (single-flight collapses the parallel burst to one DB round trip). Bounded
// staleness: a permission change lags by at most AUTHZ_TTL unless a write explicitly
// invalidates it (see the invalidate* helpers, called from the mutating procedures).
const AUTHZ_TTL = 15_000;
const authzCache = new TtlCache<boolean | string | null>();

const memoBool = (key: string, loader: () => Promise<boolean>): Promise<boolean> =>
  authzCache.memo(key, AUTHZ_TTL, loader) as Promise<boolean>;
const memoStr = (key: string, loader: () => Promise<string | null>): Promise<string | null> =>
  authzCache.memo(key, AUTHZ_TTL, loader) as Promise<string | null>;

/** Invalidation surface for the write paths. Keep in sync with the key formats below. */
export function invalidateSiteAccessCache(siteId: string, userId: string): void {
  authzCache.delete(`access:${siteId}:${userId}`);
}
export function invalidateSiteCache(siteId: string): void {
  authzCache.delete(`siteorg:${siteId}`);
  authzCache.deletePrefix(`access:${siteId}:`);
}
export function invalidateMembershipCache(userId: string): void {
  authzCache.delete(`firstorg:${userId}`);
  authzCache.deletePrefix(`member:${userId}:`);
  authzCache.deletePrefix(`owner:${userId}:`);
}
export function invalidateOperatorCache(userId: string): void {
  authzCache.delete(`op:${userId}`);
}

// The site's org id (or null when the site doesn't exist) — the only field the
// authz check needs, cached by siteId.
function cachedSiteOrgId(siteId: string): Promise<string | null> {
  return memoStr(`siteorg:${siteId}`, async () => {
    const s = await getDb().query.sites.findFirst({
      where: eq(sites.id, siteId),
      columns: { organizationId: true },
    });
    return s?.organizationId ?? null;
  });
}

// A user's per-site access role (or null when there's no grant), cached by pair.
function cachedSiteAccessRole(siteId: string, userId: string): Promise<string | null> {
  return memoStr(`access:${siteId}:${userId}`, async () => {
    const a = await getDb().query.siteAccess.findFirst({
      where: and(eq(siteAccess.siteId, siteId), eq(siteAccess.userId, userId)),
    });
    return a?.role ?? null;
  });
}

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

  const headerOrg = c.req.header("x-organization-id") || "";

  if (session?.user) {
    // The selected org travels in a client header (from localStorage). Resolve the
    // effective org: honour an explicitly-selected org the user actually belongs to;
    // otherwise (missing, stale, or another account's org left in localStorage) fall
    // back to the user's OWN first membership — the SAME fallback session.me uses.
    //
    // Why fall back instead of "": the client also derives an organizationId from
    // session.me and passes it in request bodies. If the header resolved to "" while
    // the body said the user's real org, requireOrg would raise "Organization
    // mismatch" and strand a perfectly valid user. Resolving both the same way keeps
    // them in agreement. The fallback only ever selects an org the user is a member
    // of, so it can't grant access to anyone else's data.
    const organizationId =
      headerOrg && (await hasMembership(session.user.id, headerOrg))
        ? headerOrg
        : await firstMembershipOrg(session.user.id);
    return {
      userId: session.user.id,
      sessionId: session.session?.id || "",
      organizationId,
      headers: c.req.raw.headers,
    };
  }

  // Test-only shim: allow explicit identity headers so unit/integration tests can
  // exercise procedures without a browser session. NEVER available in prod/dev.
  if (process.env.NODE_ENV === "test") {
    const userId = c.req.header("x-user-id");
    const sessionId = c.req.header("x-session-id");
    if (userId && sessionId) {
      return { userId, sessionId, organizationId: headerOrg, headers: c.req.raw.headers };
    }
  }

  throw new UnauthorizedError("Missing or invalid session");
}

/** True if the user is a better-auth `member` of the organization. */
async function hasMembership(userId: string, organizationId: string): Promise<boolean> {
  return memoBool(`member:${userId}:${organizationId}`, async () => {
    const membership = await getDb().query.member.findFirst({
      where: and(eq(member.userId, userId), eq(member.organizationId, organizationId)),
    });
    return Boolean(membership);
  });
}

/**
 * The user's default org: their earliest membership (deterministic, by createdAt).
 * MUST match the fallback order session.me uses, so the org resolved when building
 * the request context agrees with the organizationId the client derives from
 * session.me — otherwise requireOrg would see a mismatch. Returns "" if none.
 */
async function firstMembershipOrg(userId: string): Promise<string> {
  const org = await memoStr(`firstorg:${userId}`, async () => {
    const membership = await getDb().query.member.findFirst({
      where: eq(member.userId, userId),
      orderBy: (m, { asc }) => [asc(m.createdAt), asc(m.id)],
    });
    // "" (not null) so the value is cacheable and distinct from a cache miss.
    return membership?.organizationId ?? "";
  });
  return org ?? "";
}

/** True if the user is an org-level `owner` (better-auth member role). */
export async function isOrgOwner(ctx: AuthContext): Promise<boolean> {
  if (!ctx.organizationId) return false;
  return memoBool(`owner:${ctx.userId}:${ctx.organizationId}`, async () => {
    const ownerMember = await getDb().query.member.findFirst({
      where: and(
        eq(member.userId, ctx.userId),
        eq(member.organizationId, ctx.organizationId),
        eq(member.role, "owner"),
      ),
    });
    return Boolean(ownerMember);
  });
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
// "operator" = a Sparks platform operator viewing a customer site cross-tenant.
// It ranks below viewer for WRITES (meetsLevel(operator, editor) is false), so
// operators are strictly read-only on customer sites; they mutate only through the
// dedicated operator admin endpoints. It still satisfies "any access" reads.
export type EffectiveLevel = SiteLevel | "org_owner" | "operator";

const LEVEL_RANK: Record<EffectiveLevel, number> = {
  operator: 0,
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
  const siteOrgId = await cachedSiteOrgId(siteId);

  if (siteOrgId === null) {
    throw new UnauthorizedError("Site not found");
  }

  if (siteOrgId !== authContext.organizationId) {
    // Cross-tenant: allowed only for Sparks platform operators, and READ-ONLY.
    // The "operator" level ranks below editor, so write gates (requireSiteEditor/
    // Admin) still reject it — operators mutate customer data only through the
    // dedicated admin endpoints. (Checked here, so a normal customer accessing
    // their own site never pays for the extra lookup.)
    if (await isPlatformOperator(authContext.userId)) {
      if (options?.minLevel && !meetsLevel("operator", options.minLevel)) {
        throw new ForbiddenError("Operators have read-only access to customer sites.");
      }
      return { ...authContext, siteId, level: "operator" };
    }
    throw new ForbiddenError("Site belongs to different organization");
  }

  // (a) Org owners reach all sites in their org at the top level.
  if (await isOrgOwner(authContext)) {
    return { ...authContext, siteId, level: "org_owner" };
  }

  // (b) Explicit per-site grant.
  const role = await cachedSiteAccessRole(siteId, authContext.userId);

  if (role === null) {
    throw new ForbiddenError("No access to site");
  }

  const level = normalizeSiteLevel(role);
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
  if (!(await isPlatformOperator(userId))) {
    throw new ForbiddenError("Platform operator access required");
  }
}

/** True when the user carries the platform-operator flag. Non-throwing companion
 * to requirePlatformOperator, used to grant operators cross-tenant read access.
 * Cached (rarely changes); set via the make-operator script, so a fresh flag lags
 * by at most AUTHZ_TTL in a running process. */
export async function isPlatformOperator(userId: string): Promise<boolean> {
  return memoBool(`op:${userId}`, async () => {
    const row = await getDb().query.user.findFirst({
      where: eq(user.id, userId),
      columns: { isPlatformOperator: true },
    });
    return row?.isPlatformOperator ?? false;
  });
}
