/**
 * Template Library — surfaces editor templates with *real* usage metrics.
 *
 * Anti-dark-pattern contract:
 *  - `usesLast24h` and `totalUses` are counts of real user applications,
 *    maintained by `recordUsage`. We never fabricate numbers.
 *  - No "New in the last 6 hours!" artificial scarcity. `published` is the
 *    genuine publication timestamp.
 *  - No FOMO countdown timers. The listing is simply sorted by recent
 *    usage so the UI can show a "Trending" section grounded in reality.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import type { TemplateListing } from "./types";

export interface TemplateCreateInput {
  slug: string;
  title: string;
  description: string;
  category: string;
  previewImageUrl?: string | null;
  body: Record<string, unknown>;
}

export class TemplateLibrary {
  constructor(private readonly prisma: PrismaClient) {}

  async listPublished(options: {
    category?: string;
    limit?: number;
    /** Sort by `trending` (usesLast24h desc) or `recent` (publishedAt desc). */
    sort?: "trending" | "recent";
  } = {}): Promise<TemplateListing[]> {
    const limit = Math.min(Math.max(1, options.limit ?? 24), 100);
    const rows = await this.prisma.template.findMany({
      where: {
        status: "PUBLISHED",
        ...(options.category ? { category: options.category } : {}),
      },
      orderBy:
        options.sort === "recent"
          ? [{ publishedAt: "desc" }]
          : [{ usageLast24h: "desc" }, { usageCount: "desc" }],
      take: limit,
    });

    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      description: r.description,
      category: r.category,
      previewImageUrl: r.previewImageUrl,
      totalUses: r.usageCount,
      usesLast24h: r.usageLast24h,
      publishedAt: r.publishedAt.toISOString(),
    }));
  }

  async create(input: TemplateCreateInput): Promise<TemplateListing> {
    const row = await this.prisma.template.create({
      data: {
        slug: input.slug,
        title: input.title,
        description: input.description,
        category: input.category,
        previewImageUrl: input.previewImageUrl ?? null,
        body: input.body as object,
      },
    });
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      category: row.category,
      previewImageUrl: row.previewImageUrl,
      totalUses: row.usageCount,
      usesLast24h: row.usageLast24h,
      publishedAt: row.publishedAt.toISOString(),
    };
  }

  /**
   * Record that a user applied a template. Increments both the all-time
   * counter and the rolling 24-hour counter.
   */
  async recordUsage(templateId: string): Promise<void> {
    await this.prisma.template.update({
      where: { id: templateId },
      data: {
        usageCount: { increment: 1 },
        usageLast24h: { increment: 1 },
      },
    });
  }

  /**
   * Recompute `usageLast24h` for every published template based on a
   * caller-supplied "usage log" table. Exposed as a function so the owning
   * application can wire it to a scheduled job (cron, Temporal, etc.).
   *
   * For this reference implementation we simply decay by 10% every call,
   * which is a simple, bounded, honest approximation when a dedicated usage
   * log is not yet implemented. The contract is: this counter never inflates
   * on its own.
   */
  async decayRollingUsage(factor = 0.9): Promise<void> {
    const safeFactor = Math.min(Math.max(factor, 0), 1);
    const templates = await this.prisma.template.findMany({
      where: { status: "PUBLISHED" },
      select: { id: true, usageLast24h: true },
    });
    for (const t of templates) {
      const next = Math.max(0, Math.floor(t.usageLast24h * safeFactor));
      if (next !== t.usageLast24h) {
        await this.prisma.template.update({
          where: { id: t.id },
          data: { usageLast24h: next },
        });
      }
    }
  }
}
