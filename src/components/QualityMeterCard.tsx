"use client";

/**
 * QualityMeterCard
 * ────────────────
 *
 * Visual rendering of the "Almost Perfect" quality meter.  A large score
 * dial dominates the card; below it the component breakdown is shown as
 * a set of mini radial bars, each annotated with the weakest-first
 * recommendation that the user can tap to improve.
 *
 * By design, the dial is capped at the ceiling returned from the service
 * — it never fills to 100%, reinforcing the Almost-Perfect dopamine loop.
 */

import { motion } from "framer-motion";
import { Sparkles, AlertCircle } from "lucide-react";

import type { QualityBreakdown, MeterComponent } from "@/services/CreationAddiction/QualityMeter";

interface QualityMeterCardProps {
  breakdown: QualityBreakdown;
}

export default function QualityMeterCard({ breakdown }: QualityMeterCardProps) {
  const dashTotal = 2 * Math.PI * 44; // radius 44
  const fill = Math.min(breakdown.displayedScore, breakdown.ceiling) / 100;
  const dashOffset = dashTotal * (1 - fill);

  const ceilingMark = breakdown.ceiling / 100;
  const ceilingOffset = dashTotal * (1 - ceilingMark);

  return (
    <div className="rounded-2xl border border-white/10 bg-neutral-900/70 p-4 backdrop-blur">
      <header className="mb-3 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-emerald-300" />
        <h3 className="text-sm font-semibold text-white">Almost-Perfect Meter</h3>
      </header>

      <div className="flex items-center gap-4">
        {/* Dial */}
        <div className="relative h-28 w-28 shrink-0">
          <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
            <circle
              cx="50"
              cy="50"
              r="44"
              fill="none"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth="8"
            />
            {/* Ceiling "never reach" marker */}
            <circle
              cx="50"
              cy="50"
              r="44"
              fill="none"
              stroke="rgba(244, 63, 94, 0.35)"
              strokeWidth="2"
              strokeDasharray={`2 ${dashTotal - 2}`}
              strokeDashoffset={ceilingOffset}
              strokeLinecap="round"
            />
            {/* Score */}
            <motion.circle
              cx="50"
              cy="50"
              r="44"
              fill="none"
              stroke="url(#meter-gradient)"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={dashTotal}
              initial={false}
              animate={{ strokeDashoffset: dashOffset }}
              transition={{ type: "spring", stiffness: 80, damping: 20 }}
            />
            <defs>
              <linearGradient id="meter-gradient" x1="0" x2="1" y1="0" y2="1">
                <stop offset="0" stopColor="#34d399" />
                <stop offset="1" stopColor="#a855f7" />
              </linearGradient>
            </defs>
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <motion.span
              key={breakdown.displayedScore}
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="text-2xl font-semibold text-white"
            >
              {breakdown.displayedScore.toFixed(1)}
              <span className="text-base text-white/60">%</span>
            </motion.span>
            <span className="text-[10px] uppercase tracking-widest text-white/40">
              Quality
            </span>
          </div>
        </div>

        {/* Next tweak */}
        <div className="flex-1">
          <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-white/50">
            <AlertCircle className="h-3.5 w-3.5" />
            Next tweak
          </div>
          <p className="mt-1 text-sm font-medium text-white">
            {breakdown.hint}
          </p>
          <p className="mt-2 text-xs text-white/50">
            Ceiling: {breakdown.ceiling.toFixed(1)}% — you&rsquo;re almost there.
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-5 gap-2">
        {breakdown.components.map((component) => (
          <ComponentBar key={component.id} component={component} />
        ))}
      </div>
    </div>
  );
}

function ComponentBar({ component }: { component: MeterComponent }) {
  const pct = Math.round(component.value * 100);
  return (
    <div className="rounded-lg bg-white/5 p-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-white/60">
          {component.label}
        </span>
        <span className="text-[10px] font-semibold text-white">{pct}%</span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/10">
        <motion.div
          className="h-full bg-gradient-to-r from-emerald-400 to-fuchsia-400"
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ type: "spring", stiffness: 90, damping: 22 }}
        />
      </div>
    </div>
  );
}
