'use client';

import { useEffect, useRef } from 'react';
import { type ColorPalette } from '@/lib/utils/colorExtractor';

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
}

interface BokehBackgroundProps {
  colors: ColorPalette;
  numParticles?: number;
}

// Convert hex to rgb
const hexToRgb = (hex: string) => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 255, g: 255, b: 255 };
};

export function BokehBackground({ colors, numParticles = 50 }: BokehBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const bgGradientRef = useRef<CanvasGradient | null>(null);

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
            { color: colors.accent, weight: 0.4 },    // 40% chance for accent
            { color: colors.secondary, weight: 0.3 }, // 30% chance for secondary
            { color: colors.primary, weight: 0.3 }    // 30% chance for primary
          ];

          const rand = Math.random();
          let sum = 0;
          for (const { color, weight } of colorWeights) {
            sum += weight;
            if (rand < sum) return color;
          }
          return colors.accent;
        };

        // Get random size with weighted distribution
        const getRandomSize = () => {
          const baseSize = Math.random() * 100 + 50; // 50-150 base size
          const sizeMultiplier = Math.random() < 0.3 ? 1.5 : 1; // 30% chance of larger particles
          return baseSize * sizeMultiplier;
        };

        const color = getRandomColor();
        const rgb = hexToRgb(color);

        return {
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          size: getRandomSize(),
          color: rgb,
          speed: Math.random() * 0.03 + 0.01, // Slightly slower movement
          angle: Math.random() * Math.PI * 2
        };
      });
    };

    const animate = () => {
      // Clear the entire canvas with transparent background
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw base gradient background - optimize by creating once and reusing
      if (!bgGradientRef.current) {
        bgGradientRef.current = ctx.createLinearGradient(0, 0, 0, canvas.height);
        const { r, g, b } = hexToRgb(colors.background);
        bgGradientRef.current.addColorStop(0, `rgba(${r},${g},${b},0.2)`);
        bgGradientRef.current.addColorStop(1, `rgba(${r},${g},${b},0.1)`);
      }
      ctx.fillStyle = bgGradientRef.current;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.globalAlpha = 0.3;

      // Draw all particles
      particlesRef.current.forEach((particle) => {
        // Update position with smooth movement
        particle.x += Math.cos(particle.angle) * particle.speed;
        particle.y += Math.sin(particle.angle) * particle.speed;

        // Gradually change angle for more organic movement
        particle.angle += (Math.random() - 0.5) * 0.02;

        // Wrap around screen
        if (particle.x < -particle.size) particle.x = canvas.width + particle.size;
        if (particle.x > canvas.width + particle.size) particle.x = -particle.size;
        if (particle.y < -particle.size) particle.y = canvas.height + particle.size;
        if (particle.y > canvas.height + particle.size) particle.y = -particle.size;

        // Create and cache gradient for each particle
        if (!particle.gradient) {
          particle.gradient = ctx.createRadialGradient(
            particle.x,
            particle.y,
            0,
            particle.x,
            particle.y,
            particle.size
          );
          const { r, g, b } = particle.color;
          particle.gradient.addColorStop(0, `rgba(${r},${g},${b},0.3)`);
          particle.gradient.addColorStop(0.4, `rgba(${r},${g},${b},0.2)`);
          particle.gradient.addColorStop(0.7, `rgba(${r},${g},${b},0.1)`);
          particle.gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
        }

        ctx.fillStyle = particle.gradient;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.globalAlpha = 1;
      // Request next frame
      animationFrameRef.current = requestAnimationFrame(animate);
    };

    // Initialize
    resizeCanvas();
    createParticles();
    animate();

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
  }, [colors, numParticles]);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 w-screen h-screen pointer-events-none"
      style={{ 
        opacity: 0.6,
        mixBlendMode: 'screen',
        zIndex: -1,
        minWidth: '100vw',
        minHeight: '100vh'
      }}
    />
  );
}
