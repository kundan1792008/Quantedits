/**
 * EngagementPreferences — central opt-in/opt-out UI for engagement features.
 *
 * Every toggle below maps 1:1 to a `UserPreferences` field so users have
 * full control over notifications, streaks, and estimates.
 */

"use client";

import { useState, useEffect } from "react";
import { Settings2, Info } from "lucide-react";

export interface EngagementPreferencesData {
  suggestionsEnabled: boolean;
  qualityChecklistEnabled: boolean;
  viewEstimatesEnabled: boolean;
  streakEnabled: boolean;
  draftReminderPushEnabled: boolean;
  draftReminderEmailEnabled: boolean;
  draftReminderMinIdleHours: number;
  draftReminderMaxPerWeek: number;
  quietHoursStart: number;
  quietHoursEnd: number;
  timezone: string;
}

export interface EngagementPreferencesProps {
  preferences: EngagementPreferencesData | null;
  loading?: boolean;
  onChange?: (partial: Partial<EngagementPreferencesData>) => void;
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 py-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-purple-500"
      />
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-semibold text-[#E8E8F0]">{label}</p>
        <p className="text-[10px] text-[#8888aa]">{description}</p>
      </div>
    </label>
  );
}

export default function EngagementPreferences({
  preferences,
  loading,
  onChange,
}: EngagementPreferencesProps) {
  const [local, setLocal] = useState<EngagementPreferencesData | null>(
    preferences,
  );

  useEffect(() => {
    setLocal(preferences);
  }, [preferences]);

  if (loading && !local) {
    return (
      <section
        className="rounded-xl p-4"
        style={{ background: "#13131A", border: "1px solid #1E1E2E" }}
      >
        <p className="text-xs text-[#5a5a7a]">Loading preferences…</p>
      </section>
    );
  }

  if (!local) return null;

  const update = (partial: Partial<EngagementPreferencesData>) => {
    const next = { ...local, ...partial };
    setLocal(next);
    onChange?.(partial);
  };

  return (
    <section
      aria-label="Engagement preferences"
      className="rounded-xl p-4"
      style={{ background: "#13131A", border: "1px solid #1E1E2E" }}
    >
      <header className="flex items-center gap-2 mb-3">
        <Settings2 size={14} className="text-[#8888aa]" />
        <h3 className="text-xs font-semibold uppercase tracking-widest text-[#8888aa]">
          Engagement settings
        </h3>
      </header>

      <div className="divide-y" style={{ borderColor: "#1E1E2E" }}>
        <Toggle
          label="AI editing suggestions"
          description="Contextual tips while you edit. You can dismiss any suggestion."
          checked={local.suggestionsEnabled}
          onChange={(v) => update({ suggestionsEnabled: v })}
        />
        <Toggle
          label="Quality checklist"
          description="Transparent score showing what would improve the final video. Fully reachable 100."
          checked={local.qualityChecklistEnabled}
          onChange={(v) => update({ qualityChecklistEnabled: v })}
        />
        <Toggle
          label="Pre-publish view estimate"
          description="Labeled projection grounded in your own past videos. Shown with its confidence range."
          checked={local.viewEstimatesEnabled}
          onChange={(v) => update({ viewEstimatesEnabled: v })}
        />
        <Toggle
          label="Creation streak tracker"
          description="Personal counter of consecutive creating days. No effect on Quanttube reach."
          checked={local.streakEnabled}
          onChange={(v) => update({ streakEnabled: v })}
        />
        <Toggle
          label="Draft reminders — push"
          description="A polite push reminder for drafts you haven't opened in a while. Respects quiet hours."
          checked={local.draftReminderPushEnabled}
          onChange={(v) => update({ draftReminderPushEnabled: v })}
        />
        <Toggle
          label="Draft reminders — email"
          description="Same, but delivered by email."
          checked={local.draftReminderEmailEnabled}
          onChange={(v) => update({ draftReminderEmailEnabled: v })}
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="text-[10px] text-[#8888aa]">
          Min idle hours before reminder
          <input
            type="number"
            min={1}
            max={24 * 30}
            value={local.draftReminderMinIdleHours}
            onChange={(e) =>
              update({
                draftReminderMinIdleHours: Math.max(
                  1,
                  parseInt(e.target.value, 10) || 1,
                ),
              })
            }
            className="mt-1 w-full text-xs bg-[#0D0D11] border border-[#1E1E2E] rounded px-2 py-1 text-[#E8E8F0]"
          />
        </label>
        <label className="text-[10px] text-[#8888aa]">
          Max reminders per project / week
          <input
            type="number"
            min={0}
            max={14}
            value={local.draftReminderMaxPerWeek}
            onChange={(e) =>
              update({
                draftReminderMaxPerWeek: Math.max(
                  0,
                  parseInt(e.target.value, 10) || 0,
                ),
              })
            }
            className="mt-1 w-full text-xs bg-[#0D0D11] border border-[#1E1E2E] rounded px-2 py-1 text-[#E8E8F0]"
          />
        </label>
        <label className="text-[10px] text-[#8888aa]">
          Quiet hours start (0–23)
          <input
            type="number"
            min={0}
            max={23}
            value={local.quietHoursStart}
            onChange={(e) =>
              update({
                quietHoursStart: Math.min(
                  23,
                  Math.max(0, parseInt(e.target.value, 10) || 0),
                ),
              })
            }
            className="mt-1 w-full text-xs bg-[#0D0D11] border border-[#1E1E2E] rounded px-2 py-1 text-[#E8E8F0]"
          />
        </label>
        <label className="text-[10px] text-[#8888aa]">
          Quiet hours end (0–23)
          <input
            type="number"
            min={0}
            max={23}
            value={local.quietHoursEnd}
            onChange={(e) =>
              update({
                quietHoursEnd: Math.min(
                  23,
                  Math.max(0, parseInt(e.target.value, 10) || 0),
                ),
              })
            }
            className="mt-1 w-full text-xs bg-[#0D0D11] border border-[#1E1E2E] rounded px-2 py-1 text-[#E8E8F0]"
          />
        </label>
        <label className="text-[10px] text-[#8888aa] col-span-2">
          Time zone
          <input
            type="text"
            value={local.timezone}
            onChange={(e) => update({ timezone: e.target.value })}
            placeholder="e.g. Asia/Kolkata"
            className="mt-1 w-full text-xs bg-[#0D0D11] border border-[#1E1E2E] rounded px-2 py-1 text-[#E8E8F0]"
          />
        </label>
      </div>

      <p className="mt-3 flex items-start gap-1.5 text-[10px] text-[#5a5a7a]">
        <Info size={10} className="shrink-0 mt-0.5" />
        <span>
          Every feature here is opt-in and revocable. Nothing is tied to
          platform reach.
        </span>
      </p>
    </section>
  );
}
