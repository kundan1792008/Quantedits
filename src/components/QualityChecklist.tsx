/**
 * QualityChecklist — transparent, completable quality score UI.
 *
 * Contract:
 *  - Displays the score exactly as computed. When `score === 100`, the UI
 *    celebrates completion — we never cap the displayed number below 100.
 *  - Renders every rule with its weight, awarded points, hint, and
 *    passed/failed/skipped state. Nothing is hidden from the user.
 *  - Shows the "next best actions" list so users see exactly what to do to
 *    raise the score.
 */

"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, Circle, MinusCircle, Info } from "lucide-react";
import type { QualityScore } from "@/services/engagement/types";

export interface QualityChecklistProps {
  score: QualityScore | null;
  loading?: boolean;
  onDismiss?: () => void;
}

export default function QualityChecklist({
  score,
  loading,
}: QualityChecklistProps) {
  const bandColour = useMemo(() => {
    if (!score) return "#5a5a7a";
    if (score.score >= 90) return "#10B981";
    if (score.score >= 70) return "#06B6D4";
    if (score.score >= 50) return "#F59E0B";
    return "#EF4444";
  }, [score]);

  return (
    <section
      aria-label="Quality checklist"
      className="rounded-xl p-4"
      style={{ background: "#13131A", border: "1px solid #1E1E2E" }}
    >
      <header className="flex items-center gap-2 mb-3">
        <CheckCircle2 size={14} className="text-[#8888aa]" />
        <h3 className="text-xs font-semibold uppercase tracking-widest text-[#8888aa]">
          Quality checklist
        </h3>
      </header>

      {loading && !score && (
        <p className="text-xs text-[#5a5a7a]">Evaluating…</p>
      )}

      {!loading && !score && (
        <p className="text-xs text-[#5a5a7a]">
          Import a clip and fill in project details to see a quality score.
        </p>
      )}

      {score && (
        <>
          <div className="flex items-baseline gap-3 mb-2">
            <motion.span
              key={score.score}
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="text-4xl font-bold"
              style={{ color: bandColour }}
            >
              {score.score}
            </motion.span>
            <span className="text-sm text-[#8888aa]">/ 100</span>
            {score.score === 100 && (
              <span
                className="ml-auto text-[10px] font-semibold px-2 py-0.5 rounded"
                style={{ background: "#10B98133", color: "#10B981" }}
              >
                All applicable checks passed
              </span>
            )}
          </div>

          <div
            className="w-full h-1.5 rounded overflow-hidden mb-3"
            style={{ background: "#1E1E2E" }}
          >
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${score.score}%` }}
              transition={{ duration: 0.4 }}
              style={{ height: "100%", background: bandColour }}
            />
          </div>

          {score.nextBestActions.length > 0 && (
            <div className="mb-3">
              <p className="text-[10px] uppercase tracking-widest text-[#5a5a7a] mb-1">
                Next best actions
              </p>
              <ul className="space-y-1">
                {score.nextBestActions.slice(0, 3).map((a) => (
                  <li
                    key={a.ruleId}
                    className="text-[11px] text-[#B8B8D0] flex items-start gap-2"
                  >
                    <span className="text-emerald-400 font-mono shrink-0">
                      +{a.gain}
                    </span>
                    <span>{a.hint}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <details className="group">
            <summary className="cursor-pointer text-[11px] text-[#5a5a7a] hover:text-[#E8E8F0] transition-colors">
              Show all {score.rules.length} checks
            </summary>
            <ul className="mt-2 space-y-1.5">
              {score.rules.map((r) => {
                const Icon = r.skipped
                  ? MinusCircle
                  : r.passed
                    ? CheckCircle2
                    : Circle;
                const colour = r.skipped
                  ? "#5a5a7a"
                  : r.passed
                    ? "#10B981"
                    : "#8888aa";
                return (
                  <li key={r.ruleId} className="flex items-start gap-2">
                    <Icon
                      size={12}
                      style={{ color: colour, marginTop: 2 }}
                      className="shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] text-[#E8E8F0]">
                        {r.label}{" "}
                        <span className="text-[10px] text-[#5a5a7a]">
                          ({r.awarded}/{r.weight})
                        </span>
                      </p>
                      <p className="text-[10px] text-[#5a5a7a] truncate">
                        {r.skipped ? (
                          <span className="italic">
                            Skipped — probe data unavailable
                          </span>
                        ) : (
                          <>
                            {r.hint}
                            {r.measured ? (
                              <span className="ml-1 font-mono">
                                · {r.measured}
                              </span>
                            ) : null}
                          </>
                        )}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </details>

          <p className="mt-3 flex items-start gap-1.5 text-[10px] text-[#5a5a7a]">
            <Info size={10} className="shrink-0 mt-0.5" />
            <span>
              Score is computed only from checks we could evaluate ({score.evaluatedWeight} pts). A 100 is reachable — no
              hidden ceiling.
            </span>
          </p>
        </>
      )}
    </section>
  );
}
