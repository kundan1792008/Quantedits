"use client";

/**
 * CreationAddictionPanel
 * ──────────────────────
 *
 * Composes every Creation Addiction UI surface (quality meter, streak
 * badge, social-validation preview, trending template, suggestion toasts
 * and the draft-anxiety banner) into a single sidebar-friendly component.
 *
 * Usage:
 *
 *   <CreationAddictionPanel
 *     editor={editorContext}
 *     quality={qualityInputs}
 *     prediction={predictionInputs}
 *     drafts={[...]}
 *   />
 *
 * All props are shaped to match the public types exported from
 * `@/services/CreationAddiction` so the caller can reuse the same
 * objects across the editor state tree.
 */

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, Flame } from "lucide-react";

import {
  useCreationAddiction,
  type UseCreationAddictionOptions,
} from "@/hooks/useCreationAddiction";
import type {
  CreationNotification,
  DraftRecord,
  PredictionInputs,
} from "@/services/CreationAddiction";

import DraftAnxietyBanner from "./DraftAnxietyBanner";
import QualityMeterCard from "./QualityMeterCard";
import SocialValidationPreview from "./SocialValidationPreview";
import StreakBadge from "./CreationStreakBadge";
import SuggestionToasts from "./SuggestionToasts";
import TemplateFOMOCard from "./TemplateFOMOCard";

export interface CreationAddictionPanelProps
  extends UseCreationAddictionOptions {
  /** Prediction inputs used for the social-validation preview. */
  prediction: Omit<PredictionInputs, "streakMultiplier">;
  /** Drafts shown in the anxiety banner (also drive the anxiety sweep). */
  drafts: DraftRecord[];
  /** Handlers the host can wire into its editor routing layer. */
  onOpenDraft?: (draftId: string) => void;
  onApplyTemplate?: (templateId: string) => void;
  /** Render the component in compact mode (hides heading + description). */
  compact?: boolean;
}

export default function CreationAddictionPanel({
  prediction,
  drafts,
  onOpenDraft,
  onApplyTemplate,
  compact,
  ...hookOptions
}: CreationAddictionPanelProps) {
  const {
    snapshot,
    toasts,
    dismissToast,
    acceptSuggestion,
    dismissSuggestion,
    snoozeSuggestion,
    predict,
    requestNotificationPermission,
  } = useCreationAddiction(hookOptions);

  // Sync drafts into the anxiety service so its sweep can fire pings.
  useEffect(() => {
    const engine = hookOptions.engine;
    const anxiety = engine ? engine.draftAnxiety : undefined;
    const service = anxiety ?? snapshot; // Narrow — see below.
    if (!anxiety) {
      // Fallback to the default singleton behind the hook.
      for (const draft of drafts) {
        defaultUpsert(draft);
      }
      return;
    }
    for (const draft of drafts) {
      anxiety.upsert(draft);
    }
    return () => {
      // Nothing to clean up — drafts persist across renders.
      void service;
    };
  }, [drafts, hookOptions.engine, snapshot]);

  // Prompt for notification permission on first mount.
  useEffect(() => {
    void requestNotificationPermission();
  }, [requestNotificationPermission]);

  const predictionResult = useMemo(
    () => predict(prediction),
    [predict, prediction],
  );

  // Tick `now` once per minute so the anxiety banner's idle-hour counters
  // stay fresh without bumping the React tree on every animation frame.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <aside className="flex w-full flex-col gap-4">
      {!compact && (
        <header className="flex items-center gap-2">
          <Flame className="h-4 w-4 text-amber-400" />
          <h2 className="text-sm font-semibold uppercase tracking-widest text-white/80">
            Creation Loop
          </h2>
          <span className="ml-auto flex items-center gap-1 text-[10px] uppercase tracking-widest text-white/40">
            <Bell className="h-3 w-3" />
            {snapshot.suggestions.length} live suggestions
          </span>
        </header>
      )}

      <DraftAnxietyBanner
        drafts={drafts}
        now={now}
        onOpenDraft={onOpenDraft}
      />

      <StreakBadge state={snapshot.streak} boost={snapshot.streakBoost} />

      <QualityMeterCard breakdown={snapshot.quality} />

      <SocialValidationPreview
        prediction={predictionResult}
        boostMultiplier={snapshot.streakBoost}
      />

      <TemplateFOMOCard
        trending={snapshot.trending}
        upcoming={snapshot.upcoming}
        onApply={onApplyTemplate}
      />

      <SuggestionToasts
        suggestions={snapshot.suggestions}
        onAccept={acceptSuggestion}
        onDismiss={dismissSuggestion}
        onSnooze={snoozeSuggestion}
      />

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </aside>
  );
}

// ── Anxiety toast stack ──────────────────────────────────────────────────

interface ToastStackProps {
  toasts: CreationNotification[];
  onDismiss: (id: string) => void;
}

const TONE_STYLE: Record<CreationNotification["tone"], string> = {
  info: "border-sky-400/30 bg-sky-500/10",
  success: "border-emerald-400/30 bg-emerald-500/10",
  warning: "border-amber-400/30 bg-amber-500/10",
  anxiety: "border-rose-400/40 bg-rose-500/10",
  fomo: "border-fuchsia-400/40 bg-fuchsia-500/10",
  streak: "border-amber-300/40 bg-amber-400/10",
};

function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed top-6 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout
            initial={{ opacity: 0, y: -12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 320, damping: 30 }}
            className={`pointer-events-auto flex w-[360px] items-start gap-3 rounded-xl border px-3 py-2 text-white shadow-lg backdrop-blur ${TONE_STYLE[toast.tone]}`}
          >
            <Bell className="mt-0.5 h-4 w-4 shrink-0 text-white/80" />
            <div className="flex-1">
              <div className="text-xs font-semibold">{toast.title}</div>
              <div className="text-[11px] text-white/70">{toast.body}</div>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="text-[10px] font-semibold uppercase tracking-widest text-white/60 hover:text-white"
            >
              Close
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// Fallback helper when no engine override is supplied.
function defaultUpsert(draft: DraftRecord): void {
  // Imported lazily to avoid a hard dependency from the compact path.
  import("@/services/CreationAddiction").then(({ draftAnxietyService }) => {
    draftAnxietyService.upsert(draft);
  });
}
