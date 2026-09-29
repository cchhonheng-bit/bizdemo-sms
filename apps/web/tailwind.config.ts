import type { Config } from "tailwindcss";

// Design tokens — UI Design v1 §1
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: { DEFAULT: "#2E3A78", 700: "#1F2A5C" },
        blue: { DEFAULT: "#2F5BD3", 50: "#E6EDFD" },
        grey: { DEFAULT: "#8A8B8F", line: "#E3E6EE", bg: "#F4F6FB" },
        ink: "#1B2033",
        muted: "#6B7280",
        success: { DEFAULT: "#12805C", 50: "#E3F5EC" },
        warning: { DEFAULT: "#B26A00", 50: "#FFF3DC" },
        danger: { DEFAULT: "#C2362F", 50: "#FDE8E7" },
        purple: { DEFAULT: "#6D4BD8", 50: "#EEE9FD" },
      },
      // Khmer needs taller lines than Latin (stacked vowels/subscripts): every size ≥ 1.6 (UI Design v1.1, D-66)
      fontSize: {
        xs: ["0.75rem", { lineHeight: "1.25rem" }], sm: ["0.875rem", { lineHeight: "1.4rem" }], base: ["1rem", { lineHeight: "1.6rem" }],
        lg: ["1.125rem", { lineHeight: "1.8rem" }], xl: ["1.25rem", { lineHeight: "2rem" }], "2xl": ["1.5rem", { lineHeight: "2.3rem" }],
      },
      fontFamily: { sans: ["'Noto Sans Khmer'", "Inter", "system-ui", "sans-serif"], mono: ["'Liberation Mono'", "ui-monospace", "monospace"] },
      borderRadius: { sm: "6px", md: "10px", lg: "14px" },
      boxShadow: { card: "0 1px 2px rgba(20,30,70,.06)", drawer: "-10px 0 24px rgba(20,30,70,.08)" },
    },
  },
  plugins: [],
} satisfies Config;
