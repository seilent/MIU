'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';

// Define ThemeColors interface here since we can't import it
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

interface Particle {
  x: number;
  y: number;
  size: number;
  color: {
    r: number;
    g: number;
    b: number;
  };
  speed: number;
  angle: number;
  gradient?: CanvasGradient;
  pulseSpeed: number;
  pulsePhase: number;
  sizeVariation: number;
}

interface BokehBackgroundProps {
  colors: ThemeColors;
  numParticles?: number;
}

// Convert rgb string to rgb object
const rgbStringToObj = (rgbStr: string) => {
  const match = rgbStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (match) {
    return {
      r: parseInt(match[1], 10),
      g: parseInt(match[2], 10),
      b: parseInt(match[3], 10)
    };
  }
  return { r: 255, g: 255, b: 255 };
};

export function BokehBackground({ colors, numParticles = 50 }: BokehBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const bgGradientRef = useRef<CanvasGradient | null>(null);
  const lastColorsRef = useRef<ThemeColors | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const transitionTimeRef = useRef<number>(0);

  // Detect color changes
  useEffect(() => {
    if (lastColorsRef.current && 
        (lastColorsRef.current.primary !== colors.primary || 
         lastColorsRef.current.accent !== colors.accent)) {
      setIsTransitioning(true);
      transitionTimeRef.current = 0;
      
      // Reset transition after animation completes
      setTimeout(() => {
        setIsTransitioning(false);
      }, 1500);
    }
    
    lastColorsRef.current = colors;
  }, [colors]);

  // Function to update particle colors
  const updateParticleColors = () => {
    if (!particlesRef.current.length) return;
    
    // Get color objects from current theme
    const backgroundRgb = rgbStringToObj(colors.background);
    const primaryRgb = rgbStringToObj(colors.primary);
    const secondaryRgb = rgbStringToObj(colors.secondary);
    const accentRgb = rgbStringToObj(colors.accent);
    
    // Brighten the background color for better visibility
    const brightenFactor = 1.5;
    const brightenedBackground = {
      r: Math.min(255, backgroundRgb.r * brightenFactor),
      g: Math.min(255, backgroundRgb.g * brightenFactor),
      b: Math.min(255, backgroundRgb.b * brightenFactor)
    };
    
    // Update colors of existing particles
    particlesRef.current.forEach((particle, index) => {
      // Distribute colors based on index for more controlled distribution
      const colorIndex = index % 10; // Use modulo to create repeating pattern
      
      if (colorIndex < 5) { // 50% background (most dominant)
        particle.color = brightenedBackground;
      } else if (colorIndex < 8) { // 30% primary
        particle.color = primaryRgb;
      } else if (colorIndex < 9) { // 10% accent
        particle.color = accentRgb;
      } else { // 10% secondary
        particle.color = secondaryRgb;
      }
      
      // Clear gradient to force recreation with new color
      particle.gradient = undefined;
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resizeCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      
      // Use window dimensions directly
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      
      // Scale the context to ensure correct drawing operations
      ctx.scale(dpr, dpr);
      
      // Set CSS size to match window
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;

      // Reset scale on resize to prevent cumulative scaling
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    };

    const createParticles = () => {
      particlesRef.current = Array.from({ length: numParticles }, () => {
        // Get a random color from the palette with weighted distribution
        const getRandomColor = () => {
          const colorWeights = [
            { color: colors.background, weight: 0.5 },  // 50% chance for background (most dominant)
            { color: colors.primary, weight: 0.3 },     // 30% chance for primary
            { color: colors.accent, weight: 0.1 },      // 10% chance for accent
            { color: colors.secondary, weight: 0.1 }    // 10% chance for secondary
          ];

          const rand = Math.random();
          let sum = 0;
          for (const { color, weight } of colorWeights) {
            sum += weight;
            if (rand < sum) return color;
          }
          return colors.background;
        };

        // Get random size with weighted distribution
        const getRandomSize = () => {
          const baseSize = Math.random() * 100 + 50; // 50-150 base size
          const sizeMultiplier = Math.random() < 0.3 ? 1.5 : 1; // 30% chance of larger particles
          return baseSize * sizeMultiplier;
        };

        const color = getRandomColor();
        const rgb = rgbStringToObj(color);
        
        // Enhance color vibrancy by boosting saturation
        const avgColor = (rgb.r + rgb.g + rgb.b) / 3;
        // Calculate color intensity to determine how much to boost saturation
        const colorIntensity = Math.sqrt(rgb.r * rgb.r + rgb.g * rgb.g + rgb.b * rgb.b) / 441.7; // 441.7 = sqrt(255^2 * 3)
        // Adaptive saturation boost - less boost for already vibrant colors
        const adaptiveSaturationBoost = 1 + Math.max(0.2, 0.8 - colorIntensity);
        
        // Apply saturation boost while maintaining average brightness
        const saturated = {
          r: Math.min(255, Math.max(0, avgColor + (rgb.r - avgColor) * adaptiveSaturationBoost)),
          g: Math.min(255, Math.max(0, avgColor + (rgb.g - avgColor) * adaptiveSaturationBoost)),
          b: Math.min(255, Math.max(0, avgColor + (rgb.b - avgColor) * adaptiveSaturationBoost))
        };
        
        // Brighten the color slightly for better visibility
        const brightenFactor = 1.2; // Reduced from 1.3
        const brightened = {
          r: Math.min(255, saturated.r * brightenFactor),
          g: Math.min(255, saturated.g * brightenFactor),
          b: Math.min(255, saturated.b * brightenFactor)
        };

        return {
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          size: getRandomSize(),
          color: brightened,
          speed: Math.random() * 0.03 + 0.01, // Slightly slower movement
          angle: Math.random() * Math.PI * 2,
          pulseSpeed: Math.random() * 0.02 + 0.005, // Speed of size pulsing
          pulsePhase: Math.random() * Math.PI * 2, // Random starting phase
          sizeVariation: Math.random() * 0.3 + 0.1 // Size variation factor (10-40%)
        };
      });
    };

    const animate = (timestamp: number) => {
      // Clear the entire canvas with transparent background
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Update transition time
      if (isTransitioning) {
        transitionTimeRef.current += 0.016; // Approximately 16ms per frame
      }
      
      // Draw base gradient background - optimize by creating once and reusing
      if (!bgGradientRef.current || isTransitioning) {
        bgGradientRef.current = ctx.createLinearGradient(0, 0, 0, canvas.height);
        const { r, g, b } = rgbStringToObj(colors.background);
        const primaryRgb = rgbStringToObj(colors.primary);
        const accentRgb = rgbStringToObj(colors.accent);
        
        // Create a more complex gradient with multiple color stops
        // Reduced opacity values for all stops
        bgGradientRef.current.addColorStop(0, `rgba(${r},${g},${b},0.4)`);
        bgGradientRef.current.addColorStop(0.3, `rgba(${r},${g},${b},0.3)`);
        bgGradientRef.current.addColorStop(0.7, `rgba(${r},${g},${b},0.2)`);
        bgGradientRef.current.addColorStop(0.85, `rgba(${primaryRgb.r},${primaryRgb.g},${primaryRgb.b},0.15)`);
        bgGradientRef.current.addColorStop(1, `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},0.05)`);
      }
      ctx.fillStyle = bgGradientRef.current;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Set base opacity with potential boost during transitions
      const baseOpacity = isTransitioning 
        ? 0.35 + Math.sin(transitionTimeRef.current * 3) * 0.15
        : 0.35;
      
      ctx.globalAlpha = baseOpacity;

      // Draw all particles
      particlesRef.current.forEach((particle, index) => {
        // Update position with smooth movement
        particle.x += Math.cos(particle.angle) * particle.speed;
        particle.y += Math.sin(particle.angle) * particle.speed;

        // Gradually change angle for more organic movement
        particle.angle += (Math.random() - 0.5) * 0.02;
        
        // Calculate size variation based on time for pulsing effect
        const pulseOffset = Math.sin(timestamp * 0.001 * particle.pulseSpeed + particle.pulsePhase);
        const sizeMultiplier = 1 + pulseOffset * particle.sizeVariation;
        
        // Apply additional effects during transitions
        const transitionBoost = isTransitioning 
          ? 1 + Math.sin(transitionTimeRef.current * 2 + index * 0.1) * 0.2
          : 1;
        
        const currentSize = particle.size * sizeMultiplier * transitionBoost;

        // Wrap around screen
        if (particle.x < -currentSize) particle.x = canvas.width + currentSize;
        if (particle.x > canvas.width + currentSize) particle.x = -currentSize;
        if (particle.y < -currentSize) particle.y = canvas.height + currentSize;
        if (particle.y > canvas.height + currentSize) particle.y = -currentSize;

        // Create and cache gradient for each particle
        // During transitions or when pulsing significantly, recreate the gradient
        if (!particle.gradient || isTransitioning || Math.abs(pulseOffset) > 0.7) {
          particle.gradient = ctx.createRadialGradient(
            particle.x,
            particle.y,
            0,
            particle.x,
            particle.y,
            currentSize
          );
          const { r, g, b } = particle.color;
          
          // Make gradient more intense during transitions
          const innerOpacity = isTransitioning ? 0.5 : 0.4;
          const midOpacity = isTransitioning ? 0.3 : 0.25;
          
          particle.gradient.addColorStop(0, `rgba(${r},${g},${b},${innerOpacity})`);
          particle.gradient.addColorStop(0.4, `rgba(${r},${g},${b},${midOpacity})`);
          particle.gradient.addColorStop(0.7, `rgba(${r},${g},${b},0.15)`);
          particle.gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
        }

        ctx.fillStyle = particle.gradient;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, currentSize, 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.globalAlpha = 1;
      // Request next frame
      animationFrameRef.current = requestAnimationFrame(animate);
    };

    // Initialize
    resizeCanvas();
    createParticles();
    animationFrameRef.current = requestAnimationFrame(animate);

    // Handle window resize
    const handleResize = () => {
      resizeCanvas();
      
      // Clear background gradient to force recreation with new dimensions
      bgGradientRef.current = null;
      
      // Update particle positions and clear their gradients
      particlesRef.current.forEach(particle => {
        if (particle.x > canvas.width) particle.x = canvas.width - particle.size;
        if (particle.y > canvas.height) particle.y = canvas.height - particle.size;
        particle.gradient = undefined; // Force gradient recreation with new position
      });
    };

    window.addEventListener('resize', handleResize);

    // Cleanup
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      window.removeEventListener('resize', handleResize);
    };
  }, [colors, numParticles, isTransitioning]);

  // Update particle colors when theme changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    // Update particle colors when theme changes
    if (particlesRef.current.length > 0) {
      updateParticleColors();
      
      // Clear background gradient to force recreation with new colors
      bgGradientRef.current = null;
    }
  }, [colors]);

  return (
    <motion.canvas
      ref={canvasRef}
      animate={{ 
        opacity: isTransitioning ? 0.9 : 0.8 
      }}
      transition={{ duration: 1.5 }}
      className="fixed inset-0 w-screen h-screen pointer-events-none"
      style={{ 
        mixBlendMode: 'lighten',
        zIndex: -1,
        minWidth: '100vw',
        minHeight: '100vh'
      }}
    />
  );
}
