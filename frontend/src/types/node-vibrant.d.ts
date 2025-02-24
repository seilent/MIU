declare module 'node-vibrant/browser' {
  interface Color {
    hex: string;
    rgb: [number, number, number];
    hsl: [number, number, number];
    population: number;
  }

  interface Palette {
    Vibrant?: Color;
    Muted?: Color;
    DarkVibrant?: Color;
    DarkMuted?: Color;
    LightVibrant?: Color;
    LightMuted?: Color;
  }

  class Vibrant {
    static from(src: string | HTMLImageElement): Vibrant;
    getPalette(): Promise<Palette>;
  }

  export { Vibrant, Palette, Color };
} 