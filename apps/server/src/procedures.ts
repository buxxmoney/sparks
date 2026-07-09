import { getDb, member, organization, user } from "@sparks/db";
import { and, eq } from "drizzle-orm";
import { auth } from "./auth";
import type { AuthContext } from "./middleware";

export interface SessionMe {
  userId: string;
  organizationId: string;
  isPlatformOperator: boolean;
  /** The caller's org role in the selected org ("owner" | "member" | …), or null. */
  orgRole: string | null;
  /** Optional mobile number for SMS notifications. */
  phone: string | null;
}

export interface Membership {
  organizationId: string;
  organizationName: string;
  role: string;
}

export async function sessionMe(authContext: AuthContext): Promise<SessionMe> {
  // Returns the caller's selected organization. If none is selected yet, fall
  // back to their first membership so a freshly-signed-up user has a home org.
  const db = getDb();
  let organizationId = authContext.organizationId;
  if (!organizationId) {
    // Same deterministic order as requireSession's firstMembershipOrg fallback, so
    // the org shown here matches the one the request context resolves to.
    const first = await db.query.member.findFirst({
      where: eq(member.userId, authContext.userId),
      orderBy: (m, { asc }) => [asc(m.createdAt), asc(m.id)],
    });
    organizationId = first?.organizationId || "";
  }
  const row = await db.query.user.findFirst({
    where: eq(user.id, authContext.userId),
    columns: { isPlatformOperator: true, phone: true },
  });
  const membership = organizationId
    ? await db.query.member.findFirst({
        where: and(
          eq(member.userId, authContext.userId),
          eq(member.organizationId, organizationId),
        ),
      })
    : null;
  return {
    userId: authContext.userId,
    organizationId,
    isPlatformOperator: row?.isPlatformOperator ?? false,
    orgRole: membership?.role ?? null,
    phone: row?.phone ?? null,
  };
}

export async function sessionListMemberships(authContext: AuthContext): Promise<Membership[]> {
  const db = getDb();

  const memberships = await db
    .select({
      organizationId: member.organizationId,
      organizationName: organization.name,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, authContext.userId));

  return memberships;
}

export interface CreateOrganizationInput {
  name: string;
}

export interface CreateOrganizationResult {
  organizationId: string;
  organizationName: string;
}

/**
 * Create an organization for the current user via the better-auth organization
 * plugin (org = Account). The plugin transactionally creates the `organization`
 * row AND an owner `member` row — no hand-rolled inserts. Called as a trusted
 * server action (userId from the validated session context).
 */
export async function sessionCreateOrganization(
  authContext: AuthContext,
  input: CreateOrganizationInput,
): Promise<CreateOrganizationResult> {
  const slug = `${input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40)}-${crypto.randomUUID().slice(0, 8)}`;

  const org = await auth.api.createOrganization({
    body: {
      name: input.name,
      slug,
      userId: authContext.userId,
    },
  });

  if (!org) {
    throw new Error("Organization creation failed");
  }

  return {
    organizationId: org.id,
    organizationName: org.name,
  };
}
