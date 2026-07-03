import type { AuthContext } from "./middleware";

export interface SessionMe {
  userId: string;
  organizationId: string;
}

export interface Membership {
  organizationId: string;
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

export async function sessionListMemberships(): Promise<Membership[]> {
  // TODO: Query member table from better-auth to get all org memberships
  // This will be implemented once better-auth member table is fully integrated
  return [];
}
