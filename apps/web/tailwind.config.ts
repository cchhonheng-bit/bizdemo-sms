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
      fontFamily: { sans: ["'Noto Sans Khmer'", "Inter", "system-ui", "sans-serif"], mono: ["'Liberation Mono'", "ui-monospace", "monospace"] },
      borderRadius: { sm: "6px", md: "10px", lg: "14px" },
      boxShadow: { card: "0 1px 2px rgba(20,30,70,.06)", drawer: "-10px 0 24px rgba(20,30,70,.08)" },
    },
  },
  plugins: [],
} satisfies Config;
