import { useEffect, useState } from "react";

export interface Session {
  user: {
    id: string;
    email: string;
    name?: string;
  };
  session: {
    id: string;
    expiresAt: string;
  };
}

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchSession = async () => {
      try {
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/api/auth/session`,
          {
            credentials: "include",
          },
        );

        if (response.ok) {
          const data = await response.json();
          setSession(data);
        } else {
          setSession(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch session");
        setSession(null);
      } finally {
        setLoading(false);
      }
    };

    fetchSession();
  }, []);

  return { session, loading, error };
}
