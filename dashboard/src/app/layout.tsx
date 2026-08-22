import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Aegis Protocol — Autonomous AI Circuit Breaker for DeFi",
  description: "AI-verified auto-remediation for DeFi protocols. Multi-agent swarm verifies exploits via Tavily OSINT before triggering on-chain pause() transactions.",
  keywords: ["DeFi", "circuit breaker", "AI agent", "Web3 security", "Tavily", "auto-remediation", "smart contract", "EVM"],
  authors: [{ name: "Aegis Protocol Team" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Aegis Protocol — Autonomous AI Circuit Breaker",
    description: "AI-verified auto-remediation for DeFi protocols.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Aegis Protocol",
    description: "Autonomous AI Circuit Breaker for DeFi",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-slate-950 text-white`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
