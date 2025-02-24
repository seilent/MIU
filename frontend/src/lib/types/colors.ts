// Color types shared across the application
export interface ColorPalette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  alternateBackground: string;
}

export type RGB = [number, number, number];

export type HSL = [number, number, number];

export interface RGBColor {
  r: number;
  g: number;
  b: number;
}