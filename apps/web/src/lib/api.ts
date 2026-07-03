import { createClient, type RPCClientOptions } from "@sparks/api";

const getApiUrl = () => {
  if (typeof window === "undefined") {
    return process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
  }
  return process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
};

export const apiClient = createClient({
  baseUrl: getApiUrl(),
});

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
    await fetch(`${getApiUrl()}/api/auth/sign-out`, {
      method: "POST",
      credentials: "include",
    });
  } catch {
    // ignore
  }
}
