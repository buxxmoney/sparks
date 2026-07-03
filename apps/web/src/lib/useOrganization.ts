import { useEffect, useState } from "react";
import { useRPC } from "./useRPC";

export interface SessionMe {
  userId: string;
  organizationId: string;
}

export function useOrganization() {
  const [organizationId, setOrganizationId] = useState<string | null>(null);

  // Call sessionMe to get the current organization from auth context
  const { data: sessionMe, loading, error } = useRPC<SessionMe>("session.me", undefined, []);

  useEffect(() => {
    if (sessionMe?.organizationId) {
      setOrganizationId(sessionMe.organizationId);
    }
  }, [sessionMe]);

  return { organizationId, loading, error };
}
