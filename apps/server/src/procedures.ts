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
  return {
    userId: authContext.userId,
    organizationId: authContext.organizationId,
  };
}

export async function sessionListMemberships(): Promise<Membership[]> {
  // TODO: Query member table from better-auth to get all org memberships
  // This will be implemented once better-auth member table is fully integrated
  return [];
}
