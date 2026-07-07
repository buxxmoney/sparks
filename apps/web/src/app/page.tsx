"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Zap } from "lucide-react";
import { Text } from "@astryxdesign/core/Text";
import { useSession } from "@/lib/useSession";

export default function Home() {
  const router = useRouter();
  const { session, loading } = useSession();

  useEffect(() => {
    if (!loading) {
      router.push(session?.user ? "/dashboard" : "/auth/login");
    }
  }, [session, loading, router]);

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        textAlign: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          width: 48,
          height: 48,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 12,
          background: "hsl(221 83% 53%)",
          color: "white",
        }}
      >
        <Zap size={24} />
      </div>
      <Text type="supporting">Loading Sparks…</Text>
    </div>
  );
}
