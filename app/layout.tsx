import type { Metadata } from "next";
import localFont from "next/font/local";

import "./globals.css";

/**
 * Fonts are self-hosted rather than pulled through next/font/google.
 *
 * next/font/google downloads from fonts.gstatic.com *at build time*, which
 * fails inside a sandboxed image build (Kaniko has no egress):
 *   getaddrinfo ENOTFOUND fonts.gstatic.com
 *
 * Shipping the woff2 files makes the build hermetic, and also stops the browser
 * making a third-party request at runtime. Both faces are the latin variable
 * subsets, under the SIL Open Font License — see app/fonts/OFL.md.
 *
 * A technical pairing: geometric grotesk for labels, mono for every figure so
 * digits line up in columns down the page.
 */
const sans = localFont({
  src: "./fonts/space-grotesk.woff2",
  variable: "--font-sans",
  weight: "300 700",
  display: "swap",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "sans-serif"],
});

const mono = localFont({
  src: "./fonts/jetbrains-mono.woff2",
  variable: "--font-mono",
  weight: "100 800",
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
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
