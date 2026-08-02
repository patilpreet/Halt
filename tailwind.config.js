/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Ground
        bg: '#060606',
        'bg-2': '#0A0A0A',
        surface: '#0F0F0F',
        'surface-2': '#141414',
        'surface-3': '#1A1A1A',
        hair: '#1F1F1F',
        'hair-2': '#2A2A2A',

        // Type
        ink: '#FFFFFF',
        'ink-2': '#B5B5AE',
        'ink-muted': '#6E6E68',
        'ink-faint': '#3D3D3A',

        // Signal
        lime: {
          DEFAULT: '#C6F53C',
          bright: '#E9FF7A',
          hot: '#FCFF70',
          deep: '#7FA81E',
          dark: '#1A2408',
        },

        // Semantics
        ok: '#C6F53C',
        danger: '#FF4438',
        warn: '#FFB020',
        hold: '#FFC53D',
        info: '#5AD1FF',
      },
      fontFamily: {
        display: ['Archivo', 'system-ui', 'sans-serif'],
        sans: ['Outfit', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        panel: '0 12px 40px rgba(0,0,0,0.6)',
        'lime-glow': '0 0 40px -8px rgba(198,245,60,0.55)',
        'lime-glow-lg': '0 0 90px -10px rgba(198,245,60,0.65)',
        'danger-glow': '0 0 44px -8px rgba(255,68,56,0.6)',
        'inset-hair': 'inset 0 1px 0 rgba(255,255,255,0.05)',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
        spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
  },
  plugins: [],
}
