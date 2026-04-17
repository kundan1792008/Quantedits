"use client";

/**
 * TemplateFOMOCard
 * ────────────────
 *
 * Displays the currently trending AI template alongside a live-looking
 * "X creators used it today" counter and a countdown until the next
 * template rotation.  Reinforces the FOMO loop from issue #14.
 */

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, Timer, Users } from "lucide-react";

import type { TrendingInfo } from "@/services/CreationAddiction";

interface TemplateFOMOCardProps {
  trending: TrendingInfo;
  upcoming: TrendingInfo;
  onApply?: (templateId: string) => void;
}

export default function TemplateFOMOCard({
  trending,
  upcoming,
  onApply,
}: TemplateFOMOCardProps) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, trending.slotEndMs - Date.now()),
  );

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(Math.max(0, trending.slotEndMs - Date.now()));
    }, 1_000);
    return () => clearInterval(id);
  }, [trending.slotEndMs]);

  return (
    <section className="rounded-2xl border border-white/10 bg-neutral-900/70 p-4 backdrop-blur">
      <header className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-fuchsia-300" />
        <h3 className="text-sm font-semibold text-white">Trending template</h3>
        <span className="ml-auto flex items-center gap-1 text-[10px] uppercase tracking-widest text-white/50">
          <Timer className="h-3 w-3" />
          {formatCountdown(remaining)}
        </span>
      </header>

      <AnimatePresence mode="wait">
        <motion.div
          key={trending.template.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="mt-3"
        >
          <div
            className="relative flex h-28 items-center justify-center overflow-hidden rounded-xl"
            style={{ background: trending.template.gradient }}
          >
            <span className="absolute inset-0 bg-black/10" />
            <span className="relative text-5xl drop-shadow-lg" aria-hidden="true">
              {trending.template.glyph}
            </span>
            <span className="absolute bottom-2 left-3 text-[10px] font-semibold uppercase tracking-widest text-white/80">
              {trending.template.aesthetic.replace("-", " ")}
            </span>
          </div>

          <h4 className="mt-3 text-base font-semibold text-white">
            {trending.template.name}
          </h4>
          <p className="mt-1 text-xs text-white/70">{trending.template.tagline}</p>

          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-white/60">
            <Users className="h-3 w-3" />
            <span>
              <span className="font-semibold text-white">
                {trending.adoptersToday.toLocaleString()}
              </span>{" "}
              creators used it today
            </span>
          </div>

          {onApply && (
            <button
              type="button"
              onClick={() => onApply(trending.template.id)}
              className="mt-3 w-full rounded-lg bg-white text-neutral-900 px-3 py-2 text-xs font-semibold transition hover:bg-white/90"
            >
              Apply this template
            </button>
          )}
        </motion.div>
      </AnimatePresence>

      <div className="mt-4 border-t border-white/5 pt-3">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-white/40">
          <span>Coming next</span>
          <span>in {formatCountdown(remaining)}</span>
        </div>
        <p className="mt-1 text-xs text-white/70">
          <span className="mr-1" aria-hidden="true">
            {upcoming.template.glyph}
          </span>
          {upcoming.template.name}
          <span className="ml-2 text-white/40">— {upcoming.template.tagline}</span>
        </p>
      </div>
    </section>
  );
}

function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "rotating…";
  const totalSeconds = Math.floor(ms / 1_000);
  const h = Math.floor(totalSeconds / 3_600);
  const m = Math.floor((totalSeconds % 3_600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}
