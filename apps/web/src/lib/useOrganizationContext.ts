// Get selected organization from localStorage
export function getSelectedOrganization(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("selectedOrganizationId");
}

// Set selected organization in localStorage
export function setSelectedOrganization(orgId: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem("selectedOrganizationId", orgId);
}

// Clear selected organization
export function clearSelectedOrganization(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem("selectedOrganizationId");
}
