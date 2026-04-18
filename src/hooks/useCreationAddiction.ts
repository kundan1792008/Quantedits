"use client";

/**
 * useCreationAddiction React Hook
 * ───────────────────────────────
 *
 * A single hook that wires every Creation Addiction service into a React
 * component.  It:
 *
 *   • Starts background services (draft anxiety + template rotation) on
 *     mount and tears them down on unmount.
 *   • Subscribes to the push notification bus so the UI can render
 *     in-app toasts.
 *   • Ticks the Suggestion Engine whenever the editor context changes.
 *   • Exposes every service's current state in a single `snapshot` object
 *     that consumers can destructure.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CreationAddictionEngine,
  creationAddictionEngine,
  type CreationAddictionSnapshot,
  type CreationNotification,
  type EditorContext,
  type PredictionInputs,
  type PredictionResult,
  type QualityInputs,
  type Suggestion,
} from "@/services/CreationAddiction";

export interface UseCreationAddictionOptions {
  editor: EditorContext;
  quality: QualityInputs;
  engine?: CreationAddictionEngine;
  /** When true, suggestions are not auto-ticked (useful for tests). */
  pauseSuggestions?: boolean;
  /** Optional interval (ms) between suggestion ticks. Defaults to 6s. */
  suggestionTickMs?: number;
}

export interface UseCreationAddictionResult {
  snapshot: CreationAddictionSnapshot;
  toasts: CreationNotification[];
  dismissToast: (id: string) => void;
  acceptSuggestion: (id: string) => void;
  dismissSuggestion: (id: string) => void;
  snoozeSuggestion: (id: string) => void;
  recordCreation: () => void;
  predict: (
    inputs: Omit<PredictionInputs, "streakMultiplier">,
  ) => PredictionResult;
  requestNotificationPermission: () => Promise<boolean>;
}

const MAX_TOASTS = 4;

export function useCreationAddiction(
  options: UseCreationAddictionOptions,
): UseCreationAddictionResult {
  const engine = options.engine ?? creationAddictionEngine;
  const [toasts, setToasts] = useState<CreationNotification[]>([]);
  const [tickCount, setTickCount] = useState(0);

  // Start/stop every background service.
  useEffect(() => {
    const stop = engine.start();
    return () => stop();
  }, [engine]);

  // Subscribe to notifications so we can render in-app toasts.
  useEffect(() => {
    const unsubscribe = engine.push.subscribe((notification) => {
      setToasts((prev) => {
        const next = [notification, ...prev.filter((n) => n.id !== notification.id)];
        return next.slice(0, MAX_TOASTS);
      });
      const duration = notification.durationMs ?? 6_000;
      if (duration > 0) {
        setTimeout(() => {
          setToasts((prev) => prev.filter((n) => n.id !== notification.id));
        }, duration);
      }
    });
    return () => unsubscribe();
  }, [engine]);

  // Tick the suggestion engine at a modest interval so new micro-decisions
  // appear while the user is editing.  Also refresh the snapshot at the
  // same cadence so the trending-template counter climbs visibly.
  const tickMs = options.suggestionTickMs ?? 6_000;
  const editorRef = useRef(options.editor);
  useEffect(() => {
    editorRef.current = options.editor;
  }, [options.editor]);
  useEffect(() => {
    if (options.pauseSuggestions) return;
    const id = setInterval(() => {
      engine.tickSuggestion(editorRef.current);
      setTickCount((c) => (c + 1) % 1_000_000);
    }, tickMs);
    return () => clearInterval(id);
  }, [engine, options.pauseSuggestions, tickMs]);

  // Snapshot — recomputed whenever inputs or tick changes.
  const snapshot = useMemo(() => {
    // Touch tickCount so that the memo re-runs on every tick.
    void tickCount;
    return engine.snapshot(options.editor, options.quality);
  }, [engine, options.editor, options.quality, tickCount]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const acceptSuggestion = useCallback(
    (id: string) => {
      engine.suggestion.accept(id);
      setTickCount((c) => c + 1);
    },
    [engine],
  );

  const dismissSuggestion = useCallback(
    (id: string) => {
      engine.suggestion.dismiss(id);
      setTickCount((c) => c + 1);
    },
    [engine],
  );

  const snoozeSuggestion = useCallback(
    (id: string) => {
      engine.suggestion.snooze(id);
      setTickCount((c) => c + 1);
    },
    [engine],
  );

  const recordCreation = useCallback(() => {
    engine.streaks.recordCreation();
    setTickCount((c) => c + 1);
  }, [engine]);

  const predict = useCallback(
    (inputs: Omit<PredictionInputs, "streakMultiplier">): PredictionResult =>
      engine.predict(inputs),
    [engine],
  );

  const requestNotificationPermission = useCallback(
    () => engine.push.requestPermission(),
    [engine],
  );

  return {
    snapshot,
    toasts,
    dismissToast,
    acceptSuggestion,
    dismissSuggestion,
    snoozeSuggestion,
    recordCreation,
    predict,
    requestNotificationPermission,
  };
}

export type { Suggestion };
