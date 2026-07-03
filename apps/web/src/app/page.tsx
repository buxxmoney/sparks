"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/useSession";

export default function Home() {
  const router = useRouter();
  const { session, loading } = useSession();

  useEffect(() => {
    if (!loading) {
      if (session?.user) {
        router.push("/dashboard");
      } else {
        router.push("/auth/login");
      }
    }
  }, [session, loading, router]);

  return (
    <main style={{ textAlign: "center", padding: "4rem" }}>
      <h1>Sparks — Electricity Reconciliation & Dispute Platform</h1>
      <p>Redirecting...</p>
    </main>
  );
}
