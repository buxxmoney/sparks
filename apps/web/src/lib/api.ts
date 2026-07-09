import { clearSelectedOrganization } from "./useOrganizationContext";

const getApiUrl = () =>
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export async function getSessionData() {
  try {
    const response = await fetch(`${getApiUrl()}/api/auth/get-session`, {
      credentials: "include",
    });

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch {
    return null;
  }
}

export async function signOut() {
  try {
    // Better-auth's sign-out REQUIRES a JSON content-type (+ body), or it rejects
    // the request with HTTP 415 and never clears the session cookie — which is why
    // "signing out" left the user still logged in. Send an empty JSON body.
    const res = await fetch(`${getApiUrl()}/api/auth/sign-out`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      console.error(`[signOut] server returned ${res.status} — session may not be cleared`);
    }
  } catch (err) {
    console.error("[signOut] request failed", err);
  } finally {
    // Clear selected organization from localStorage
    clearSelectedOrganization();
  }
}
