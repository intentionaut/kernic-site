export interface VibePreset {
  id: string;
  label: string;
  description: string;
  primarySeed: string;
  accentSeed: string;
  dark: boolean;
  radius: string;
  typeRatio: number;
  headingFont: string;
  bodyFont: string;
  monoFont: string;
}

export const VIBES: VibePreset[] = [
  {
    id: "retro", label: "Retro", description: "70s warmth, 80s neon. Analog soul.",
    primarySeed: "#e07a3f", accentSeed: "#946b2d", dark: false,
    radius: "soft", typeRatio: 1.333,
    headingFont: "DM Serif Display", bodyFont: "Karla", monoFont: "Space Mono",
  },
  {
    id: "tech", label: "Tech", description: "Electric, precise, built at night.",
    primarySeed: "#22d3ee", accentSeed: "#8b5cf6", dark: true,
    radius: "sharp", typeRatio: 1.25,
    headingFont: "Space Grotesk", bodyFont: "Inter", monoFont: "JetBrains Mono",
  },
  {
    id: "corporate", label: "Corporate", description: "Trustworthy, crisp, ship-safe.",
    primarySeed: "#2563eb", accentSeed: "#0ea5e9", dark: false,
    radius: "soft", typeRatio: 1.25,
    headingFont: "Inter", bodyFont: "Inter", monoFont: "IBM Plex Mono",
  },
  {
    id: "neon", label: "Neon", description: "Gradient-fueled fintech polish. Stripe energy.",
    primarySeed: "#635bff", accentSeed: "#00d4ff", dark: true,
    radius: "soft", typeRatio: 1.25,
    headingFont: "Inter", bodyFont: "Inter", monoFont: "JetBrains Mono",
  },
  {
    id: "minimal", label: "Minimal", description: "Restraint as a design decision.",
    primarySeed: "#18181b", accentSeed: "#a1a1aa", dark: false,
    radius: "soft", typeRatio: 1.125,
    headingFont: "Inter", bodyFont: "Inter", monoFont: "JetBrains Mono",
  },
  {
    id: "soft-pastel", label: "Soft Pastel", description: "Gentle, friendly, rounded.",
    primarySeed: "#b8a7f5", accentSeed: "#7dd3fc", dark: false,
    radius: "round", typeRatio: 1.2,
    headingFont: "Quicksand", bodyFont: "Nunito Sans", monoFont: "Fira Code",
  },
  {
    id: "fun", label: "Fun", description: "Crayon-bright solids. Few colors, all joy.",
    primarySeed: "#ff1493", accentSeed: "#00cfff", dark: false,
    radius: "pill", typeRatio: 1.333,
    headingFont: "Baloo 2", bodyFont: "Fredoka", monoFont: "Nunito",
  },
  {
    id: "earthy", label: "Earthy / Organic", description: "Terracotta, sage, cream.",
    primarySeed: "#c2703d", accentSeed: "#7d9b76", dark: false,
    radius: "soft", typeRatio: 1.25,
    headingFont: "Fraunces", bodyFont: "Source Sans 3", monoFont: "Courier Prime",
  },
];
