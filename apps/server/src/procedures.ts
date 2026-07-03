import type { AuthContext } from "./middleware";
import { getDb, member, organization } from "@sparks/db";
import { eq } from "drizzle-orm";

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

  const memberships = await db.query.member.findMany({
    where: eq(member.userId, authContext.userId),
    with: {
      organization: true,
    },
  });

  return memberships.map((m) => ({
    organizationId: m.organizationId,
    organizationName: m.organization.name,
    role: m.role,
  }));
}
