/**
 * Template FOMO Service
 * ─────────────────────
 *
 * Issue #14:
 *
 *   "New AI templates every 6 hours.  'New trending template: Cyberpunk
 *    Glitch Intro. 847 creators used it today.'  FOMO."
 *
 * This service is responsible for:
 *
 *   • Rotating a pool of AI-generated templates so there is always a fresh
 *     one on the home screen.
 *   • Picking the "currently trending" template based on the current
 *     6-hour slot of the day.
 *   • Fabricating a plausible "N creators used it today" counter that
 *     climbs throughout the slot and gives the UI its FOMO copy.
 *   • Scheduling a push notification at every 6-hour boundary announcing
 *     the new trending template.
 *
 * The template catalogue is intentionally large (24+ entries) so we can
 * rotate through a full week without repeating.
 */

import {
  pushNotificationService,
  type PushNotificationService,
  type CreationNotification,
} from "./PushNotifications";

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;

export type TemplateAesthetic =
  | "cyberpunk"
  | "vintage-film"
  | "minimal"
  | "horror"
  | "anime"
  | "high-fashion"
  | "pastel-lofi"
  | "retro-arcade"
  | "brutalist"
  | "dreamcore";

export interface CreationTemplate {
  id: string;
  name: string;
  tagline: string;
  aesthetic: TemplateAesthetic;
  /** Gradient CSS that the UI can render as a thumbnail. */
  gradient: string;
  /** Emoji used as a visual anchor in the trending card. */
  glyph: string;
  /** Heuristic base-line of daily adopters (scaled per-slot). */
  baseAdopters: number;
}

/** Catalogue of ~24 hand-curated templates. */
const TEMPLATES: CreationTemplate[] = [
  {
    id: "cyberpunk-glitch-intro",
    name: "Cyberpunk Glitch Intro",
    tagline: "RGB-split letters and neon rain — straight out of 2077.",
    aesthetic: "cyberpunk",
    gradient: "linear-gradient(135deg,#ff006e,#8338ec,#3a86ff)",
    glyph: "⚡",
    baseAdopters: 847,
  },
  {
    id: "vhs-memory-2002",
    name: "VHS Memory — 2002",
    tagline: "Chromatic aberration, tape flicker and a timestamp overlay.",
    aesthetic: "vintage-film",
    gradient: "linear-gradient(135deg,#8e8e8e,#d1b894,#4f4636)",
    glyph: "📼",
    baseAdopters: 612,
  },
  {
    id: "pastel-lofi-day",
    name: "Pastel Lo-Fi Day",
    tagline: "Warm pastels, grain, and a soft 120bpm beat.",
    aesthetic: "pastel-lofi",
    gradient: "linear-gradient(135deg,#ffd6a5,#fdffb6,#caffbf)",
    glyph: "🎧",
    baseAdopters: 523,
  },
  {
    id: "anime-speedline-punch",
    name: "Anime Speedline Punch",
    tagline: "Shōnen speedlines, freeze-frame POW and Japanese kanji title.",
    aesthetic: "anime",
    gradient: "linear-gradient(135deg,#ff4d6d,#ffd166,#06d6a0)",
    glyph: "💥",
    baseAdopters: 701,
  },
  {
    id: "brutalist-mono-cut",
    name: "Brutalist Mono Cut",
    tagline: "Hard-cut black, Helvetica, and a blinking red dot.",
    aesthetic: "brutalist",
    gradient: "linear-gradient(135deg,#000000,#1a1a1a,#e63946)",
    glyph: "■",
    baseAdopters: 298,
  },
  {
    id: "dreamcore-soft-liminal",
    name: "Dreamcore Soft Liminal",
    tagline: "Soft blurs, pale blues, surreal captions.",
    aesthetic: "dreamcore",
    gradient: "linear-gradient(135deg,#cddafd,#fff1e6,#a2d2ff)",
    glyph: "🌙",
    baseAdopters: 341,
  },
  {
    id: "horror-found-footage",
    name: "Horror Found-Footage",
    tagline: "Handheld shake, chroma noise, and a red REC dot.",
    aesthetic: "horror",
    gradient: "linear-gradient(135deg,#0a0a0a,#3a0f0f,#8d0000)",
    glyph: "🎥",
    baseAdopters: 420,
  },
  {
    id: "fashion-editorial-2046",
    name: "Fashion Editorial 2046",
    tagline: "Sharp contrast, serif titles and slow push-ins.",
    aesthetic: "high-fashion",
    gradient: "linear-gradient(135deg,#000,#6d6875,#e5989b)",
    glyph: "👠",
    baseAdopters: 378,
  },
  {
    id: "minimal-white-bloom",
    name: "Minimal White Bloom",
    tagline: "Generous white space and a 70% bloom pass.",
    aesthetic: "minimal",
    gradient: "linear-gradient(135deg,#ffffff,#f3f3f3,#e2e2e2)",
    glyph: "◌",
    baseAdopters: 265,
  },
  {
    id: "retro-arcade-8bit",
    name: "Retro Arcade 8-bit",
    tagline: "Pixel overlay, CRT scanlines and a chiptune riser.",
    aesthetic: "retro-arcade",
    gradient: "linear-gradient(135deg,#2b2d42,#8d99ae,#ef233c)",
    glyph: "🕹️",
    baseAdopters: 512,
  },
  {
    id: "cinematic-anamorphic-2-39",
    name: "Cinematic Anamorphic 2.39",
    tagline: "Black bars, blue lens-flares, 0.7× slow-mo.",
    aesthetic: "high-fashion",
    gradient: "linear-gradient(135deg,#000,#141e30,#243b55)",
    glyph: "🎬",
    baseAdopters: 611,
  },
  {
    id: "cyberpunk-neon-karaoke",
    name: "Cyberpunk Neon Karaoke",
    tagline: "Word-by-word lyric captions with magenta glow.",
    aesthetic: "cyberpunk",
    gradient: "linear-gradient(135deg,#240046,#5a189a,#f72585)",
    glyph: "🎤",
    baseAdopters: 458,
  },
  {
    id: "pastel-lofi-sunset",
    name: "Pastel Lo-Fi Sunset",
    tagline: "Peach-to-lavender grade, 7% grain and slow crossfades.",
    aesthetic: "pastel-lofi",
    gradient: "linear-gradient(135deg,#ffafbd,#ffc3a0,#ffafbd)",
    glyph: "🌅",
    baseAdopters: 389,
  },
  {
    id: "anime-sakura-rain",
    name: "Anime Sakura Rain",
    tagline: "Falling blossom particles and a chorus of wind chimes.",
    aesthetic: "anime",
    gradient: "linear-gradient(135deg,#ffc8dd,#cdb4db,#bde0fe)",
    glyph: "🌸",
    baseAdopters: 487,
  },
  {
    id: "brutalist-typo-riot",
    name: "Brutalist Typo Riot",
    tagline: "Oversized type marching across the frame at 120fps.",
    aesthetic: "brutalist",
    gradient: "linear-gradient(135deg,#1b1b1b,#f1faee,#1b1b1b)",
    glyph: "Ⓐ",
    baseAdopters: 231,
  },
  {
    id: "dreamcore-vhs-memory",
    name: "Dreamcore VHS Memory",
    tagline: "Washed VHS + dreamy reverb — nostalgic but unfamiliar.",
    aesthetic: "dreamcore",
    gradient: "linear-gradient(135deg,#bde0fe,#ffc8dd,#cdb4db)",
    glyph: "🫧",
    baseAdopters: 354,
  },
  {
    id: "horror-sleepwalker",
    name: "Horror Sleepwalker",
    tagline: "Creeping zoom, low-frequency rumble, pale-skin LUT.",
    aesthetic: "horror",
    gradient: "linear-gradient(135deg,#1b1b1b,#3c096c,#000)",
    glyph: "🕯️",
    baseAdopters: 308,
  },
  {
    id: "minimal-monowire",
    name: "Minimal Monowire",
    tagline: "Single-line frame, 1px titles and a long sustain hum.",
    aesthetic: "minimal",
    gradient: "linear-gradient(135deg,#f8f9fa,#dee2e6,#adb5bd)",
    glyph: "│",
    baseAdopters: 201,
  },
  {
    id: "retro-arcade-boss-drop",
    name: "Retro Arcade Boss Drop",
    tagline: "Scanline punch-in, red warning overlay, boss-theme sting.",
    aesthetic: "retro-arcade",
    gradient: "linear-gradient(135deg,#02010a,#3a015c,#ff006e)",
    glyph: "👾",
    baseAdopters: 376,
  },
  {
    id: "fashion-silk-reveal",
    name: "Fashion Silk Reveal",
    tagline: "Slow shutter, silk-like wipes, ambient strings.",
    aesthetic: "high-fashion",
    gradient: "linear-gradient(135deg,#ede0d4,#ddb892,#7f5539)",
    glyph: "🧵",
    baseAdopters: 289,
  },
  {
    id: "cyberpunk-rainy-alley",
    name: "Cyberpunk Rainy Alley",
    tagline: "Rainy-window bokeh, magenta haze and kanji subtitles.",
    aesthetic: "cyberpunk",
    gradient: "linear-gradient(135deg,#0d0221,#261447,#ff3864)",
    glyph: "🌧️",
    baseAdopters: 419,
  },
  {
    id: "vintage-super8-home",
    name: "Vintage Super-8 Home",
    tagline: "Hand-cranked flicker, warm fade and reel-burn edges.",
    aesthetic: "vintage-film",
    gradient: "linear-gradient(135deg,#c79a6a,#efd9b4,#826644)",
    glyph: "🎞️",
    baseAdopters: 340,
  },
  {
    id: "anime-training-arc",
    name: "Anime Training Arc",
    tagline: "Speed ramps, glow-ups, and 'POWER UP' captions.",
    aesthetic: "anime",
    gradient: "linear-gradient(135deg,#f77f00,#fcbf49,#d62828)",
    glyph: "💪",
    baseAdopters: 553,
  },
  {
    id: "dreamcore-soft-static",
    name: "Dreamcore Soft Static",
    tagline: "Milky blurs, soft static, and whispered titles.",
    aesthetic: "dreamcore",
    gradient: "linear-gradient(135deg,#ccd5ae,#e9edc9,#fefae0)",
    glyph: "☁️",
    baseAdopters: 275,
  },
];

// ── Slot math ────────────────────────────────────────────────────────────

/**
 * Deterministic, time-based rotation: given a UNIX ms timestamp, return
 * the index into the TEMPLATES array for the current 6-hour slot.
 */
export function slotIndexFor(ms: number): number {
  const slot = Math.floor(ms / SIX_HOURS_MS);
  // Large prime ensures we spread slots across the catalogue without
  // obvious periodic alignment with day boundaries.
  const hashed = Math.abs(Math.imul(slot, 0x9e3779b1)) >>> 0;
  return hashed % TEMPLATES.length;
}

/** When does the next slot begin (UNIX ms)? */
export function nextSlotBoundary(ms: number): number {
  return (Math.floor(ms / SIX_HOURS_MS) + 1) * SIX_HOURS_MS;
}

// ── Adopter counter ──────────────────────────────────────────────────────

/**
 * Fabricates a plausible "X creators used it today" count that climbs
 * during the slot.  The counter is:
 *
 *   • base + ramp·elapsedFraction²  (fast early growth, long tail)
 *   • Jittered by a hash so the UI feels like a live feed.
 */
function adoptersForSlot(
  template: CreationTemplate,
  slotStartMs: number,
  now: number,
): number {
  const elapsed = Math.max(0, Math.min(1, (now - slotStartMs) / SIX_HOURS_MS));
  const ramp = template.baseAdopters * 2.2;
  const growth = template.baseAdopters * (0.2 + 0.8 * elapsed * elapsed);
  const jitter = 1 + 0.08 * Math.sin((slotStartMs / 1_000_000) + elapsed * 13);
  return Math.round((growth + ramp * elapsed) * jitter);
}

// ── Trending accessor ────────────────────────────────────────────────────

export interface TrendingInfo {
  template: CreationTemplate;
  /** Unix ms the current slot started. */
  slotStartMs: number;
  /** Unix ms the current slot ends. */
  slotEndMs: number;
  /** Number of "creators" who used the template in the current slot. */
  adoptersToday: number;
  /** Slot-rank (0 = current, 1 = next, etc.). */
  slotIndex: number;
  /** Pre-formatted headline for the UI. */
  headline: string;
}

export function getTrending(now: number = Date.now()): TrendingInfo {
  const idx = slotIndexFor(now);
  const template = TEMPLATES[idx];
  const slotEndMs = nextSlotBoundary(now);
  const slotStartMs = slotEndMs - SIX_HOURS_MS;
  const adoptersToday = adoptersForSlot(template, slotStartMs, now);
  return {
    template,
    slotStartMs,
    slotEndMs,
    adoptersToday,
    slotIndex: idx,
    headline: `New trending template: ${template.name}. ${adoptersToday.toLocaleString()} creators used it today.`,
  };
}

/** Look ahead to the next trending template (used to hint "coming soon"). */
export function getUpcoming(now: number = Date.now()): TrendingInfo {
  const boundary = nextSlotBoundary(now);
  const idx = slotIndexFor(boundary);
  const template = TEMPLATES[idx];
  const slotStartMs = boundary;
  const slotEndMs = boundary + SIX_HOURS_MS;
  return {
    template,
    slotStartMs,
    slotEndMs,
    adoptersToday: template.baseAdopters,
    slotIndex: idx,
    headline: `Up next: ${template.name} drops in ${formatDuration(boundary - now)}.`,
  };
}

// ── Orchestrator ─────────────────────────────────────────────────────────

export interface TemplateFOMOOptions {
  push?: PushNotificationService;
  now?: () => number;
}

export class TemplateFOMOService {
  private push: PushNotificationService;
  private nowFn: () => number;
  private scheduledSlotEnd: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(trending: TrendingInfo) => void>();

  constructor(options: TemplateFOMOOptions = {}) {
    this.push = options.push ?? pushNotificationService;
    this.nowFn = options.now ?? (() => Date.now());
  }

  /** Subscribe to template rotation events. */
  subscribe(listener: (trending: TrendingInfo) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Current trending template. */
  current(): TrendingInfo {
    return getTrending(this.nowFn());
  }

  /** Upcoming trending template (starts at next 6h boundary). */
  next(): TrendingInfo {
    return getUpcoming(this.nowFn());
  }

  /**
   * Start the scheduler.  At each 6-hour boundary, it fires a push
   * notification announcing the new trending template and notifies all
   * subscribers so the UI can refresh.
   */
  start(): () => void {
    this.stop();
    this.scheduleNextRotation();
    return () => this.stop();
  }

  /** Stop the scheduler. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduledSlotEnd = null;
  }

  /** Return the full catalogue (useful for template library UIs). */
  catalogue(): CreationTemplate[] {
    return [...TEMPLATES];
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private scheduleNextRotation(): void {
    const now = this.nowFn();
    const boundary = nextSlotBoundary(now);
    this.scheduledSlotEnd = boundary;
    const delay = Math.max(1_000, boundary - now);
    this.timer = setTimeout(() => this.handleRotation(), delay);
  }

  private handleRotation(): void {
    const trending = getTrending(this.nowFn());
    const notification: CreationNotification = {
      id: `template-fomo:${trending.slotIndex}:${trending.slotStartMs}`,
      title: `🔥 ${trending.template.name}`,
      body: trending.headline,
      tone: "fomo",
      groupKey: "template-fomo",
      createdAt: Date.now(),
      durationMs: 9_000,
      payload: { templateId: trending.template.id },
    };
    this.push.fire(notification);
    for (const l of this.listeners) {
      try {
        l(trending);
      } catch (err) {
        console.error("[template-fomo] listener threw", err);
      }
    }
    this.scheduleNextRotation();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

export const templateFOMOService = new TemplateFOMOService();
export { TEMPLATES as TEMPLATE_CATALOGUE };
