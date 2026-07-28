"use client";

import { useEffect } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Text } from "@astryxdesign/core/Text";
import sparksMark from "@/assets/sparks-icon.png";
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
      <Image src={sparksMark} alt="Sparks" priority style={{ height: 48, width: "auto" }} />
      <Text type="supporting">Loading Sparks…</Text>
    </div>
  );
}
