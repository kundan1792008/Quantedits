/**
 * ColorGradingEngine — Professional Color Science Engine
 *
 * Features:
 *   - 20 LUT-style grade presets (Cinematic Teal/Orange, Vintage Warm, etc.)
 *   - GPU-accelerated color transform via WebGL fragment shader
 *   - Custom LUT generation from reference ImageData
 *   - Per-clip grading with cross-fade transitions
 *   - AI-driven automatic preset recommendation based on ColorDNA
 *
 * Architecture:
 *   The engine maintains a WebGL2 context on an offscreen canvas.
 *   Each grade is encoded as a 3D LUT (33×33×33 RGB cube stored as a
 *   2D strip texture) and applied in a single pass GLSL shader.
 *
 * Usage:
 * ```ts
 * const engine = new ColorGradingEngine();
 * await engine.init();
 * const graded = engine.applyGrade(sourceImageData, "cinematic_teal_orange");
 * ```
 */

import type { ColorDNA, SceneType } from "./ColorAnalyzer";

// ── LUT Constants ──────────────────────────────────────────────────────────

/** Side length of the 3D LUT cube (33 entries per axis = 33×33×33 = 35 937 cells). */
const LUT_SIZE = 33;

// ── Preset Definitions ─────────────────────────────────────────────────────

export type GradePresetId =
  | "neutral"
  | "cinematic_teal_orange"
  | "cinematic_silver"
  | "vintage_warm"
  | "vintage_faded"
  | "cold_nordic"
  | "neon_cyberpunk"
  | "documentary_natural"
  | "music_video_pop"
  | "golden_hour_boost"
  | "moody_noir"
  | "pastel_dream"
  | "bleach_bypass"
  | "cross_process"
  | "filmic_kodak"
  | "filmic_fuji"
  | "horror_cold"
  | "summer_blockbuster"
  | "indie_muted"
  | "tv_broadcast";

/** Human-readable metadata for each grade preset. */
export interface GradePreset {
  id: GradePresetId;
  label: string;
  description: string;
  /** HSL adjustments applied on top of the base LUT for fine-tuning. */
  adjustments: GradeAdjustments;
  /** CSS-safe thumbnail gradient for gallery display. */
  thumbnailGradient: string;
  /** Tags used for recommendation matching. */
  tags: string[];
}

/** Per-clip color adjustments that parametrize the grade. */
export interface GradeAdjustments {
  /** Exposure shift in EV (−3 … +3). */
  exposure: number;
  /** Contrast multiplier (0 = flat, 1 = original, 2 = doubled). */
  contrast: number;
  /** Saturation multiplier (0 = greyscale, 1 = original, 2 = doubled). */
  saturation: number;
  /** Vibrance — boosts muted colors more than already-saturated ones (−1 … +1). */
  vibrance: number;
  /** Colour temperature shift in Kelvin (−2000 … +2000). */
  temperatureShift: number;
  /** Green–magenta tint shift (−0.5 … +0.5). */
  tintShift: number;
  /** Shadows lift (0 = no change, lifted = milky blacks). */
  shadowLift: number;
  /** Highlight roll-off (0 = no change, compressed = soft whites). */
  highlightRolloff: number;
  /** HSL hue rotation per hue band [red, orange, yellow, green, cyan, blue, purple] (degrees). */
  hueRotations: [number, number, number, number, number, number, number];
  /** Per-band saturation multipliers matching hueRotations order. */
  hueSaturation: [number, number, number, number, number, number, number];
  /** Shadows color cast: [r, g, b] in −1 … +1. */
  shadowTint: [number, number, number];
  /** Midtone color cast: [r, g, b] in −1 … +1. */
  midtoneTint: [number, number, number];
  /** Highlight color cast: [r, g, b] in −1 … +1. */
  highlightTint: [number, number, number];
  /** Tone curve control points for luma channel: [[input, output], ...]. */
  lumaCurve: Array<[number, number]>;
}

/** Default neutral adjustments — no change. */
const NEUTRAL_ADJUSTMENTS: GradeAdjustments = {
  exposure: 0,
  contrast: 1,
  saturation: 1,
  vibrance: 0,
  temperatureShift: 0,
  tintShift: 0,
  shadowLift: 0,
  highlightRolloff: 0,
  hueRotations: [0, 0, 0, 0, 0, 0, 0],
  hueSaturation: [1, 1, 1, 1, 1, 1, 1],
  shadowTint: [0, 0, 0],
  midtoneTint: [0, 0, 0],
  highlightTint: [0, 0, 0],
  lumaCurve: [[0, 0], [0.25, 0.22], [0.5, 0.5], [0.75, 0.78], [1, 1]],
};

/** All 20 grade presets. */
export const GRADE_PRESETS: Record<GradePresetId, GradePreset> = {
  neutral: {
    id: "neutral",
    label: "Neutral",
    description: "No color grade — original footage colors.",
    adjustments: NEUTRAL_ADJUSTMENTS,
    thumbnailGradient: "linear-gradient(135deg, #888 0%, #ccc 100%)",
    tags: ["neutral", "raw", "ungraded"],
  },

  cinematic_teal_orange: {
    id: "cinematic_teal_orange",
    label: "Cinematic Teal/Orange",
    description: "Hollywood blockbuster look. Warm skin tones, teal shadows.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      contrast: 1.15,
      saturation: 1.1,
      vibrance: 0.15,
      shadowTint: [-0.05, 0.08, 0.12],
      midtoneTint: [0.04, 0.0, -0.03],
      highlightTint: [0.1, 0.04, -0.08],
      hueRotations: [5, 8, 0, -12, -15, -10, 0],
      hueSaturation: [1.2, 1.3, 0.9, 0.8, 1.4, 1.2, 1.0],
      lumaCurve: [[0, 0.02], [0.25, 0.2], [0.5, 0.5], [0.75, 0.81], [1, 0.97]],
    },
    thumbnailGradient: "linear-gradient(135deg, #1a4a5a 0%, #e8832a 100%)",
    tags: ["cinematic", "blockbuster", "warm", "teal", "orange", "hollywood"],
  },

  cinematic_silver: {
    id: "cinematic_silver",
    label: "Cinematic Silver",
    description: "Desaturated, high-contrast silver-lux look for prestige dramas.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      contrast: 1.25,
      saturation: 0.65,
      shadowTint: [0.02, 0.02, 0.06],
      highlightTint: [0.06, 0.05, 0.04],
      shadowLift: 0.04,
      lumaCurve: [[0, 0.03], [0.15, 0.12], [0.5, 0.5], [0.85, 0.9], [1, 0.96]],
    },
    thumbnailGradient: "linear-gradient(135deg, #1a1a2e 0%, #c8c8d8 100%)",
    tags: ["cinematic", "drama", "silver", "desaturated", "prestige"],
  },

  vintage_warm: {
    id: "vintage_warm",
    label: "Vintage Warm",
    description: "70s film emulation with lifted blacks and warm highlights.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      contrast: 0.88,
      saturation: 0.85,
      temperatureShift: 800,
      shadowLift: 0.08,
      highlightRolloff: 0.06,
      shadowTint: [0.08, 0.04, -0.02],
      highlightTint: [0.1, 0.06, -0.04],
      hueRotations: [8, 12, 15, 0, 0, 0, 0],
      hueSaturation: [1.1, 1.25, 1.15, 0.85, 0.8, 0.75, 0.9],
      lumaCurve: [[0, 0.08], [0.3, 0.28], [0.6, 0.58], [0.85, 0.82], [1, 0.92]],
    },
    thumbnailGradient: "linear-gradient(135deg, #7a4a20 0%, #e8c87a 100%)",
    tags: ["vintage", "retro", "70s", "warm", "film", "nostalgic"],
  },

  vintage_faded: {
    id: "vintage_faded",
    label: "Vintage Faded",
    description: "Washed-out film look with muted palette and heavy shadow lift.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      contrast: 0.78,
      saturation: 0.7,
      vibrance: -0.1,
      shadowLift: 0.12,
      highlightRolloff: 0.1,
      shadowTint: [0.06, 0.05, 0.02],
      temperatureShift: 500,
      lumaCurve: [[0, 0.12], [0.25, 0.28], [0.5, 0.5], [0.75, 0.72], [1, 0.88]],
    },
    thumbnailGradient: "linear-gradient(135deg, #8a7a6a 0%, #d8c8a8 100%)",
    tags: ["vintage", "faded", "washed", "film", "nostalgic", "muted"],
  },

  cold_nordic: {
    id: "cold_nordic",
    label: "Cold Nordic",
    description: "Scandinavian desaturated cool look with teal-blue shadows.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      contrast: 1.1,
      saturation: 0.75,
      temperatureShift: -900,
      shadowTint: [-0.04, 0.0, 0.1],
      highlightTint: [0.0, 0.02, 0.06],
      hueRotations: [0, 0, 0, 5, 8, 10, 0],
      hueSaturation: [0.8, 0.7, 0.7, 0.9, 1.3, 1.4, 0.8],
      lumaCurve: [[0, 0.01], [0.25, 0.22], [0.5, 0.5], [0.75, 0.79], [1, 0.98]],
    },
    thumbnailGradient: "linear-gradient(135deg, #0a2040 0%, #a8c8e8 100%)",
    tags: ["cold", "nordic", "cool", "teal", "blue", "scandinavian", "minimal"],
  },

  neon_cyberpunk: {
    id: "neon_cyberpunk",
    label: "Neon Cyberpunk",
    description: "Hyper-saturated neon with deep crushed blacks and cyan/magenta split.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      contrast: 1.35,
      saturation: 1.8,
      vibrance: 0.4,
      shadowTint: [-0.1, -0.05, 0.2],
      highlightTint: [0.15, -0.05, 0.2],
      midtoneTint: [-0.08, 0.0, 0.12],
      hueRotations: [-10, 5, 0, 8, -5, 15, -12],
      hueSaturation: [1.6, 1.4, 1.2, 1.5, 2.0, 2.2, 1.8],
      lumaCurve: [[0, 0.0], [0.2, 0.15], [0.5, 0.5], [0.8, 0.88], [1, 1.0]],
    },
    thumbnailGradient: "linear-gradient(135deg, #0a0015 0%, #ff00ff 50%, #00ffff 100%)",
    tags: ["cyberpunk", "neon", "sci-fi", "saturated", "futuristic", "night"],
  },

  documentary_natural: {
    id: "documentary_natural",
    label: "Documentary Natural",
    description: "Clean, true-to-life colors with gentle contrast. Perfect for factual content.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      contrast: 1.05,
      saturation: 0.95,
      vibrance: 0.05,
      lumaCurve: [[0, 0.01], [0.25, 0.24], [0.5, 0.5], [0.75, 0.76], [1, 0.99]],
    },
    thumbnailGradient: "linear-gradient(135deg, #2a4a2a 0%, #d8e8c8 100%)",
    tags: ["documentary", "natural", "neutral", "clean", "factual", "journalism"],
  },

  music_video_pop: {
    id: "music_video_pop",
    label: "Music Video Pop",
    description: "Bold, saturated pop colors. High energy for music videos.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      contrast: 1.2,
      saturation: 1.6,
      vibrance: 0.3,
      shadowTint: [0.02, -0.05, 0.08],
      highlightTint: [0.08, 0.04, -0.06],
      hueRotations: [5, 10, 8, -8, -5, 8, 5],
      hueSaturation: [1.4, 1.5, 1.3, 1.4, 1.3, 1.5, 1.4],
      lumaCurve: [[0, 0.01], [0.25, 0.21], [0.5, 0.5], [0.75, 0.82], [1, 0.99]],
    },
    thumbnailGradient: "linear-gradient(135deg, #8800ff 0%, #ff0080 50%, #ffcc00 100%)",
    tags: ["music", "pop", "saturated", "vibrant", "energetic", "bold"],
  },

  golden_hour_boost: {
    id: "golden_hour_boost",
    label: "Golden Hour Boost",
    description: "Enhances sunset/sunrise warmth. Amplifies amber tones.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      contrast: 1.08,
      saturation: 1.2,
      vibrance: 0.25,
      temperatureShift: 600,
      shadowTint: [0.05, 0.02, -0.06],
      highlightTint: [0.12, 0.06, -0.1],
      hueRotations: [10, 20, 15, 0, 0, -5, 0],
      hueSaturation: [1.3, 1.6, 1.4, 0.9, 0.8, 0.85, 1.0],
      lumaCurve: [[0, 0.01], [0.3, 0.27], [0.6, 0.62], [0.85, 0.88], [1, 0.97]],
    },
    thumbnailGradient: "linear-gradient(135deg, #8a2a00 0%, #ffaa00 60%, #ffe080 100%)",
    tags: ["golden hour", "sunset", "sunrise", "warm", "amber", "outdoor"],
  },

  moody_noir: {
    id: "moody_noir",
    label: "Moody Noir",
    description: "Dark, contrasty, desaturated. Deep blacks with cool blue undertones.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      exposure: -0.3,
      contrast: 1.4,
      saturation: 0.55,
      shadowTint: [-0.02, -0.01, 0.08],
      temperatureShift: -400,
      lumaCurve: [[0, 0.0], [0.2, 0.1], [0.5, 0.48], [0.8, 0.82], [1, 0.95]],
    },
    thumbnailGradient: "linear-gradient(135deg, #050510 0%, #1a2a3a 60%, #3a4a5a 100%)",
    tags: ["noir", "moody", "dark", "dramatic", "thriller", "contrast"],
  },

  pastel_dream: {
    id: "pastel_dream",
    label: "Pastel Dream",
    description: "Soft, airy pastel tones. Lifted shadows, gentle haze.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      contrast: 0.82,
      saturation: 0.75,
      vibrance: -0.15,
      shadowLift: 0.15,
      highlightRolloff: 0.08,
      shadowTint: [0.05, 0.04, 0.06],
      highlightTint: [0.08, 0.06, 0.1],
      lumaCurve: [[0, 0.15], [0.25, 0.3], [0.5, 0.55], [0.75, 0.76], [1, 0.9]],
    },
    thumbnailGradient: "linear-gradient(135deg, #d8b8d8 0%, #e8d8f8 50%, #b8e8f0 100%)",
    tags: ["pastel", "soft", "airy", "dreamy", "light", "romantic"],
  },

  bleach_bypass: {
    id: "bleach_bypass",
    label: "Bleach Bypass",
    description: "Photochemical film technique: desaturated, gritty, high contrast.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      contrast: 1.45,
      saturation: 0.45,
      shadowLift: 0.02,
      lumaCurve: [[0, 0.0], [0.15, 0.08], [0.5, 0.5], [0.85, 0.92], [1, 1.0]],
    },
    thumbnailGradient: "linear-gradient(135deg, #0a0a0a 0%, #6a6a6a 50%, #e8e8e8 100%)",
    tags: ["bleach bypass", "film", "gritty", "desaturated", "high contrast"],
  },

  cross_process: {
    id: "cross_process",
    label: "Cross Process",
    description: "Analogue cross-processing effect with oversaturated shadows and split tones.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      contrast: 1.3,
      saturation: 1.35,
      shadowTint: [-0.1, 0.12, -0.05],
      highlightTint: [0.08, -0.08, 0.15],
      hueRotations: [12, 8, -10, 15, -8, -12, 10],
      hueSaturation: [1.5, 1.3, 1.4, 1.6, 1.3, 1.7, 1.4],
      lumaCurve: [[0, 0.02], [0.2, 0.14], [0.5, 0.52], [0.8, 0.88], [1, 0.98]],
    },
    thumbnailGradient: "linear-gradient(135deg, #1a0a4a 0%, #00cc88 50%, #ffcc00 100%)",
    tags: ["cross process", "analogue", "experimental", "split tone", "vintage"],
  },

  filmic_kodak: {
    id: "filmic_kodak",
    label: "Filmic Kodak",
    description: "Emulates Kodak Vision3 film stock — warm midtones, rich shadows.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      contrast: 1.08,
      saturation: 0.92,
      vibrance: 0.1,
      temperatureShift: 350,
      shadowTint: [0.04, 0.02, -0.03],
      midtoneTint: [0.02, 0.0, -0.01],
      highlightTint: [0.06, 0.03, -0.04],
      hueRotations: [5, 8, 3, -3, -5, -2, 0],
      hueSaturation: [1.15, 1.2, 1.05, 0.95, 0.9, 0.85, 1.0],
      lumaCurve: [[0, 0.02], [0.25, 0.23], [0.5, 0.5], [0.75, 0.78], [1, 0.96]],
    },
    thumbnailGradient: "linear-gradient(135deg, #3a1a00 0%, #c88040 50%, #f8e0b0 100%)",
    tags: ["kodak", "film", "cinematic", "warm", "rich", "emulation"],
  },

  filmic_fuji: {
    id: "filmic_fuji",
    label: "Filmic Fuji",
    description: "Emulates Fuji Provia/Velvia — vivid greens, neutral skin, crisp blues.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      contrast: 1.12,
      saturation: 1.1,
      vibrance: 0.15,
      temperatureShift: -200,
      shadowTint: [-0.02, 0.02, 0.04],
      hueRotations: [-3, 0, -5, 10, 5, 8, 0],
      hueSaturation: [1.0, 1.1, 1.05, 1.4, 1.3, 1.35, 0.95],
      lumaCurve: [[0, 0.01], [0.25, 0.23], [0.5, 0.5], [0.75, 0.78], [1, 0.98]],
    },
    thumbnailGradient: "linear-gradient(135deg, #1a3a1a 0%, #4a9a4a 50%, #80c8f0 100%)",
    tags: ["fuji", "film", "vivid", "green", "blue", "emulation"],
  },

  horror_cold: {
    id: "horror_cold",
    label: "Horror Cold",
    description: "Icy desaturated palette with heavy blue-green shadows. Unsettling feel.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      exposure: -0.2,
      contrast: 1.3,
      saturation: 0.6,
      temperatureShift: -1200,
      shadowTint: [-0.06, 0.08, 0.06],
      highlightTint: [-0.02, 0.04, 0.08],
      lumaCurve: [[0, 0.0], [0.2, 0.12], [0.5, 0.47], [0.8, 0.84], [1, 0.96]],
    },
    thumbnailGradient: "linear-gradient(135deg, #000a0a 0%, #002a2a 50%, #004a50 100%)",
    tags: ["horror", "cold", "desaturated", "dark", "icy", "thriller"],
  },

  summer_blockbuster: {
    id: "summer_blockbuster",
    label: "Summer Blockbuster",
    description: "Bright, punchy, high-energy. Sky blues and sun golds with boosted contrast.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      contrast: 1.18,
      saturation: 1.25,
      vibrance: 0.25,
      temperatureShift: 200,
      shadowTint: [-0.02, 0.0, 0.05],
      highlightTint: [0.06, 0.04, -0.04],
      hueRotations: [3, 5, 5, -5, -8, 8, 0],
      hueSaturation: [1.2, 1.3, 1.15, 1.1, 1.4, 1.45, 1.1],
      lumaCurve: [[0, 0.01], [0.25, 0.2], [0.5, 0.5], [0.75, 0.82], [1, 0.99]],
    },
    thumbnailGradient: "linear-gradient(135deg, #003080 0%, #0080ff 40%, #ffcc00 80%, #ff8000 100%)",
    tags: ["blockbuster", "summer", "bright", "action", "high energy", "sky"],
  },

  indie_muted: {
    id: "indie_muted",
    label: "Indie Muted",
    description: "Low-key, desaturated indie film aesthetic. Earthy tones, soft contrast.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      contrast: 0.9,
      saturation: 0.72,
      vibrance: -0.05,
      shadowLift: 0.06,
      temperatureShift: 150,
      shadowTint: [0.03, 0.02, 0.0],
      lumaCurve: [[0, 0.06], [0.25, 0.24], [0.5, 0.5], [0.75, 0.74], [1, 0.94]],
    },
    thumbnailGradient: "linear-gradient(135deg, #2a2015 0%, #8a7a60 50%, #c8b890 100%)",
    tags: ["indie", "muted", "earthy", "desaturated", "film", "arthouse"],
  },

  tv_broadcast: {
    id: "tv_broadcast",
    label: "TV Broadcast",
    description: "Broadcast-safe color with clean naturals and accurate skin tones.",
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      contrast: 1.02,
      saturation: 0.9,
      temperatureShift: 100,
      lumaCurve: [[0, 0.04], [0.25, 0.24], [0.5, 0.5], [0.75, 0.76], [1, 0.94]],
    },
    thumbnailGradient: "linear-gradient(135deg, #1a2a3a 0%, #6a9abf 50%, #d8e8f0 100%)",
    tags: ["broadcast", "tv", "natural", "clean", "news", "corporate"],
  },
};

export const ALL_PRESET_IDS = Object.keys(GRADE_PRESETS) as GradePresetId[];

// ── Scene → Preset Recommendation ─────────────────────────────────────────

/** Map from SceneType to recommended GradePresetId. */
const SCENE_RECOMMENDATIONS: Record<SceneType, GradePresetId> = {
  outdoor_day:          "documentary_natural",
  outdoor_golden_hour:  "golden_hour_boost",
  outdoor_blue_hour:    "cold_nordic",
  outdoor_night:        "neon_cyberpunk",
  indoor_warm:          "vintage_warm",
  indoor_cool:          "cinematic_silver",
  indoor_neutral:       "cinematic_teal_orange",
  overcast:             "cold_nordic",
  studio:               "tv_broadcast",
  unknown:              "neutral",
};

/**
 * Recommend the best preset for given ColorDNA.
 * Returns up to `count` suggestions ordered by relevance.
 */
export function recommendPresets(dna: ColorDNA, count = 3): GradePresetId[] {
  const primary = SCENE_RECOMMENDATIONS[dna.sceneType];
  const all = ALL_PRESET_IDS.filter((id) => id !== primary);

  // Score each remaining preset heuristically against the DNA
  const scored = all.map((id) => {
    const p = GRADE_PRESETS[id];
    let score = 0;

    // Prefer warmer presets for warm footage
    if (dna.colorTemperature < 4500 && p.tags.includes("warm")) score += 2;
    if (dna.colorTemperature > 6500 && p.tags.includes("cool")) score += 2;

    // Prefer cinematic for high grading potential
    if (dna.gradingPotential > 0.6 && p.tags.includes("cinematic")) score += 1;

    // Night footage → darker dramatic grades
    if (dna.exposureEV < -1 && (p.tags.includes("dark") || p.tags.includes("noir"))) score += 2;

    // Flat footage → punchy grades
    if (dna.contrast < 0.1 && (p.tags.includes("high contrast") || p.tags.includes("blockbuster"))) score += 1;

    return { id, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = [primary, ...scored.slice(0, count - 1).map((s) => s.id)] as GradePresetId[];
  return top.slice(0, count);
}

// ── WebGL Shader ───────────────────────────────────────────────────────────

const VERTEX_SHADER_SRC = /* glsl */ `#version 300 es
precision highp float;
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER_SRC = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_source;
uniform sampler2D u_lut;   // 2D strip encoding of 3D LUT
uniform float u_lutSize;   // e.g. 33.0
uniform float u_exposure;  // EV offset
uniform float u_contrast;
uniform float u_saturation;
uniform float u_vibrance;
uniform vec3  u_shadowTint;
uniform vec3  u_midtoneTint;
uniform vec3  u_highlightTint;
uniform float u_shadowLift;
uniform float u_highlightRolloff;
uniform float u_temperatureShift; // normalised −1…+1
uniform float u_tintShift;

in vec2 v_uv;
out vec4 fragColor;

// sRGB → linear
float toLinear(float c) {
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}
vec3 toLinear3(vec3 c) {
  return vec3(toLinear(c.r), toLinear(c.g), toLinear(c.b));
}

// linear → sRGB
float toSRGB(float c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
vec3 toSRGB3(vec3 c) {
  return vec3(toSRGB(c.r), toSRGB(c.g), toSRGB(c.b));
}

// Luma (BT.709)
float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// 3D LUT lookup (packed as horizontal strip in 2D texture)
vec3 sampleLUT(vec3 color) {
  float n  = u_lutSize - 1.0;
  float bSlice = floor(color.b * n);
  float bFrac  = color.b * n - bSlice;

  vec2 uv0, uv1;
  uv0.x = (color.r * n + 0.5 + bSlice * u_lutSize) / (u_lutSize * u_lutSize);
  uv0.y = (color.g * n + 0.5) / u_lutSize;
  uv1.x = (color.r * n + 0.5 + (bSlice + 1.0) * u_lutSize) / (u_lutSize * u_lutSize);
  uv1.y = uv0.y;

  vec3 c0 = texture(u_lut, uv0).rgb;
  vec3 c1 = texture(u_lut, uv1).rgb;
  return mix(c0, c1, bFrac);
}

void main() {
  vec4 src = texture(u_source, v_uv);
  vec3 c = src.rgb;

  // Exposure
  float evScale = pow(2.0, u_exposure);
  c *= evScale;

  // Contrast (pivot at 0.5)
  c = (c - 0.5) * u_contrast + 0.5;

  // Shadow lift + highlight roll-off
  c = mix(vec3(u_shadowLift), vec3(1.0 - u_highlightRolloff), c);

  // Saturation
  float y = luma(c);
  c = mix(vec3(y), c, u_saturation);

  // Vibrance (selective saturation boost for muted colors)
  float maxC = max(c.r, max(c.g, c.b));
  float minC = min(c.r, min(c.g, c.b));
  float sat  = (maxC - minC) / (maxC + 1e-5);
  float vibranceBoost = u_vibrance * (1.0 - sat);
  c = mix(vec3(y), c, 1.0 + vibranceBoost);

  // Temperature shift (simplified: tilt R↔B)
  c.r += u_temperatureShift * 0.1;
  c.b -= u_temperatureShift * 0.1;

  // Tint shift (G channel)
  c.g += u_tintShift * 0.05;

  // 3-way color wheels
  float lumaV = luma(c);
  float shadowW    = clamp(1.0 - lumaV * 4.0, 0.0, 1.0);
  float highlightW = clamp((lumaV - 0.75) * 4.0, 0.0, 1.0);
  float midtoneW   = 1.0 - shadowW - highlightW;

  c += shadowW    * u_shadowTint;
  c += midtoneW   * u_midtoneTint;
  c += highlightW * u_highlightTint;

  // Clamp before LUT
  c = clamp(c, 0.0, 1.0);

  // 3D LUT
  c = sampleLUT(c);

  fragColor = vec4(clamp(c, 0.0, 1.0), src.a);
}`;

// ── LUT Generation ─────────────────────────────────────────────────────────

/** Generate an identity 3D LUT packed as a Float32Array (RGBA, size³ cells). */
export function generateIdentityLUT(size: number): Float32Array {
  const data = new Float32Array(size * size * size * 4);
  let idx = 0;
  const n = size - 1;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        data[idx++] = r / n;
        data[idx++] = g / n;
        data[idx++] = b / n;
        data[idx++] = 1.0;
      }
    }
  }
  return data;
}

/**
 * Apply GradeAdjustments to an identity LUT to produce a baked preset LUT.
 * The LUT is stored as a 2D strip texture (size² × size).
 */
function bakeAdjustmentsToLUT(adjustments: GradeAdjustments, size: number): Float32Array {
  const n = size - 1;
  const data = new Float32Array(size * size * size * 4);
  let idx = 0;

  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        let rv = r / n;
        let gv = g / n;
        let bv = b / n;

        // Exposure
        const ev = Math.pow(2.0, adjustments.exposure);
        rv *= ev; gv *= ev; bv *= ev;

        // Contrast
        rv = (rv - 0.5) * adjustments.contrast + 0.5;
        gv = (gv - 0.5) * adjustments.contrast + 0.5;
        bv = (bv - 0.5) * adjustments.contrast + 0.5;

        // Shadow lift / highlight rolloff
        rv = adjustments.shadowLift + (1 - adjustments.highlightRolloff - adjustments.shadowLift) * rv;
        gv = adjustments.shadowLift + (1 - adjustments.highlightRolloff - adjustments.shadowLift) * gv;
        bv = adjustments.shadowLift + (1 - adjustments.highlightRolloff - adjustments.shadowLift) * bv;

        // Saturation
        const lumaV = 0.2126 * rv + 0.7152 * gv + 0.0722 * bv;
        rv = lumaV + (rv - lumaV) * adjustments.saturation;
        gv = lumaV + (gv - lumaV) * adjustments.saturation;
        bv = lumaV + (bv - lumaV) * adjustments.saturation;

        // Vibrance
        const maxC = Math.max(rv, gv, bv);
        const minC = Math.min(rv, gv, bv);
        const sat = (maxC - minC) / (maxC + 1e-5);
        const vibranceBoost = adjustments.vibrance * (1.0 - sat);
        rv = lumaV + (rv - lumaV) * (1 + vibranceBoost);
        gv = lumaV + (gv - lumaV) * (1 + vibranceBoost);
        bv = lumaV + (bv - lumaV) * (1 + vibranceBoost);

        // Temperature shift (normalised to ±1 then scaled)
        const tempNorm = adjustments.temperatureShift / 2000;
        rv += tempNorm * 0.1;
        bv -= tempNorm * 0.1;
        gv += adjustments.tintShift * 0.05;

        // 3-way color wheels
        const lv = Math.max(0, 0.2126 * rv + 0.7152 * gv + 0.0722 * bv);
        const sW = Math.max(0, Math.min(1, 1 - lv * 4));
        const hW = Math.max(0, Math.min(1, (lv - 0.75) * 4));
        const mW = Math.max(0, 1 - sW - hW);

        rv += sW * adjustments.shadowTint[0] + mW * adjustments.midtoneTint[0] + hW * adjustments.highlightTint[0];
        gv += sW * adjustments.shadowTint[1] + mW * adjustments.midtoneTint[1] + hW * adjustments.highlightTint[1];
        bv += sW * adjustments.shadowTint[2] + mW * adjustments.midtoneTint[2] + hW * adjustments.highlightTint[2];

        // Luma curve (simple 5-point linear interpolation)
        const lumaFinal = Math.max(0, Math.min(1, 0.2126 * rv + 0.7152 * gv + 0.0722 * bv));
        const mappedLuma = applyLumaCurve(lumaFinal, adjustments.lumaCurve);
        const lumaScale = lumaFinal > 1e-6 ? mappedLuma / lumaFinal : 1;
        rv *= lumaScale; gv *= lumaScale; bv *= lumaScale;

        data[idx++] = Math.max(0, Math.min(1, rv));
        data[idx++] = Math.max(0, Math.min(1, gv));
        data[idx++] = Math.max(0, Math.min(1, bv));
        data[idx++] = 1.0;
      }
    }
  }
  return data;
}

/** Linearly interpolate a value through a set of [input, output] control points. */
function applyLumaCurve(x: number, curve: Array<[number, number]>): number {
  if (curve.length === 0) return x;
  const sorted = [...curve].sort((a, b) => a[0] - b[0]);
  if (x <= sorted[0][0]) return sorted[0][1];
  if (x >= sorted[sorted.length - 1][0]) return sorted[sorted.length - 1][1];
  for (let i = 0; i < sorted.length - 1; i++) {
    if (x <= sorted[i + 1][0]) {
      const t = (x - sorted[i][0]) / (sorted[i + 1][0] - sorted[i][0]);
      return sorted[i][1] + t * (sorted[i + 1][1] - sorted[i][1]);
    }
  }
  return x;
}

// ── Custom LUT from Reference ──────────────────────────────────────────────

/**
 * Build a custom grade LUT that matches the color profile of a reference image.
 * Uses histogram matching per channel to map source → reference distribution.
 */
export function buildReferenceLUT(
  sourceImageData: ImageData,
  referenceImageData: ImageData,
  size: number = LUT_SIZE,
): Float32Array {
  // Build per-channel CDFs for source and reference
  const srcHist = buildChannelHistograms(sourceImageData);
  const refHist = buildChannelHistograms(referenceImageData);

  const srcCDF = { r: cdf(srcHist.r), g: cdf(srcHist.g), b: cdf(srcHist.b) };
  const refCDF = { r: cdf(refHist.r), g: cdf(refHist.g), b: cdf(refHist.b) };

  // Build inverse CDF for reference (mapping 0-1 probability → pixel value)
  const refInvCDF = {
    r: invertCDF(refCDF.r),
    g: invertCDF(refCDF.g),
    b: invertCDF(refCDF.b),
  };

  const data = new Float32Array(size * size * size * 4);
  const n = size - 1;
  let idx = 0;

  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const ri = Math.round((r / n) * 255);
        const gi = Math.round((g / n) * 255);
        const bi = Math.round((b / n) * 255);

        const mapped_r = refInvCDF.r[Math.round(srcCDF.r[ri] * 255)] / 255;
        const mapped_g = refInvCDF.g[Math.round(srcCDF.g[gi] * 255)] / 255;
        const mapped_b = refInvCDF.b[Math.round(srcCDF.b[bi] * 255)] / 255;

        data[idx++] = Math.max(0, Math.min(1, mapped_r));
        data[idx++] = Math.max(0, Math.min(1, mapped_g));
        data[idx++] = Math.max(0, Math.min(1, mapped_b));
        data[idx++] = 1.0;
      }
    }
  }

  return data;
}

function buildChannelHistograms(img: ImageData): { r: Uint32Array; g: Uint32Array; b: Uint32Array } {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  for (let i = 0; i < img.data.length; i += 4) {
    r[img.data[i]]++;
    g[img.data[i + 1]]++;
    b[img.data[i + 2]]++;
  }
  return { r, g, b };
}

function cdf(hist: Uint32Array): Float32Array {
  const out = new Float32Array(256);
  let total = 0;
  for (let i = 0; i < 256; i++) total += hist[i];
  let cumulative = 0;
  for (let i = 0; i < 256; i++) {
    cumulative += hist[i];
    out[i] = total > 0 ? cumulative / total : i / 255;
  }
  return out;
}

function invertCDF(cdfArr: Float32Array): Uint8Array {
  const out = new Uint8Array(256);
  for (let p = 0; p < 256; p++) {
    const target = p / 255;
    let best = 0;
    let bestDiff = Infinity;
    for (let v = 0; v < 256; v++) {
      const diff = Math.abs(cdfArr[v] - target);
      if (diff < bestDiff) { bestDiff = diff; best = v; }
    }
    out[p] = best;
  }
  return out;
}

// ── WebGL Engine ───────────────────────────────────────────────────────────

/** WebGL state for a single grading pass. */
interface WebGLState {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  sourceTexture: WebGLTexture;
  lutTexture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  outputTexture: WebGLTexture;
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("[ColorGradingEngine] Failed to create shader.");
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`[ColorGradingEngine] Shader compile error:\n${log}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vert = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
  const program = gl.createProgram();
  if (!program) throw new Error("[ColorGradingEngine] Failed to create program.");
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    throw new Error(`[ColorGradingEngine] Program link error:\n${log}`);
  }
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  return program;
}

// ── ClipGradeConfig ────────────────────────────────────────────────────────

/** Grading configuration attached to a single timeline clip. */
export interface ClipGradeConfig {
  clipId: string;
  presetId: GradePresetId;
  /** Override specific adjustments on top of the preset (optional). */
  overrides?: Partial<GradeAdjustments>;
  /** 0–1 blend strength of this grade. */
  intensity: number;
  /** If true, apply grade from the auto-recommendation based on ColorDNA. */
  autoRecommended: boolean;
}

/** Cross-fade transition data between two grade configs. */
export interface GradeTransition {
  fromClipId: string;
  toClipId: string;
  durationSec: number;
  /** Progress 0→1 during the transition. */
  progress: number;
}

// ── Main Engine Class ──────────────────────────────────────────────────────

/**
 * ColorGradingEngine manages WebGL-accelerated color grading.
 *
 * Lifecycle:
 * ```ts
 * const engine = new ColorGradingEngine();
 * await engine.init();
 * const output = engine.applyGrade(imageData, "cinematic_teal_orange");
 * engine.dispose();
 * ```
 */
export class ColorGradingEngine {
  private canvas: HTMLCanvasElement | null = null;
  private state: WebGLState | null = null;
  private lutCache = new Map<string, Float32Array>();
  private clipConfigs = new Map<string, ClipGradeConfig>();
  private transitions: GradeTransition[] = [];
  private initialized = false;

  /** Initialize the WebGL context and compile the grading shader. */
  async init(): Promise<void> {
    if (this.initialized) return;

    if (typeof document === "undefined") {
      // SSR: skip WebGL init
      this.initialized = true;
      return;
    }

    this.canvas = document.createElement("canvas");
    this.canvas.width = 1;
    this.canvas.height = 1;

    const gl = this.canvas.getContext("webgl2");
    if (!gl) throw new Error("[ColorGradingEngine] WebGL2 not supported in this environment.");

    const program = createProgram(gl);

    // Fullscreen quad
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const posLoc = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Create textures (content uploaded per-call)
    const sourceTexture = gl.createTexture()!;
    const lutTexture = gl.createTexture()!;
    const outputTexture = gl.createTexture()!;
    const framebuffer = gl.createFramebuffer()!;

    this.state = { gl, program, vao, sourceTexture, lutTexture, framebuffer, outputTexture };
    this.initialized = true;

    // Pre-bake LUTs for all presets
    for (const id of ALL_PRESET_IDS) {
      this.bakeLUT(id);
    }
  }

  /** Release all WebGL resources. */
  dispose(): void {
    if (!this.state) return;
    const { gl, program, vao, sourceTexture, lutTexture, framebuffer, outputTexture } = this.state;
    gl.deleteProgram(program);
    gl.deleteVertexArray(vao);
    gl.deleteTexture(sourceTexture);
    gl.deleteTexture(lutTexture);
    gl.deleteTexture(outputTexture);
    gl.deleteFramebuffer(framebuffer);
    this.state = null;
    this.initialized = false;
  }

  // ── Public grading API ──────────────────────────────────────────────────

  /**
   * Apply a named grade preset to an ImageData frame.
   * Returns a new ImageData with the grade applied.
   */
  applyGrade(
    source: ImageData,
    presetId: GradePresetId,
    intensityOverride?: number,
  ): ImageData {
    if (!this.state) {
      return this.applyGradeCPU(source, presetId);
    }

    const lut = this.getLUT(presetId);
    return this.renderWithWebGL(source, lut, GRADE_PRESETS[presetId].adjustments, intensityOverride ?? 1.0);
  }

  /**
   * Apply a custom LUT built from a reference image.
   */
  applyCustomLUT(source: ImageData, lutData: Float32Array): ImageData {
    if (!this.state) {
      return source; // fallback: no-op
    }
    // Use neutral adjustments since the LUT encodes all transformations
    return this.renderWithWebGL(source, lutData, NEUTRAL_ADJUSTMENTS, 1.0);
  }

  /**
   * Grade a clip by its registered config, blending with transition if active.
   */
  applyClipGrade(source: ImageData, clipId: string): ImageData {
    const config = this.clipConfigs.get(clipId);
    if (!config) return source;

    const adj = this.mergeAdjustments(config.presetId, config.overrides);
    const lut = this.getLUT(config.presetId);

    // Check for active transition
    const transition = this.transitions.find(
      (t) => t.toClipId === clipId || t.fromClipId === clipId,
    );

    if (transition) {
      const otherClipId = transition.fromClipId === clipId ? transition.toClipId : transition.fromClipId;
      const otherConfig = this.clipConfigs.get(otherClipId);
      if (otherConfig) {
        const blendFactor = transition.fromClipId === clipId
          ? 1 - transition.progress
          : transition.progress;
        const from = this.renderWithWebGL(source, lut, adj, config.intensity);
        const otherAdj = this.mergeAdjustments(otherConfig.presetId, otherConfig.overrides);
        const otherLUT = this.getLUT(otherConfig.presetId);
        const to = this.renderWithWebGL(source, otherLUT, otherAdj, otherConfig.intensity);
        return blendImageData(from, to, blendFactor);
      }
    }

    return this.renderWithWebGL(source, lut, adj, config.intensity);
  }

  // ── Clip config management ─────────────────────────────────────────────

  /** Register a grade configuration for a timeline clip. */
  setClipGrade(config: ClipGradeConfig): void {
    this.clipConfigs.set(config.clipId, config);
  }

  /** Remove the grade configuration for a clip. */
  clearClipGrade(clipId: string): void {
    this.clipConfigs.delete(clipId);
  }

  /** Get the current grade config for a clip. */
  getClipGrade(clipId: string): ClipGradeConfig | undefined {
    return this.clipConfigs.get(clipId);
  }

  /** Register a cross-fade transition between two clips. */
  addTransition(transition: GradeTransition): void {
    this.transitions = this.transitions.filter(
      (t) => !(t.fromClipId === transition.fromClipId && t.toClipId === transition.toClipId),
    );
    this.transitions.push(transition);
  }

  /** Update transition progress (called by playback engine each frame). */
  updateTransitionProgress(fromClipId: string, toClipId: string, progress: number): void {
    const t = this.transitions.find((t) => t.fromClipId === fromClipId && t.toClipId === toClipId);
    if (t) t.progress = Math.max(0, Math.min(1, progress));
  }

  /** Remove a completed transition. */
  removeTransition(fromClipId: string, toClipId: string): void {
    this.transitions = this.transitions.filter(
      (t) => !(t.fromClipId === fromClipId && t.toClipId === toClipId),
    );
  }

  // ── LUT management ─────────────────────────────────────────────────────

  /** Pre-bake and cache a preset LUT. */
  bakeLUT(presetId: GradePresetId): Float32Array {
    if (this.lutCache.has(presetId)) return this.lutCache.get(presetId)!;
    const lut = bakeAdjustmentsToLUT(GRADE_PRESETS[presetId].adjustments, LUT_SIZE);
    this.lutCache.set(presetId, lut);
    return lut;
  }

  /** Get a cached LUT (or bake on demand). */
  getLUT(presetId: GradePresetId): Float32Array {
    return this.lutCache.get(presetId) ?? this.bakeLUT(presetId);
  }

  /** Cache a custom LUT under a user-defined key. */
  cacheCustomLUT(key: string, lut: Float32Array): void {
    this.lutCache.set(key, lut);
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private mergeAdjustments(
    presetId: GradePresetId,
    overrides?: Partial<GradeAdjustments>,
  ): GradeAdjustments {
    const base = GRADE_PRESETS[presetId].adjustments;
    if (!overrides) return base;
    return { ...base, ...overrides };
  }

  private renderWithWebGL(
    source: ImageData,
    lut: Float32Array,
    adjustments: GradeAdjustments,
    intensity: number,
  ): ImageData {
    const state = this.state;
    if (!state) return source;
    const { gl, program, vao, sourceTexture, lutTexture, framebuffer, outputTexture } = state;
    const W = source.width;
    const H = source.height;

    // Resize canvas if needed
    if (this.canvas!.width !== W || this.canvas!.height !== H) {
      this.canvas!.width = W;
      this.canvas!.height = H;
    }

    gl.viewport(0, 0, W, H);

    // Upload source texture
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.data);

    // Upload LUT texture (packed as 2D strip: LUT_SIZE² wide × LUT_SIZE tall)
    const lutW = LUT_SIZE * LUT_SIZE;
    const lutH = LUT_SIZE;
    const lutRGBA = new Uint8Array(lutW * lutH * 4);
    for (let i = 0; i < LUT_SIZE * LUT_SIZE * LUT_SIZE; i++) {
      lutRGBA[i * 4 + 0] = Math.round(lut[i * 4 + 0] * 255);
      lutRGBA[i * 4 + 1] = Math.round(lut[i * 4 + 1] * 255);
      lutRGBA[i * 4 + 2] = Math.round(lut[i * 4 + 2] * 255);
      lutRGBA[i * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, lutTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, lutW, lutH, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutRGBA);

    // Setup framebuffer with output texture
    gl.bindTexture(gl.TEXTURE_2D, outputTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputTexture, 0);

    // Draw
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    gl.uniform1i(gl.getUniformLocation(program, "u_source"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lutTexture);
    gl.uniform1i(gl.getUniformLocation(program, "u_lut"), 1);
    gl.uniform1f(gl.getUniformLocation(program, "u_lutSize"), LUT_SIZE);
    gl.uniform1f(gl.getUniformLocation(program, "u_exposure"), adjustments.exposure);
    gl.uniform1f(gl.getUniformLocation(program, "u_contrast"), adjustments.contrast);
    gl.uniform1f(gl.getUniformLocation(program, "u_saturation"), adjustments.saturation * intensity + (1 - intensity));
    gl.uniform1f(gl.getUniformLocation(program, "u_vibrance"), adjustments.vibrance * intensity);
    gl.uniform3fv(gl.getUniformLocation(program, "u_shadowTint"),
      adjustments.shadowTint.map((v) => v * intensity));
    gl.uniform3fv(gl.getUniformLocation(program, "u_midtoneTint"),
      adjustments.midtoneTint.map((v) => v * intensity));
    gl.uniform3fv(gl.getUniformLocation(program, "u_highlightTint"),
      adjustments.highlightTint.map((v) => v * intensity));
    gl.uniform1f(gl.getUniformLocation(program, "u_shadowLift"),
      adjustments.shadowLift * intensity);
    gl.uniform1f(gl.getUniformLocation(program, "u_highlightRolloff"),
      adjustments.highlightRolloff * intensity);
    gl.uniform1f(gl.getUniformLocation(program, "u_temperatureShift"),
      (adjustments.temperatureShift / 2000) * intensity);
    gl.uniform1f(gl.getUniformLocation(program, "u_tintShift"),
      adjustments.tintShift * intensity);

    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    // Read back pixels
    const output = new Uint8ClampedArray(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, output);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Blend with source based on intensity
    if (intensity < 1.0) {
      for (let i = 0; i < output.length; i += 4) {
        output[i + 0] = Math.round(source.data[i + 0] * (1 - intensity) + output[i + 0] * intensity);
        output[i + 1] = Math.round(source.data[i + 1] * (1 - intensity) + output[i + 1] * intensity);
        output[i + 2] = Math.round(source.data[i + 2] * (1 - intensity) + output[i + 2] * intensity);
        output[i + 3] = source.data[i + 3];
      }
    }

    return new ImageData(output, W, H);
  }

  /** CPU fallback when WebGL is unavailable. */
  private applyGradeCPU(source: ImageData, presetId: GradePresetId): ImageData {
    const adj = GRADE_PRESETS[presetId].adjustments;
    const output = new Uint8ClampedArray(source.data.length);
    const ev = Math.pow(2, adj.exposure);

    for (let i = 0; i < source.data.length; i += 4) {
      let r = source.data[i] / 255;
      let g = source.data[i + 1] / 255;
      let b = source.data[i + 2] / 255;

      // Exposure
      r *= ev; g *= ev; b *= ev;
      // Contrast
      r = (r - 0.5) * adj.contrast + 0.5;
      g = (g - 0.5) * adj.contrast + 0.5;
      b = (b - 0.5) * adj.contrast + 0.5;
      // Saturation
      const lv = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = lv + (r - lv) * adj.saturation;
      g = lv + (g - lv) * adj.saturation;
      b = lv + (b - lv) * adj.saturation;

      output[i + 0] = Math.round(Math.max(0, Math.min(1, r)) * 255);
      output[i + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255);
      output[i + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255);
      output[i + 3] = source.data[i + 3];
    }

    return new ImageData(output, source.width, source.height);
  }
}

/** Alpha-blend two ImageData objects. */
function blendImageData(a: ImageData, b: ImageData, t: number): ImageData {
  const out = new Uint8ClampedArray(a.data.length);
  for (let i = 0; i < a.data.length; i++) {
    out[i] = Math.round(a.data[i] * (1 - t) + b.data[i] * t);
  }
  return new ImageData(out, a.width, a.height);
}

/** Singleton engine instance. */
export const colorGradingEngine = new ColorGradingEngine();
