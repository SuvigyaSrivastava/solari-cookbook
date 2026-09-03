import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Tenfold — Your test passed. Run it ten times.",
  description:
    "Tenfold runs your plain-English test plan 10x in parallel in real cloud Chrome and reports the flake rate — with a session replay attached to every failure.",
};

export const viewport: Viewport = {
  themeColor: "#fdf6ec",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
