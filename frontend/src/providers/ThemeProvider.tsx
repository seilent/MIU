'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { usePlayerStore } from '@/lib/store/playerStore';
import { BokehBackground } from '@/components/ui/BokehBackground';
import env from '@/utils/env';

type RGB = [number, number, number];

interface ThemeColors {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  primaryRgb: string;
  secondaryRgb: string;
  accentRgb: string;
  backgroundRgb: string;
}

const defaultColors: ThemeColors = {
  primary: '#6366f1',
  secondary: '#8b5cf6',
  accent: '#ec4899',
  background: '#0f172a',
  primaryRgb: '99, 102, 241',
  secondaryRgb: '139, 92, 246',
  accentRgb: '236, 72, 153',
  backgroundRgb: '15, 23, 42'
};

interface ThemeContextType {
  colors: ThemeColors;
}

const ThemeContext = createContext<ThemeContextType>({
  colors: defaultColors
});

export const useTheme = () => useContext(ThemeContext);

interface ThemeProviderProps {
  children: React.ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const [colors, setColors] = useState<ThemeColors>(defaultColors);
  const [previousThumbnail, setPreviousThumbnail] = useState<string | null>(null);

  useEffect(() => {
    // Keep track of the previous thumbnail to prevent UI flicker during transitions
    if (currentTrack?.thumbnail) {
      setPreviousThumbnail(currentTrack.thumbnail);
    }
    
    // Use current thumbnail or previous thumbnail during transitions
    const thumbnailUrl = currentTrack?.thumbnail || previousThumbnail || '/images/DEFAULT.jpg';
    
    // Transform old sv-miu URLs to new format and ensure YouTube thumbnails are properly formatted
    let transformedUrl = thumbnailUrl;
    
    // Handle old sv-miu URLs
    if (thumbnailUrl.startsWith('https://sv-miu.vercel.app/api/albumart/')) {
      transformedUrl = thumbnailUrl.replace(
        /^https:\/\/sv-miu\.vercel\.app\/api\/albumart\//,
        `${env.apiUrl}/api/albumart/`
      );
    }
    
    // Handle YouTube Music thumbnails
    if (thumbnailUrl.startsWith('https://i.ytimg.com/')) {
      // Ensure we're using maxresdefault for best quality
      transformedUrl = thumbnailUrl.replace(
        /\/[^/]+\.jpg$/,
        '/maxresdefault.jpg'
      );
    }

    // Create an image element to load the thumbnail
    const img = new Image();
    
    // Function to extract colors from the image
    const loadImage = () => {
      img.crossOrigin = 'Anonymous';
      img.onload = () => {
        try {
          // Create a canvas to draw the image
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          
          // Set canvas size to match image
          canvas.width = img.width;
          canvas.height = img.height;
          
          // Draw image to canvas
          ctx.drawImage(img, 0, 0);
          
          // Get image data for color analysis
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imageData.data;
          
          // Extract colors using a simple algorithm
          // This could be improved with a more sophisticated color extraction library
          const colorMap: Record<string, number> = {};
          const step = 4; // Skip pixels for performance
          
          for (let i = 0; i < data.length; i += 4 * step) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            
            // Skip transparent pixels
            if (data[i + 3] < 128) continue;
            
            // Skip very dark pixels
            if (r < 20 && g < 20 && b < 20) continue;
            
            // Create a color key with reduced precision for better grouping
            const key = `${Math.floor(r/10)},${Math.floor(g/10)},${Math.floor(b/10)}`;
            
            if (!colorMap[key]) {
              colorMap[key] = 0;
            }
            colorMap[key]++;
          }
          
          // Sort colors by frequency
          const sortedColors = Object.entries(colorMap)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([key]) => {
              const [r, g, b] = key.split(',').map(v => parseInt(v) * 10);
              return { r, g, b };
            });
          
          if (sortedColors.length > 0) {
            // Primary color is the most frequent (most dominant)
            const primary = sortedColors[0];
            
            // Find a contrasting color for secondary
            const secondary = sortedColors.find(color => {
              const distance = Math.sqrt(
                Math.pow(color.r - primary.r, 2) +
                Math.pow(color.g - primary.g, 2) +
                Math.pow(color.b - primary.b, 2)
              );
              return distance > 50; // Minimum distance for contrast
            }) || { r: 255 - primary.r, g: 255 - primary.g, b: 255 - primary.b };
            
            // Use a less dominant color for accent (3rd or 4th most frequent if available)
            const accentIndex = Math.min(sortedColors.length - 1, 2); // Get 3rd color or last if fewer
            const accentBase = sortedColors[accentIndex];
            
            // Convert RGB to HSL for better control over saturation
            const rgbToHsl = (r: number, g: number, b: number): [number, number, number] => {
              r /= 255;
              g /= 255;
              b /= 255;
              
              const max = Math.max(r, g, b);
              const min = Math.min(r, g, b);
              let h = 0, s = 0, l = (max + min) / 2;
            
              if (max !== min) {
                const d = max - min;
                s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                
                switch (max) {
                  case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                  case g: h = (b - r) / d + 2; break;
                  case b: h = (r - g) / d + 4; break;
                }
                
                h /= 6;
              }
            
              return [h, s, l];
            };
            
            // Convert HSL back to RGB
            const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
              let r, g, b;
            
              if (s === 0) {
                r = g = b = l; // achromatic
              } else {
                const hue2rgb = (p: number, q: number, t: number) => {
                  if (t < 0) t += 1;
                  if (t > 1) t -= 1;
                  if (t < 1/6) return p + (q - p) * 6 * t;
                  if (t < 1/2) return q;
                  if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                  return p;
                };
            
                const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
                const p = 2 * l - q;
                
                r = hue2rgb(p, q, h + 1/3);
                g = hue2rgb(p, q, h);
                b = hue2rgb(p, q, h - 1/3);
              }
            
              return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
            };
            
            // Find the most dominant yet colorful color for the background
            // Calculate saturation and colorfulness for each color
            const colorfulnessScores = sortedColors.map((color, index) => {
              const [h, s, l] = rgbToHsl(color.r, color.g, color.b);
              
              // Calculate colorfulness score based on saturation and avoiding extreme lightness
              // We want to avoid very light colors (high lightness) and very dark colors (low lightness)
              const saturationScore = s * 100; // 0-100
              const lightnessScore = 100 - Math.abs(l - 0.5) * 200; // 0-100, highest at l=0.5
              
              // Calculate color variance (difference between RGB channels)
              const avg = (color.r + color.g + color.b) / 3;
              const variance = Math.sqrt(
                Math.pow(color.r - avg, 2) + 
                Math.pow(color.g - avg, 2) + 
                Math.pow(color.b - avg, 2)
              ) / 255 * 100; // 0-100
              
              // Combine scores, weighting frequency by position in the sorted list
              const frequencyScore = 100 * Math.pow(0.8, index); // 100, 80, 64, 51.2, etc.
              
              // Final score combines all factors
              const score = (saturationScore * 0.4) + (lightnessScore * 0.2) + (variance * 0.2) + (frequencyScore * 0.2);
              
              return { color, score };
            });
            
            // Sort by colorfulness score and pick the best one
            colorfulnessScores.sort((a, b) => b.score - a.score);
            const backgroundBase = colorfulnessScores[0].color;
            
            // Convert accent to HSL, increase saturation, then back to RGB
            const [accentH, accentS, accentL] = rgbToHsl(accentBase.r, accentBase.g, accentBase.b);
            const [accentR, accentG, accentB] = hslToRgb(accentH, Math.min(1, accentS * 1.5), accentL);
            
            const accent = {
              r: accentR,
              g: accentG,
              b: accentB
            };
            
            // Use the most colorful dominant color for background
            const minBrightness = 30; // Lower minimum brightness for more muted look
            const maxBrightness = 60; // Lower maximum brightness
            
            // Convert background base color to HSL
            const [bgBaseH, bgBaseS, bgBaseL] = rgbToHsl(backgroundBase.r, backgroundBase.g, backgroundBase.b);
            
            // Create a darkened version of the background base color
            const darkeningFactor = 0.25; // Increased darkening for more muted look
            const saturationBoost = 1.2; // Reduced saturation boost for more muted colors
            
            // Calculate background color with enhanced vibrancy but more muted
            const backgroundLightness = Math.max(0.12, bgBaseL * darkeningFactor);
            const backgroundSaturation = Math.min(0.8, bgBaseS * saturationBoost);
            
            // Convert back to RGB
            const [bgR, bgG, bgB] = hslToRgb(bgBaseH, backgroundSaturation, backgroundLightness);
            
            const background = {
              r: bgR,
              g: bgG,
              b: bgB
            };
            
            // Ensure the background has some color variation and isn't just black
            const finalAvgBackground = (background.r + background.g + background.b) / 3;
            if (finalAvgBackground < minBrightness) {
              const factor = minBrightness / Math.max(1, finalAvgBackground);
              background.r = Math.min(255, Math.round(background.r * factor));
              background.g = Math.min(255, Math.round(background.g * factor));
              background.b = Math.min(255, Math.round(background.b * factor));
            }
            
            // Ensure primary color has enough contrast with background for text elements
            const [primaryH, primaryS, primaryL] = rgbToHsl(primary.r, primary.g, primary.b);
            let adjustedPrimary = { ...primary };
            
            // Calculate contrast ratio between primary and background
            const luminanceBackground = (0.299 * background.r + 0.587 * background.g + 0.114 * background.b) / 255;
            const luminancePrimary = (0.299 * primary.r + 0.587 * primary.g + 0.114 * primary.b) / 255;
            const contrastRatio = Math.abs(luminancePrimary - luminanceBackground);
            
            // If contrast is too low, adjust primary color
            if (contrastRatio < 0.3) {
              // Make primary color brighter or darker depending on background
              const newPrimaryL = luminanceBackground < 0.5 
                ? Math.min(0.9, primaryL + 0.3) // Brighter for dark backgrounds
                : Math.max(0.1, primaryL - 0.3); // Darker for light backgrounds
              
              const [adjustedR, adjustedG, adjustedB] = hslToRgb(primaryH, primaryS, newPrimaryL);
              adjustedPrimary = {
                r: adjustedR,
                g: adjustedG,
                b: adjustedB
              };
            }
            
            // Ensure accent color has good contrast with background for accent text elements
            let adjustedAccent = { ...accent };
            
            // Calculate contrast ratio between accent and background
            const luminanceAccent = (0.299 * accent.r + 0.587 * accent.g + 0.114 * accent.b) / 255;
            const accentContrastRatio = Math.abs(luminanceAccent - luminanceBackground);
            
            // If contrast is too low, adjust accent color to ensure text-theme-accent is readable
            if (accentContrastRatio < 0.4) { // Higher threshold for accent text
              // Make accent color brighter or darker depending on background
              const newAccentL = luminanceBackground < 0.5 
                ? Math.min(0.85, accentL + 0.35) // Brighter for dark backgrounds
                : Math.max(0.15, accentL - 0.35); // Darker for light backgrounds
              
              const [adjustedAccentR, adjustedAccentG, adjustedAccentB] = hslToRgb(accentH, accentS, newAccentL);
              adjustedAccent = {
                r: adjustedAccentR,
                g: adjustedAccentG,
                b: adjustedAccentB
              };
            }
            
            // Update colors with a smooth transition
            const newColors = {
              primary: `rgb(${adjustedPrimary.r}, ${adjustedPrimary.g}, ${adjustedPrimary.b})`,
              secondary: `rgb(${secondary.r}, ${secondary.g}, ${secondary.b})`,
              accent: `rgb(${adjustedAccent.r}, ${adjustedAccent.g}, ${adjustedAccent.b})`,
              background: `rgb(${background.r}, ${background.g}, ${background.b})`,
              primaryRgb: `${adjustedPrimary.r}, ${adjustedPrimary.g}, ${adjustedPrimary.b}`,
              secondaryRgb: `${secondary.r}, ${secondary.g}, ${secondary.b}`,
              accentRgb: `${adjustedAccent.r}, ${adjustedAccent.g}, ${adjustedAccent.b}`,
              backgroundRgb: `${background.r}, ${background.g}, ${background.b}`
            };
            
            setColors(newColors);
            
            // Apply colors to CSS variables with transitions
            // Use requestAnimationFrame for smoother transitions
      requestAnimationFrame(() => {
              // Apply colors to CSS variables for global access
        document.documentElement.style.setProperty('--color-primary', newColors.primary);
        document.documentElement.style.setProperty('--color-secondary', newColors.secondary);
        document.documentElement.style.setProperty('--color-accent', newColors.accent);
        document.documentElement.style.setProperty('--color-background', newColors.background);
        
              // Set RGB variables for opacity adjustments
              document.documentElement.style.setProperty('--color-primary-rgb', newColors.primaryRgb);
              document.documentElement.style.setProperty('--color-secondary-rgb', newColors.secondaryRgb);
              document.documentElement.style.setProperty('--color-accent-rgb', newColors.accentRgb);
              document.documentElement.style.setProperty('--color-background-rgb', newColors.backgroundRgb);
              
              // Chrome-specific fallbacks
        document.documentElement.style.setProperty('--theme-primary', newColors.primary);
        document.documentElement.style.setProperty('--theme-secondary', newColors.secondary);
        document.documentElement.style.setProperty('--theme-accent', newColors.accent);
        document.documentElement.style.setProperty('--theme-background', newColors.background);
      });
          }
        } catch (error) {
          // Error extracting colors
          setColors(defaultColors);
        }
      };
      
      img.onerror = () => {
        // Failed to load image for color extraction
        setColors(defaultColors);
      };
      
      img.src = transformedUrl;
    };

    loadImage();

    // Cleanup function to prevent memory leaks and race conditions
    return () => {
      img.onload = null;
      img.onerror = null;
      img.src = '';
    };
  }, [currentTrack?.thumbnail, previousThumbnail]);


  return (
    <ThemeContext.Provider value={{ colors }}>
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

        {/* Bokeh effect layer */}
        <BokehBackground colors={colors} numParticles={25} />

        {/* Content layer - slightly more transparent to let more color through */}
        <div className="relative z-10 min-h-screen w-full bg-background/90 text-foreground">
          {children}
        </div>
      </div>
    </ThemeContext.Provider>
  );
}

export default ThemeProvider;
