/**
 * SuggestionFeed — contextual, dismissible, non-blocking suggestions.
 *
 * Contract:
 *  - Each suggestion is dismissible (DISMISSED) or can be marked applied.
 *  - Non-blocking: the feed never intercepts the editor, it lives in a side
 *    panel.
 *  - Severity is shown once and faithfully — WARNING is reserved for real
 *    problems (clipping audio, etc.), not manufactured urgency.
 */

"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Lightbulb,
  Info,
  Check,
  X,
} from "lucide-react";
import type { SuggestionCandidate } from "@/services/engagement/types";

export interface StoredSuggestion extends SuggestionCandidate {
  id: string;
  status: "PENDING" | "APPLIED" | "DISMISSED";
}

export interface SuggestionFeedProps {
  suggestions: StoredSuggestion[];
  loading?: boolean;
  onApply?: (id: string) => void;
  onDismiss?: (id: string) => void;
}

const severityMeta: Record<
  SuggestionCandidate["severity"],
  { icon: typeof AlertTriangle; colour: string; label: string }
> = {
  WARNING: { icon: AlertTriangle, colour: "#F97316", label: "Needs attention" },
  RECOMMENDED: { icon: Lightbulb, colour: "#06B6D4", label: "Recommended" },
  INFO: { icon: Info, colour: "#8888aa", label: "Idea" },
};

export default function SuggestionFeed({
  suggestions,
  loading,
  onApply,
  onDismiss,
}: SuggestionFeedProps) {
  const pending = suggestions.filter((s) => s.status === "PENDING");

  return (
    <section
      aria-label="Editing suggestions"
      className="rounded-xl p-4"
      style={{ background: "#13131A", border: "1px solid #1E1E2E" }}
    >
      <header className="flex items-center gap-2 mb-3">
        <Lightbulb size={14} className="text-[#8888aa]" />
        <h3 className="text-xs font-semibold uppercase tracking-widest text-[#8888aa]">
          Suggestions
        </h3>
        {pending.length > 0 && (
          <span
            className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{ background: "#1E1E2E", color: "#8888aa" }}
          >
            {pending.length}
          </span>
        )}
      </header>

      {loading && pending.length === 0 && (
        <p className="text-xs text-[#5a5a7a]">Analysing…</p>
      )}

      {!loading && pending.length === 0 && (
        <p className="text-xs text-[#5a5a7a]">
          Nothing to flag. We&apos;ll surface ideas here as the edit evolves.
        </p>
      )}

      <ul className="space-y-2">
        <AnimatePresence initial={false}>
          {pending.map((s) => {
            const meta = severityMeta[s.severity];
            const Icon = meta.icon;
            return (
              <motion.li
                key={s.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: 40 }}
                transition={{ duration: 0.2 }}
                className="rounded-lg p-3"
                style={{
                  background: "#0D0D11",
                  border: `1px solid ${meta.colour}33`,
                }}
              >
                <div className="flex items-start gap-2">
                  <Icon
                    size={14}
                    style={{ color: meta.colour, marginTop: 2 }}
                    className="shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-semibold text-[#E8E8F0]">
                      {s.title}
                    </p>
                    <p className="text-[11px] text-[#B8B8D0] mt-1">{s.body}</p>
                    <p
                      className="text-[10px] uppercase tracking-widest mt-2"
                      style={{ color: meta.colour }}
                    >
                      {meta.label}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-2 justify-end">
                  <button
                    type="button"
                    onClick={() => onDismiss?.(s.id)}
                    className="flex items-center gap-1 text-[10px] px-2 py-1 rounded hover:bg-[#1E1E2E] text-[#8888aa]"
                    aria-label={`Dismiss suggestion: ${s.title}`}
                  >
                    <X size={10} />
                    Dismiss
                  </button>
                  <button
                    type="button"
                    onClick={() => onApply?.(s.id)}
                    className="flex items-center gap-1 text-[10px] px-2 py-1 rounded text-white"
                    style={{ background: meta.colour }}
                    aria-label={`Mark suggestion applied: ${s.title}`}
                  >
                    <Check size={10} />
                    Mark applied
                  </button>
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </section>
  );
}
