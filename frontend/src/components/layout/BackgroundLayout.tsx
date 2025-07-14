'use client';

import { useTheme } from '@/providers/ThemeProvider';
import { FrostedBackground } from '@/components/ui/FrostedBackground';

interface BackgroundLayoutProps {
  children: React.ReactNode;
}

export function BackgroundLayout({ children }: BackgroundLayoutProps) {
  const { colors } = useTheme();

  return (
    <div className="relative min-h-screen w-full overflow-hidden">
      {/* Base background with static color */}
      <div 
        className="fixed inset-0 w-full h-full transition-[background] duration-1000 pointer-events-none" 
        style={{ 
          zIndex: -3,
          backgroundColor: colors.background
        }}
      />
      
      {/* Add a subtle gradient overlay for more depth and vibrancy */}
      <div 
        className="fixed inset-0 w-full h-full opacity-50 transition-opacity duration-1000 ease-in-out pointer-events-none" 
        style={{
          zIndex: -2,
          background: `radial-gradient(circle at 50% 50%, 
                      rgba(${colors.primaryRgb}, 0.15) 0%, 
                      rgba(${colors.backgroundRgb}, 0.08) 50%, 
                      rgba(${colors.backgroundRgb}, 0) 100%)`,
          mixBlendMode: 'overlay'
        }}
      />

      {/* Frosted background layer */}
      <FrostedBackground className="z-[-1]" />

      {/* Content layer - slightly more transparent to let more color through */}
      <div className="relative z-10 min-h-screen w-full bg-background/90 text-foreground">
        {children}
      </div>
    </div>
  );
} 