import type { ReactNode } from "react";
import { Inter, Orbit, Orbitron } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { AppChrome } from "@/components/app-chrome/AppChrome";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
// Brand faces, used only by the logo lockup in the app chrome: "Sparks" is set
// in Orbitron, the "Energy Reconcilliation" tagline in Orbit.
const orbitron = Orbitron({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-orbitron" });
const orbit = Orbit({ subsets: ["latin"], weight: "400", variable: "--font-orbit" });

export const metadata = {
  title: "Sparks — Electricity Reconciliation",
  description: "Sub-meter your electricity, reconcile against tariffs, and dispute overcharges",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${orbitron.variable} ${orbit.variable}`}>
      <body style={{ fontFamily: "var(--font-sans), system-ui, sans-serif", WebkitFontSmoothing: "antialiased" }}>
        <Providers>
          <AppChrome>{children}</AppChrome>
        </Providers>
      </body>
    </html>
  );
}
