import { useEffect, useState } from "react";
import { client } from "./client";
import { getSelectedOrganization, setSelectedOrganization } from "./useOrganizationContext";
import { useRPC } from "./useRPC";

export function useOrganization() {
  const [organizationId, setOrganizationId] = useState<string | null>(null);

  // session.me echoes the current org from the auth context + operator flag.
  const { data: sessionMe, loading, error } = useRPC(() => client.session.me(), []);

  useEffect(() => {
    if (sessionMe?.organizationId) {
      setOrganizationId(sessionMe.organizationId);
      // Reconcile localStorage with the server-resolved org so the x-organization-id
      // header sent on future requests is a real membership. This heals a stale or
      // foreign org id left by a previous account without stranding the user.
      if (getSelectedOrganization() !== sessionMe.organizationId) {
        setSelectedOrganization(sessionMe.organizationId);
      }
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
