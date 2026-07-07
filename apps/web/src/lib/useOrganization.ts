import { useEffect, useState } from "react";
import { client } from "./client";
import { useRPC } from "./useRPC";

export function useOrganization() {
  const [organizationId, setOrganizationId] = useState<string | null>(null);

  // session.me echoes the current org from the auth context + operator flag.
  const { data: sessionMe, loading, error } = useRPC(() => client.session.me(), []);

  useEffect(() => {
    if (sessionMe?.organizationId) {
      setOrganizationId(sessionMe.organizationId);
    }
  }, [sessionMe]);

  return {
    organizationId,
    isPlatformOperator: sessionMe?.isPlatformOperator ?? false,
    orgRole: sessionMe?.orgRole ?? null,
    isOrgOwner: sessionMe?.orgRole === "owner",
    loading,
    error,
  };
}
