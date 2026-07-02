import type { ReactNode } from "react";

export const metadata = {
  title: "Sparks — Electricity Reconciliation",
  description: "Sub-meter your electricity, reconcile against tariffs, and dispute overcharges",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
