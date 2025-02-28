import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/providers/AuthProvider";
import { PlayerProvider } from "@/providers/PlayerProvider";
import { AppShell } from "@/components/layout/AppShell";
import { ThemeProvider } from "@/providers/ThemeProvider";
import { PresenceProvider } from "@/providers/PresenceProvider";
import { MetaTags } from "@/components/MetaTags";
import dynamic from "next/dynamic";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const DEFAULT_IMAGE = `${API_BASE_URL}/DEFAULT.jpg`;

// Import AudioSync with dynamic import to ensure it only loads on the client side
const AudioSync = dynamic(() => import("@/components/player/AudioSync"), { ssr: false });

const inter = Inter({ subsets: ["latin"] });

// Default metadata
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'),
  title: "MIU",
  description: "Collaborative music player for Discord communities",
  openGraph: {
    type: 'website',
    title: 'MIU',
    description: 'Collaborative music player for Discord communities',
    images: [DEFAULT_IMAGE],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'MIU',
    description: 'Collaborative music player for Discord communities',
    images: [DEFAULT_IMAGE],
  },
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
      <head>
        <meta property="og:title" content="MIU" />
        <meta property="og:description" content="Collaborative music player for Discord communities" />
        <meta property="og:image" content={DEFAULT_IMAGE} />
        <meta property="og:image:width" content="1280" />
        <meta property="og:image:height" content="720" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="MIU" />
        <meta name="twitter:description" content="Collaborative music player for Discord communities" />
        <meta name="twitter:image" content={DEFAULT_IMAGE} />
      </head>
      <body className={`${inter.className} h-full`}>
        <AuthProvider>
          <PlayerProvider>
            <ThemeProvider>
              <PresenceProvider>
                <MetaTags />
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
