import type { ReactNode } from "react";
import Image from "next/image";
import sparksLogo from "@/assets/sparks-logo.png";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";

/** Centered, branded shell for the unauthenticated auth screens. */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "3rem 1rem",
      }}
    >
      <div style={{ width: "100%", maxWidth: 440 }}>
        <div
          style={{
            marginBottom: 24,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
            gap: 8,
          }}
        >
          <Image
            src={sparksLogo}
            alt="Sparks — Energy Reconciliation"
            priority
            style={{ height: 56, width: "auto", maxWidth: "100%", marginBottom: 4 }}
          />
          <Heading level={1}>{title}</Heading>
          {subtitle ? <Text type="supporting">{subtitle}</Text> : null}
        </div>

        <Card padding={6}>{children}</Card>

        {footer ? (
          <div style={{ marginTop: 20, textAlign: "center" }}>
            <Text type="supporting">{footer}</Text>
          </div>
        ) : null}
      </div>
    </div>
  );
}
