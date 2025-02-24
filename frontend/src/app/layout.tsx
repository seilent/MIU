import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/providers/AuthProvider";
import { PlayerProvider } from "@/providers/PlayerProvider";
import { AppShell } from "@/components/layout/AppShell";
import { ThemeProvider } from "@/providers/ThemeProvider";
import { PresenceProvider } from "@/providers/PresenceProvider";
import dynamic from "next/dynamic";

// Import AudioSync with dynamic import to ensure it only loads on the client side
const AudioSync = dynamic(() => import("@/components/player/AudioSync"), { ssr: false });

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "MIU",
  description: "Music Interface Unleashed",
  icons: {
    icon: [
      {
        url: '/favicon.svg',
        type: 'image/svg+xml',
      }
    ]
  }
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className={`${inter.className} h-full`}>
        <AuthProvider>
          <PlayerProvider>
            <ThemeProvider>
              <PresenceProvider>
                <AppShell>{children}</AppShell>
                <AudioSync />
              </PresenceProvider>
            </ThemeProvider>
          </PlayerProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
