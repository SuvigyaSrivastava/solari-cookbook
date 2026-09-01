import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tenfold — Your test passed. Run it ten times.",
  description:
    "Tenfold runs your plain-English test plan 10x in parallel in real cloud Chrome and reports the flake rate — with a session replay attached to every failure.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
