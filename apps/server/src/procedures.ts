import type { AuthContext } from "./middleware";
import { getDb, member, organization } from "@sparks/db";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

export interface SessionMe {
  userId: string;
  organizationId: string;
}

export interface Membership {
  organizationId: string;
  organizationName: string;
  role: string;
}

export async function sessionMe(authContext: AuthContext): Promise<SessionMe> {
  // For now, return empty org ID if not set - this allows the frontend to call this
  // before selecting an organization. In the future, this would query the user's
  // default organization from better-auth or return their only organization.
  return {
    userId: authContext.userId,
    organizationId: authContext.organizationId || "default-org",
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

export async function sessionCreateOrganization(
  authContext: AuthContext,
  input: CreateOrganizationInput,
): Promise<CreateOrganizationResult> {
  const db = getDb();

  const orgId = randomUUID();

  await db.insert(organization).values({
    id: orgId,
    name: input.name,
  });

  await db.insert(member).values({
    id: randomUUID(),
    organizationId: orgId,
    userId: authContext.userId,
    role: "owner",
  });

  return {
    organizationId: orgId,
    organizationName: input.name,
  };
}
