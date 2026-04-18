/**
 * useEngagement — React hook bundling state for the engagement sidebar.
 *
 * Keeps all API plumbing in one place so individual components stay
 * purely presentational.
 *
 * NOTE: This hook intentionally uses local fallbacks (no network) when the
 * engagement endpoints aren't mounted (e.g. in storybook, dev without DB).
 * That way the editor UI never blocks on a missing backend.
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ProjectProbe,
  QualityScore,
  StreakStatus,
  TemplateListing,
  ViewEstimate,
} from "@/services/engagement/types";
import { evaluateQuality } from "@/services/engagement/qualityChecker";
import { generateSuggestions } from "@/services/engagement/suggestionEngine";
import type { StoredSuggestion } from "@/components/SuggestionFeed";
import type { EngagementPreferencesData } from "@/components/EngagementPreferences";

const DEFAULT_PREFS: EngagementPreferencesData = {
  suggestionsEnabled: true,
  qualityChecklistEnabled: true,
  viewEstimatesEnabled: true,
  streakEnabled: false,
  draftReminderPushEnabled: false,
  draftReminderEmailEnabled: false,
  draftReminderMinIdleHours: 72,
  draftReminderMaxPerWeek: 1,
  quietHoursStart: 22,
  quietHoursEnd: 8,
  timezone: "UTC",
};

export interface UseEngagementOptions {
  /** Optional auth token to forward to engagement endpoints. */
  authToken?: string;
  /** Base URL of the engagement API. Defaults to same-origin. */
  apiBase?: string;
  /** Initial probe to seed quality + suggestions when offline. */
  probe?: ProjectProbe | null;
}

interface EngagementState {
  preferences: EngagementPreferencesData;
  qualityScore: QualityScore | null;
  suggestions: StoredSuggestion[];
  streak: StreakStatus | null;
  viewEstimate: ViewEstimate | null;
  templates: TemplateListing[];
  loading: boolean;
  online: boolean;
}

function ephemeralId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useEngagement(options: UseEngagementOptions = {}) {
  const { authToken, apiBase = "/api/v1/engagement", probe } = options;

  const [state, setState] = useState<EngagementState>({
    preferences: DEFAULT_PREFS,
    qualityScore: null,
    suggestions: [],
    streak: null,
    viewEstimate: null,
    templates: [],
    loading: false,
    online: false,
  });

  const authHeaders = useMemo<Record<string, string>>(() => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) h.Authorization = `Bearer ${authToken}`;
    return h;
  }, [authToken]);

  const fetchJson = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T | null> => {
      try {
        const res = await fetch(`${apiBase}${path}`, {
          ...init,
          headers: { ...authHeaders, ...(init?.headers ?? {}) },
          credentials: "same-origin",
        });
        if (!res.ok) return null;
        return (await res.json()) as T;
      } catch {
        return null;
      }
    },
    [apiBase, authHeaders],
  );

  // Load preferences + streak + templates on mount.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setState((s) => ({ ...s, loading: true }));
      const [prefsRes, streakRes, tmplRes] = await Promise.all([
        fetchJson<{ preferences: EngagementPreferencesData }>("/preferences"),
        fetchJson<{ streak: StreakStatus }>("/streak"),
        fetchJson<{ templates: TemplateListing[] }>("/templates?sort=trending"),
      ]);
      if (cancelled) return;
      const online = prefsRes !== null || tmplRes !== null;
      setState((s) => ({
        ...s,
        online,
        preferences: prefsRes?.preferences ?? s.preferences,
        streak: streakRes?.streak ?? s.streak,
        templates: tmplRes?.templates ?? s.templates,
        loading: false,
      }));
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [fetchJson]);

  // Local-first computation: whenever probe changes, recompute quality +
  // suggestions synchronously so the UI feels snappy. Then, if online,
  // upsert server-side via the API for persistence.
  useEffect(() => {
    if (!probe) return;
    const score = evaluateQuality(probe);
    const candidates = generateSuggestions(probe);
    const stored: StoredSuggestion[] = candidates.map((c) => ({
      ...c,
      id: ephemeralId("sugg"),
      status: "PENDING",
    }));
    setState((s) => ({
      ...s,
      qualityScore: score,
      suggestions: stored,
    }));

    if (state.online && probe.projectId) {
      void fetchJson("/quality", {
        method: "POST",
        body: JSON.stringify(probe),
      });
      void fetchJson("/suggestions", {
        method: "POST",
        body: JSON.stringify(probe),
      });
    }
    // We intentionally omit state.online from deps to avoid re-posts purely
    // from the online flag flipping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe, fetchJson]);

  // View estimate — compute when user has history on the server. Falls back
  // to a null estimate (insufficient_data) when offline so the UI shows the
  // honest "no estimate available" state.
  useEffect(() => {
    if (!state.online) {
      setState((s) => ({
        ...s,
        viewEstimate: {
          median: null,
          low: null,
          high: null,
          confidence: "insufficient_data",
          sampleSize: 0,
          methodology:
            "No estimate available. Connect Quanttube or publish a few videos to start building a projection.",
        },
      }));
      return;
    }
    let cancelled = false;
    (async () => {
      const res = await fetchJson<{ estimate: ViewEstimate }>(
        "/view-estimate",
        {
          method: "POST",
          body: JSON.stringify({
            qualityScore: state.qualityScore?.score,
          }),
        },
      );
      if (!cancelled && res?.estimate) {
        setState((s) => ({ ...s, viewEstimate: res.estimate }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.online, state.qualityScore?.score, fetchJson]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const updatePreferences = useCallback(
    async (partial: Partial<EngagementPreferencesData>) => {
      setState((s) => ({ ...s, preferences: { ...s.preferences, ...partial } }));
      if (state.online) {
        await fetchJson("/preferences", {
          method: "PATCH",
          body: JSON.stringify(partial),
        });
      }
    },
    [fetchJson, state.online],
  );

  const enableStreak = useCallback(async () => {
    setState((s) => ({
      ...s,
      streak: { ...(s.streak ?? { current: 0, longest: 0, lastActiveDate: null, countedToday: false, enabled: false }), enabled: true },
    }));
    const res = await fetchJson<{ streak: StreakStatus }>("/streak", {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    if (res?.streak) setState((s) => ({ ...s, streak: res.streak }));
  }, [fetchJson]);

  const disableStreak = useCallback(async () => {
    const res = await fetchJson<{ streak: StreakStatus }>("/streak", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    setState((s) => ({ ...s, streak: res?.streak ?? null }));
  }, [fetchJson]);

  const resetStreak = useCallback(async () => {
    const res = await fetchJson<{ streak: StreakStatus }>("/streak", {
      method: "PATCH",
      body: JSON.stringify({ reset: true }),
    });
    if (res?.streak) setState((s) => ({ ...s, streak: res.streak }));
  }, [fetchJson]);

  const recordActivity = useCallback(async () => {
    const res = await fetchJson<{ streak: StreakStatus }>("/streak", {
      method: "POST",
    });
    if (res?.streak) setState((s) => ({ ...s, streak: res.streak }));
  }, [fetchJson]);

  const applySuggestion = useCallback(
    (id: string) => {
      setState((s) => ({
        ...s,
        suggestions: s.suggestions.map((x) =>
          x.id === id ? { ...x, status: "APPLIED" } : x,
        ),
      }));
      if (state.online) {
        void fetchJson(`/suggestions/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "APPLIED" }),
        });
      }
    },
    [fetchJson, state.online],
  );

  const dismissSuggestion = useCallback(
    (id: string) => {
      setState((s) => ({
        ...s,
        suggestions: s.suggestions.map((x) =>
          x.id === id ? { ...x, status: "DISMISSED" } : x,
        ),
      }));
      if (state.online) {
        void fetchJson(`/suggestions/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "DISMISSED" }),
        });
      }
    },
    [fetchJson, state.online],
  );

  return {
    ...state,
    updatePreferences,
    enableStreak,
    disableStreak,
    resetStreak,
    recordActivity,
    applySuggestion,
    dismissSuggestion,
  };
}
