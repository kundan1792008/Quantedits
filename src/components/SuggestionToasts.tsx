"use client";

/**
 * SuggestionToasts
 * ────────────────
 *
 * Renders the stack of pending AI suggestions as small, interactive cards.
 * Each card provides Accept / Snooze / Dismiss affordances that drive the
 * micro-decision loop described in issue #14.
 */

import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, Check, X, Clock } from "lucide-react";

import type { Suggestion } from "@/services/CreationAddiction";

interface SuggestionToastsProps {
  suggestions: Suggestion[];
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
  onSnooze: (id: string) => void;
}

const INTENSITY_TINT: Record<Suggestion["intensity"], string> = {
  subtle: "from-sky-500/20 via-sky-500/10 to-transparent",
  moderate: "from-violet-500/30 via-fuchsia-500/20 to-transparent",
  dramatic: "from-rose-500/40 via-orange-500/20 to-transparent",
};

const CATEGORY_GLYPH: Record<Suggestion["category"], string> = {
  color: "🎨",
  audio: "🎧",
  pace: "⏱️",
  text: "✍️",
  transition: "🌀",
  effect: "✨",
  "ai-generative": "🤖",
  structure: "🧩",
};

export default function SuggestionToasts({
  suggestions,
  onAccept,
  onDismiss,
  onSnooze,
}: SuggestionToastsProps) {
  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-40 flex w-[360px] flex-col gap-3">
      <AnimatePresence initial={false}>
        {suggestions.map((suggestion) => (
          <motion.div
            key={suggestion.id}
            layout
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className={`pointer-events-auto rounded-2xl border border-white/10 bg-gradient-to-br ${INTENSITY_TINT[suggestion.intensity]} bg-neutral-900/90 p-4 shadow-2xl backdrop-blur`}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-lg">
                <span aria-hidden="true">{CATEGORY_GLYPH[suggestion.category]}</span>
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5 text-fuchsia-300" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-fuchsia-300">
                    AI suggestion
                  </span>
                  {suggestion.trending && (
                    <span className="rounded-full bg-rose-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-rose-300">
                      trending
                    </span>
                  )}
                </div>
                <h4 className="mt-1 text-sm font-semibold text-white">
                  {suggestion.title}
                </h4>
                <p className="mt-1 text-xs leading-relaxed text-white/70">
                  {suggestion.body}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onAccept(suggestion.id)}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-white text-neutral-900 px-3 py-1.5 text-xs font-semibold transition hover:bg-white/90"
                  >
                    <Check className="h-3.5 w-3.5" />
                    {suggestion.cta}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSnooze(suggestion.id)}
                    className="flex items-center justify-center rounded-lg bg-white/5 p-1.5 text-white/70 transition hover:bg-white/10"
                    aria-label="Snooze suggestion"
                  >
                    <Clock className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDismiss(suggestion.id)}
                    className="flex items-center justify-center rounded-lg bg-white/5 p-1.5 text-white/70 transition hover:bg-white/10"
                    aria-label="Dismiss suggestion"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-2 text-[10px] uppercase tracking-wider text-white/40">
                  +{(suggestion.qualityDelta * 100).toFixed(1)}% quality ·{" "}
                  {(suggestion.confidence * 100).toFixed(0)}% confidence
                </div>
              </div>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
