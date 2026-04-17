/**
 * TemplateGallery — grid of editor templates with honest usage stats.
 *
 * Contract:
 *  - Shows real `totalUses` and `usesLast24h` counts. No "847 creators used
 *    it today" fabrications.
 *  - "Trending" sort is simply a sort order — no countdown timers, no "only
 *    available for 6 hours" scarcity cues.
 */

"use client";

import { motion } from "framer-motion";
import { Sparkles, Users, Clock } from "lucide-react";
import type { TemplateListing } from "@/services/engagement/types";

export interface TemplateGalleryProps {
  templates: TemplateListing[];
  loading?: boolean;
  sort?: "trending" | "recent";
  onSortChange?: (sort: "trending" | "recent") => void;
  onApply?: (templateId: string) => void;
}

function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffMs = now.getTime() - then;
  const diffSec = Math.max(0, Math.round(diffMs / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function TemplateGallery({
  templates,
  loading,
  sort = "trending",
  onSortChange,
  onApply,
}: TemplateGalleryProps) {
  return (
    <section
      aria-label="Template library"
      className="rounded-xl p-4"
      style={{ background: "#13131A", border: "1px solid #1E1E2E" }}
    >
      <header className="flex items-center gap-2 mb-3">
        <Sparkles size={14} className="text-[#8888aa]" />
        <h3 className="text-xs font-semibold uppercase tracking-widest text-[#8888aa]">
          Templates
        </h3>
        <div className="ml-auto flex items-center gap-1 text-[10px]">
          <button
            type="button"
            onClick={() => onSortChange?.("trending")}
            className="px-2 py-1 rounded"
            style={{
              background: sort === "trending" ? "#1E1E2E" : "transparent",
              color: sort === "trending" ? "#E8E8F0" : "#5a5a7a",
            }}
          >
            Trending
          </button>
          <button
            type="button"
            onClick={() => onSortChange?.("recent")}
            className="px-2 py-1 rounded"
            style={{
              background: sort === "recent" ? "#1E1E2E" : "transparent",
              color: sort === "recent" ? "#E8E8F0" : "#5a5a7a",
            }}
          >
            Recent
          </button>
        </div>
      </header>

      {loading && templates.length === 0 && (
        <p className="text-xs text-[#5a5a7a]">Loading templates…</p>
      )}

      {!loading && templates.length === 0 && (
        <p className="text-xs text-[#5a5a7a]">No templates published yet.</p>
      )}

      <ul className="grid grid-cols-2 gap-2">
        {templates.map((t) => (
          <motion.li
            key={t.id}
            whileHover={{ scale: 1.01 }}
            className="rounded-lg overflow-hidden cursor-pointer"
            style={{ background: "#0D0D11", border: "1px solid #1E1E2E" }}
            onClick={() => onApply?.(t.id)}
          >
            <div
              className="aspect-video flex items-center justify-center"
              style={{
                background: t.previewImageUrl
                  ? `url(${t.previewImageUrl}) center / cover`
                  : "linear-gradient(135deg, #1E1E2E 0%, #0D0D11 100%)",
              }}
            >
              {!t.previewImageUrl && (
                <Sparkles size={20} className="text-[#3a3a5a]" />
              )}
            </div>
            <div className="p-2">
              <p className="text-[11px] font-semibold text-[#E8E8F0] truncate">
                {t.title}
              </p>
              <p className="text-[10px] text-[#5a5a7a] truncate">
                {t.category}
              </p>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-[#8888aa]">
                <span className="flex items-center gap-1">
                  <Users size={9} />
                  {t.totalUses.toLocaleString()}
                </span>
                <span className="flex items-center gap-1">
                  <Clock size={9} />
                  {relativeTime(t.publishedAt)}
                </span>
              </div>
              {t.usesLast24h > 0 && (
                <p className="text-[9px] text-[#06B6D4] mt-1">
                  {t.usesLast24h.toLocaleString()} use
                  {t.usesLast24h === 1 ? "" : "s"} in the last 24h
                </p>
              )}
            </div>
          </motion.li>
        ))}
      </ul>
    </section>
  );
}
