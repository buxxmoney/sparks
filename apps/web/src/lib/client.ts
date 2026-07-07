import { createSparksClient } from "@sparks/api";
import { getSelectedOrganization } from "./useOrganizationContext";

// The single, fully-typed oRPC client for the whole web app. Call procedures as
// `client.sites.list({ organizationId })` — inputs and outputs are type-checked
// against the server. The selected organization travels as a header on each call.
export const client = createSparksClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001",
  headers: () => {
    const orgId = getSelectedOrganization();
    const h: Record<string, string> = {};
    if (orgId) h["x-organization-id"] = orgId;
    return h;
  },
});
