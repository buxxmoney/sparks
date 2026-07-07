import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { AppChrome } from "@/components/app-chrome/AppChrome";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata = {
  title: "Sparks — Electricity Reconciliation",
  description: "Sub-meter your electricity, reconcile against tariffs, and dispute overcharges",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body style={{ fontFamily: "var(--font-sans), system-ui, sans-serif", WebkitFontSmoothing: "antialiased" }}>
        <Providers>
          <AppChrome>{children}</AppChrome>
        </Providers>
      </body>
    </html>
  );
}
