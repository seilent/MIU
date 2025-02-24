'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { usePlayerStore } from '@/lib/store/playerStore';
import { BokehBackground } from '@/components/ui/BokehBackground';
import env from '@/utils/env';

type RGB = [number, number, number];

interface ColorPalette {
  background: string;
  primary: string;
  secondary: string;
  accent: string;
}

const defaultColors: ColorPalette = {
  background: '#1e293b', // Slate-800 - rich dark blue background
  primary: '#4f46e5',    // Indigo-600 - vibrant purple-blue
  secondary: '#7c3aed',  // Violet-600 - rich purple
  accent: '#3b82f6',     // Blue-500 - bright blue accent
};

interface ThemeContextType {
  colors: ColorPalette;
}

const ThemeContext = createContext<ThemeContextType>({
  colors: defaultColors,
});

export const useTheme = () => useContext(ThemeContext);

interface ThemeProviderProps {
  children: React.ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const [colors, setColors] = useState<ColorPalette>(defaultColors);

  useEffect(() => {
    
    // Transform old sv-miu URLs to new format
    let imageUrl = currentTrack?.thumbnail || '/images/DEFAULT.jpg';

    // Create a new image element for color extraction
    const img = document.createElement('img');
    img.crossOrigin = 'Anonymous';
    img.src = imageUrl;

    const extractRGB = (color: string): string => {
      const hex = color.startsWith('#') ? color : `#${color}`;
      const r = parseInt(hex.substring(1, 3), 16);
      const g = parseInt(hex.substring(3, 5), 16);
      const b = parseInt(hex.substring(5, 7), 16);
      return `${r}, ${g}, ${b}`;
    };

    const applyColors = (newColors: ColorPalette) => {
      // First set RGB values
      document.documentElement.style.setProperty('--color-primary-rgb', extractRGB(newColors.primary));
      document.documentElement.style.setProperty('--color-secondary-rgb', extractRGB(newColors.secondary));
      document.documentElement.style.setProperty('--color-accent-rgb', extractRGB(newColors.accent));
      document.documentElement.style.setProperty('--color-background-rgb', extractRGB(newColors.background));

      // Then set hex values
      requestAnimationFrame(() => {
        document.documentElement.style.setProperty('--color-primary', newColors.primary);
        document.documentElement.style.setProperty('--color-secondary', newColors.secondary);
        document.documentElement.style.setProperty('--color-accent', newColors.accent);
        document.documentElement.style.setProperty('--color-background', newColors.background);
        
        // Add fallback properties for Chrome
        document.documentElement.style.setProperty('--theme-primary', newColors.primary);
        document.documentElement.style.setProperty('--theme-secondary', newColors.secondary);
        document.documentElement.style.setProperty('--theme-accent', newColors.accent);
        document.documentElement.style.setProperty('--theme-background', newColors.background);
      });
    };

    const loadImage = async () => {
      try {
        const { extractColors } = await import('@/lib/utils/colorExtractor');
        
        await new Promise<void>((resolve, reject) => {
          img.onload = () => {
            resolve();
          };
          img.onerror = reject;
        });

        const newColors = await extractColors(imageUrl);
        setColors(newColors);
        applyColors(newColors);

      } catch (error) {
        console.error('ThemeProvider: Error loading image or extracting colors:', error);
        setColors(defaultColors);
        applyColors(defaultColors);
      }
    };

    loadImage();

    // Cleanup function to prevent memory leaks and race conditions
    return () => {
      img.onload = null;
      img.onerror = null;
      img.src = '';
      document.documentElement.style.removeProperty('--color-primary');
      document.documentElement.style.removeProperty('--color-secondary');
      document.documentElement.style.removeProperty('--color-accent');
      document.documentElement.style.removeProperty('--color-background');
      document.documentElement.style.removeProperty('--color-primary-rgb');
      document.documentElement.style.removeProperty('--color-secondary-rgb');
      document.documentElement.style.removeProperty('--color-accent-rgb');
      document.documentElement.style.removeProperty('--color-background-rgb');
      
      // Remove Chrome-specific fallbacks
      document.documentElement.style.removeProperty('--theme-primary');
      document.documentElement.style.removeProperty('--theme-secondary');
      document.documentElement.style.removeProperty('--theme-accent');
      document.documentElement.style.removeProperty('--theme-background');
    };
  }, [currentTrack?.thumbnail]);


  return (
    <ThemeContext.Provider value={{ colors }}>
      <div className="relative min-h-screen w-full overflow-hidden">
        {/* Base background with static color */}
        <div 
          className="fixed inset-0 w-full h-full bg-black transition-[background] duration-1000 pointer-events-none" 
          style={{ 
            zIndex: -3,
            backgroundColor: colors.background
          }}
        />

        {/* Bokeh effect layer */}
        <BokehBackground colors={colors} numParticles={25} />

        {/* Content layer */}
        <div className="relative z-10 min-h-screen w-full bg-background/95">
          {children}
        </div>
      </div>
    </ThemeContext.Provider>
  );
}

export default ThemeProvider;
