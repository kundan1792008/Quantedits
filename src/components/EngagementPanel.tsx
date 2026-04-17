/**
 * EngagementPanel — side-panel container that wires the engagement hook to
 * the individual feature components.
 *
 * Usage (from `src/app/page.tsx`):
 *   <EngagementPanel probe={probe} />
 *
 * The `probe` argument describes the current editor state; the panel
 * recomputes quality & suggestions whenever it changes.
 */

"use client";

import { useState } from "react";
import { Sliders } from "lucide-react";
import { useEngagement } from "@/hooks/useEngagement";
import type { ProjectProbe } from "@/services/engagement/types";
import QualityChecklist from "./QualityChecklist";
import SuggestionFeed from "./SuggestionFeed";
import StreakBadge from "./StreakBadge";
import ViewEstimate from "./ViewEstimate";
import TemplateGallery from "./TemplateGallery";
import EngagementPreferences from "./EngagementPreferences";

export interface EngagementPanelProps {
  probe: ProjectProbe | null;
  authToken?: string;
  onTemplateApply?: (templateId: string) => void;
}

export default function EngagementPanel({
  probe,
  authToken,
  onTemplateApply,
}: EngagementPanelProps) {
  const engagement = useEngagement({ authToken, probe });
  const [showPrefs, setShowPrefs] = useState(false);
  const [templateSort, setTemplateSort] =
    useState<"trending" | "recent">("trending");

  const p = engagement.preferences;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-[#5a5a7a]">
          Creator tools
        </span>
        <button
          type="button"
          onClick={() => setShowPrefs((v) => !v)}
          className="flex items-center gap-1 text-[10px] text-[#8888aa] hover:text-[#E8E8F0] transition-colors"
        >
          <Sliders size={11} />
          {showPrefs ? "Hide settings" : "Settings"}
        </button>
      </div>

      {showPrefs && (
        <EngagementPreferences
          preferences={p}
          loading={engagement.loading}
          onChange={engagement.updatePreferences}
        />
      )}

      {p.qualityChecklistEnabled && (
        <QualityChecklist
          score={engagement.qualityScore}
          loading={engagement.loading}
        />
      )}

      {p.suggestionsEnabled && (
        <SuggestionFeed
          suggestions={engagement.suggestions}
          loading={engagement.loading}
          onApply={engagement.applySuggestion}
          onDismiss={engagement.dismissSuggestion}
        />
      )}

      {p.viewEstimatesEnabled && (
        <ViewEstimate
          estimate={engagement.viewEstimate}
          loading={engagement.loading}
        />
      )}

      <StreakBadge
        status={engagement.streak}
        loading={engagement.loading}
        onEnable={engagement.enableStreak}
        onDisable={engagement.disableStreak}
        onReset={engagement.resetStreak}
      />

      <TemplateGallery
        templates={engagement.templates}
        loading={engagement.loading}
        sort={templateSort}
        onSortChange={setTemplateSort}
        onApply={(id) => onTemplateApply?.(id)}
      />
    </div>
  );
}
