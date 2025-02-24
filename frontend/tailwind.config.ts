import type { Config } from "tailwindcss";

const withOpacityValue = (variable: string) => {
  return `rgb(var(${variable}-rgb) / var(--tw-bg-opacity))`;
};

export default {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        theme: {
          primary: withOpacityValue('--color-primary'),
          secondary: withOpacityValue('--color-secondary'),
          accent: withOpacityValue('--color-accent'),
          background: withOpacityValue('--color-background'),
        },
      },
      backgroundColor: {
        theme: {
          primary: 'var(--color-primary)',
          secondary: 'var(--color-secondary)',
          accent: 'var(--color-accent)',
          background: 'var(--color-background)',
        },
      },
      textColor: {
        theme: {
          primary: 'var(--color-primary)',
          secondary: 'var(--color-secondary)',
          accent: 'var(--color-accent)',
        },
      },
      ringColor: {
        theme: {
          primary: 'rgba(var(--color-primary-rgb), <alpha-value>)',
          secondary: 'rgba(var(--color-secondary-rgb), <alpha-value>)',
          accent: 'rgba(var(--color-accent-rgb), <alpha-value>)',
        },
      },
      accentColor: {
        theme: {
          primary: 'rgba(var(--color-primary-rgb), <alpha-value>)',
          secondary: 'rgba(var(--color-secondary-rgb), <alpha-value>)',
          accent: 'rgba(var(--color-accent-rgb), <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
