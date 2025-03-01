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
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const DEFAULT_IMAGE = `${API_BASE_URL}/images/DEFAULT.jpg`;

// Import AudioSync with dynamic import to ensure it only loads on the client side
const AudioSync = dynamic(() => import("@/components/player/AudioSync"), { ssr: false });
// Import PWAInstaller with dynamic import to ensure it only loads on the client side
const PWAInstaller = dynamic(() => import("@/components/PWAInstaller"), { ssr: false });

const inter = Inter({ subsets: ["latin"] });

// Default metadata
export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: "MIU",
  description: "Collaborative music player for Discord communities",
  manifest: "/manifest.json",
  themeColor: "#4f46e5",
  appleWebApp: {
    capable: true,
    title: "MIU Music Player",
    statusBarStyle: "black-translucent"
  },
  openGraph: {
    type: 'website',
    title: 'MIU',
    description: 'Collaborative music player for Discord communities',
    images: [`${APP_URL}/api/og`],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'MIU',
    description: 'Collaborative music player for Discord communities',
    images: [`${APP_URL}/api/og`],
  },
  icons: {
    icon: [
      {
        url: '/favicon.svg',
        type: 'image/svg+xml',
      }
    ],
    apple: [
      { url: '/app-icon-192.png' }
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
        <meta property="og:image" content={`${APP_URL}/api/og`} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="MIU" />
        <meta name="twitter:description" content="Collaborative music player for Discord communities" />
        <meta name="twitter:image" content={`${APP_URL}/api/og`} />
        
        {/* iOS PWA specific meta tags */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="MIU Music Player" />
        <link rel="apple-touch-icon" href="/app-icon-192.png" />
        <link rel="apple-touch-startup-image" href="/app-icon-512.png" />
        <meta name="theme-color" content="#4f46e5" />
      </head>
      <body className={`${inter.className} h-full`}>
        <AuthProvider>
          <PlayerProvider>
            <ThemeProvider>
              <PresenceProvider>
                <MetaTags />
                <AppShell>{children}</AppShell>
                <AudioSync />
                <PWAInstaller />
              </PresenceProvider>
            </ThemeProvider>
          </PlayerProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
