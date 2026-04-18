/**
 * User preference endpoints — central opt-in/opt-out store.
 *
 * GET   /api/v1/engagement/preferences
 * PATCH /api/v1/engagement/preferences
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authenticate, validationError } from "@/lib/engagementHttp";

async function getOrCreatePrefs(userId: string) {
  return prisma.userPreferences.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
}

export async function GET(request: NextRequest) {
  const authed = await authenticate(request);
  if (authed instanceof Response) return authed;
  const prefs = await getOrCreatePrefs(authed.id);
  return Response.json({ preferences: prefs }, { status: 200 });
}

const PatchSchema = z
  .object({
    suggestionsEnabled: z.boolean().optional(),
    qualityChecklistEnabled: z.boolean().optional(),
    viewEstimatesEnabled: z.boolean().optional(),
    streakEnabled: z.boolean().optional(),
    draftReminderPushEnabled: z.boolean().optional(),
    draftReminderEmailEnabled: z.boolean().optional(),
    draftReminderMinIdleHours: z.number().int().min(1).max(24 * 365).optional(),
    draftReminderMaxPerWeek: z.number().int().min(0).max(14).optional(),
    quietHoursStart: z.number().int().min(0).max(23).optional(),
    quietHoursEnd: z.number().int().min(0).max(23).optional(),
    timezone: z.string().min(1).max(64).optional(),
  })
  .strict();

export async function PATCH(request: NextRequest) {
  const authed = await authenticate(request);
  if (authed instanceof Response) return authed;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError({ _: ["Body must be valid JSON"] });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error.flatten().fieldErrors);

  const updated = await prisma.userPreferences.upsert({
    where: { userId: authed.id },
    update: parsed.data,
    create: { userId: authed.id, ...parsed.data },
  });
  return Response.json({ preferences: updated }, { status: 200 });
}
