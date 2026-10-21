import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#0d1117", soft: "#161b22", line: "#272e38" },
        paper: { DEFAULT: "#fbfaf8", card: "#ffffff", line: "#e7e3dc" },
        saffron: { 50: "#fff7ed", 100: "#ffedd5", 400: "#fb923c", 500: "#f97316", 600: "#ea580c", 700: "#c2410c" },
        teal: { 50: "#f0fdfa", 400: "#2dd4bf", 500: "#14b8a6", 600: "#0d9488", 700: "#0f766e" },
        danger: { 50: "#fef2f2", 400: "#f87171", 500: "#ef4444", 600: "#dc2626", 700: "#b91c1c" },
        warn: { 50: "#fffbeb", 400: "#fbbf24", 500: "#f59e0b", 600: "#d97706" },
      },
      fontFamily: {
        sans: ["Instrument Sans", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      keyframes: {
        "fade-up": { from: { opacity: "0", transform: "translateY(6px)" }, to: { opacity: "1", transform: "none" } },
        "pulse-ring": { "0%": { boxShadow: "0 0 0 0 rgba(249,115,22,.45)" }, "100%": { boxShadow: "0 0 0 12px rgba(249,115,22,0)" } },
      },
      animation: { "fade-up": "fade-up .25s ease-out both", "pulse-ring": "pulse-ring 1.6s ease-out infinite" },
    },
  },
  plugins: [],
} satisfies Config;
