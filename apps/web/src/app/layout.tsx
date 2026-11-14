import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AuthProvider } from "@/lib/auth/auth-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "挖礦探險隊 Mining Expedition",
  description: "像素風放置挖礦遊戲",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#140b07",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body className="antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
