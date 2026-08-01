import type { Metadata } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";

import "./globals.css";

// A technical pairing: geometric grotesk for labels, mono for every figure so
// digits line up in columns down the page.
const sans = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: process.env.APP_NAME?.trim() || "Air Quality",
  description: "Realtime UniFi Protect air quality telemetry",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Dark is the only mode this dashboard ships - the charts are stepped for it.
  return (
    <html
      lang="en"
      className={`dark ${sans.variable} ${mono.variable}`}
      style={{ colorScheme: "dark" }}
    >
      <body className="bg-background font-sans text-foreground antialiased">{children}</body>
    </html>
  );
}
