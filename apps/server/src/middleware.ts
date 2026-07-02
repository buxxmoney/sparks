import { getDb, siteAccess, sites } from "@sparks/db";
import { eq, and } from "drizzle-orm";
import type { Context } from "hono";

export interface AuthContext {
  userId: string;
  sessionId: string;
  organizationId: string;
}

export interface SiteAccessContext extends AuthContext {
  siteId: string;
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

export async function requireSession(c: Context): Promise<AuthContext> {
  const session = c.req.header("x-session-id");
  const userId = c.req.header("x-user-id");
  const organizationId = c.req.header("x-organization-id");

  if (!session || !userId || !organizationId) {
    throw new UnauthorizedError("Missing session headers");
  }

  return { sessionId: session, userId, organizationId };
}

export async function requireOrg(
  authContext: AuthContext,
  expectedOrgId?: string,
): Promise<void> {
  if (expectedOrgId && authContext.organizationId !== expectedOrgId) {
    throw new ForbiddenError("Organization mismatch");
  }
}

export interface RequireSiteAccessOptions {
  role?: string;
}

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

  const access = await db.query.siteAccess.findFirst({
    where: and(
      eq(siteAccess.siteId, siteId),
      eq(siteAccess.userId, authContext.userId),
    ),
  });

  if (!access) {
    throw new ForbiddenError("No access to site");
  }

  if (options?.role && access.role !== options.role) {
    throw new ForbiddenError(`Required role: ${options.role}`);
  }

  return { ...authContext, siteId };
}

export async function requirePlatformOperator(
  _userId: string,
): Promise<void> {
  // TODO: Implement platform operator check via better-auth user table
  // The user table is managed by better-auth and includes is_platform_operator field
  // Once better-auth schema is fully integrated, query: SELECT is_platform_operator FROM user WHERE id = $1
  throw new ForbiddenError("Platform operator access required");
}
