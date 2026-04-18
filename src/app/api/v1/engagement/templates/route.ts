/**
 * Templates endpoints.
 *
 * GET  /api/v1/engagement/templates?sort=trending|recent&category=...&limit=...
 * POST /api/v1/engagement/templates           — create a template (admin-style;
 *                                              in this reference impl we
 *                                              gate only by JWT auth).
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authenticate, validationError } from "@/lib/engagementHttp";
import { TemplateLibrary } from "@/services/engagement";

const library = new TemplateLibrary(prisma);

export async function GET(request: NextRequest) {
  // Listing is public-read — no auth needed so the landing page can render
  // trending templates without requiring login.
  const { searchParams } = new URL(request.url);
  const sort = searchParams.get("sort") === "recent" ? "recent" : "trending";
  const category = searchParams.get("category") ?? undefined;
  const limitRaw = parseInt(searchParams.get("limit") ?? "24", 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 24;

  const templates = await library.listPublished({ sort, category, limit });
  return Response.json({ templates }, { status: 200 });
}

const CreateSchema = z
  .object({
    slug: z.string().min(1).max(128).regex(/^[a-z0-9-]+$/),
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(1024),
    category: z.string().min(1).max(64),
    previewImageUrl: z.string().url().optional().nullable(),
    body: z.record(z.string(), z.unknown()),
  })
  .strict();

export async function POST(request: NextRequest) {
  const authed = await authenticate(request);
  if (authed instanceof Response) return authed;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError({ _: ["Body must be valid JSON"] });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error.flatten().fieldErrors);

  const template = await library.create({
    slug: parsed.data.slug,
    title: parsed.data.title,
    description: parsed.data.description,
    category: parsed.data.category,
    previewImageUrl: parsed.data.previewImageUrl ?? null,
    body: parsed.data.body,
  });
  return Response.json({ template }, { status: 201 });
}
