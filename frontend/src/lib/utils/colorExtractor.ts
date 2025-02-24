export interface ColorPalette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface HSL {
  h: number;
  s: number;
  l: number;
}

function rgbToHex({ r, g, b }: RGB): string {
  return '#' + [r, g, b].map(x => {
    const hex = Math.round(x).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

function hexToRgb(hex: string): RGB {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 0, g: 0, b: 0 };
}

function rgbToHsl({ r, g, b }: RGB): HSL {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }

    h /= 6;
  }

  return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToRgb({ h, s, l }: HSL): RGB {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));

  return {
    r: 255 * f(0),
    g: 255 * f(8),
    b: 255 * f(4)
  };
}

function getColorContrast(color1: string, color2: string): number {
  const rgb1 = hexToRgb(color1);
  const rgb2 = hexToRgb(color2);
  
  const l1 = 0.2126 * rgb1.r + 0.7152 * rgb1.g + 0.0722 * rgb1.b;
  const l2 = 0.2126 * rgb2.r + 0.7152 * rgb2.g + 0.0722 * rgb2.b;
  
  const brightest = Math.max(l1, l2);
  const darkest = Math.min(l1, l2);
  
  return (brightest + 0.05) / (darkest + 0.05);
}

// Calculate color vibrance (saturation weighted by brightness)
function getColorVibrance(color: string): number {
  const hsl = rgbToHsl(hexToRgb(color));
  // Weight saturation by a brightness factor that peaks at 60% lightness
  const brightnessFactor = 1 - Math.abs(hsl.l - 60) / 60;
  return hsl.s * brightnessFactor;
}

// Calculate color warmth (red-yellow vs blue-green)
function getColorWarmth(rgb: RGB): number {
  // Warmth is higher when red and yellow components are stronger than blue and green
  return (rgb.r * 2 + rgb.g) / (rgb.b * 2 + rgb.g);
}

// Create a more vibrant version of a color
function vibrateColor(color: string, intensity: number = 1.0): string {
  const hsl = rgbToHsl(hexToRgb(color));
  
  // Boost saturation for more vibrant colors
  hsl.s = Math.min(100, hsl.s * (1 + 0.5 * intensity));
  
  // Adjust lightness to optimal range for vibrant appearance (40-60%)
  if (hsl.l < 40) {
    hsl.l = 40 + (40 - hsl.l) * 0.3;
  } else if (hsl.l > 60) {
    hsl.l = 60 - (hsl.l - 60) * 0.3;
  }
  
  return rgbToHex(hslToRgb(hsl));
}

// Create a harmonious color palette based on color theory
function createHarmoniousColor(baseColor: string, hueShift: number, saturationFactor: number, lightnessFactor: number): string {
  const hsl = rgbToHsl(hexToRgb(baseColor));
  
  // Apply hue shift with wrapping around 360 degrees
  hsl.h = (hsl.h + hueShift) % 360;
  
  // Apply saturation adjustment
  hsl.s = Math.max(0, Math.min(100, hsl.s * saturationFactor));
  
  // Apply lightness adjustment
  hsl.l = Math.max(0, Math.min(100, hsl.l * lightnessFactor));
  
  return rgbToHex(hslToRgb(hsl));
}

// Get the most vibrant colors from the image
function getMostVibrantColors(colorMap: Map<string, number>, count: number): string[] {
  // Convert to array and add vibrance score
  const colorEntries = Array.from(colorMap.entries())
    .map(([color, frequency]) => {
      const vibrance = getColorVibrance(color);
      const warmth = getColorWarmth(hexToRgb(color));
      // Score combines frequency, vibrance and a slight preference for warmer colors
      const score = frequency * (vibrance * 0.7 + warmth * 0.3);
      return { color, score };
    })
    .filter(entry => {
      const hsl = rgbToHsl(hexToRgb(entry.color));
      // Filter out colors that are too dark, too bright, or too unsaturated
      return hsl.l > 20 && hsl.l < 85 && hsl.s > 25;
    })
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.color)
    .slice(0, count);
    
  return colorEntries;
}

export async function extractColors(imageUrl: string): Promise<ColorPalette> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }

      // Scale down image for faster processing while maintaining aspect ratio
      const scale = Math.min(1, 250 / Math.max(img.width, img.height));
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;

      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const pixels = imageData.data;

      // Enhanced color quantization with better weighting
      const colorMap = new Map<string, number>();
      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const a = pixels[i + 3];
        
        if (a < 128) continue;

        // Improved color quantization with finer granularity
        const quantizedR = Math.round(r / 6) * 6;
        const quantizedG = Math.round(g / 6) * 6;
        const quantizedB = Math.round(b / 6) * 6;
        
        const hex = rgbToHex({ r: quantizedR, g: quantizedG, b: quantizedB });
        
        // Weight colors from the center and top third of the image more heavily
        // Album covers often have important colors in these regions
        const x = Math.floor((i / 4) % canvas.width);
        const y = Math.floor((i / 4) / canvas.width);
        
        // Distance from center horizontally
        const centerXWeight = 1 - Math.abs(x - canvas.width/2) / (canvas.width/2);
        // Distance from top third vertically (focus on upper part of image)
        const topThirdYWeight = 1 - Math.abs(y - canvas.height/3) / canvas.height;
        
        // Combined weight with emphasis on being close to center horizontally and in top third vertically
        const weight = (centerXWeight * 0.6 + topThirdYWeight * 0.4) + 0.2;
        
        colorMap.set(hex, (colorMap.get(hex) || 0) + weight);
      }

      // Get the most vibrant colors from the image
      const vibrantColors = getMostVibrantColors(colorMap, 4);
      
      // Fallback to default colors if we couldn't extract enough vibrant colors
      if (vibrantColors.length < 2) {
        resolve({
          primary: '#4f46e5',    // Indigo-600
          secondary: '#7c3aed',  // Violet-600
          accent: '#3b82f6',     // Blue-500
          background: '#1e293b'  // Slate-800
        });
        return;
      }

      // Extract primary color (most vibrant)
      const primary = vibrateColor(vibrantColors[0], 1.2);
      
      // Create secondary color - complementary or analogous based on image characteristics
      const primaryHsl = rgbToHsl(hexToRgb(primary));
      const colorSpread = vibrantColors.length >= 3 ? 
        Math.abs(rgbToHsl(hexToRgb(vibrantColors[0])).h - rgbToHsl(hexToRgb(vibrantColors[2])).h) : 0;
      
      // If the image has a wide color spread, use an analogous color scheme
      // Otherwise, use a complementary color for more contrast
      const hueShift = colorSpread > 60 ? 30 : 180;
      const secondary = createHarmoniousColor(primary, hueShift, 1.1, 0.9);
      
      // Create accent color - bright and attention-grabbing
      const accent = createHarmoniousColor(
        vibrantColors.length >= 2 ? vibrantColors[1] : primary, 
        -15, // Slight hue shift
        1.4,  // Higher saturation
        1.2   // Higher brightness
      );
      
      // Create background color - darker version of primary with reduced saturation
      const primaryRgb = hexToRgb(primary);
      const warmth = getColorWarmth(primaryRgb);
      
      // Adjust background darkness based on warmth of primary color
      // Warmer colors get slightly darker backgrounds
      const darknessLevel = warmth > 1.2 ? 0.22 : 0.28;
      
      let background = createHarmoniousColor(primary, 
        10,        // Slight hue shift
        0.6,       // Reduced saturation
        darknessLevel // Darker
      );
      
      // Ensure background is not too dark by setting a minimum brightness threshold
      const backgroundHsl = rgbToHsl(hexToRgb(background));
      if (backgroundHsl.l < 18) {
        background = createHarmoniousColor(background, 0, 1, 18 / backgroundHsl.l);
      }
      
      // Verify contrast ratios and adjust if needed
      const contrastWithBg = getColorContrast(primary, background);
      if (contrastWithBg < 4.5) {
        // If contrast is too low, darken the background more
        background = createHarmoniousColor(background, 0, 0.9, 0.8);
      }

      resolve({
        primary,
        secondary,
        accent,
        background
      });
    };

    img.onerror = () => {
      reject(new Error('Failed to load image'));
    };

    img.src = imageUrl;
  });
}
