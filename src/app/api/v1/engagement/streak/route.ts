/**
 * Streak endpoints — opt-in, neutral creation-day counter.
 *
 * GET    /api/v1/engagement/streak          — read current status
 * POST   /api/v1/engagement/streak          — record activity for today
 * PATCH  /api/v1/engagement/streak          — enable/disable/reset
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authenticate, validationError } from "@/lib/engagementHttp";
import { StreakTracker } from "@/services/engagement";

const tracker = new StreakTracker(prisma);

export async function GET(request: NextRequest) {
  const authed = await authenticate(request);
  if (authed instanceof Response) return authed;
  const status = await tracker.getStatus(authed.id);
  return Response.json({ streak: status }, { status: 200 });
}

export async function POST(request: NextRequest) {
  const authed = await authenticate(request);
  if (authed instanceof Response) return authed;
  const status = await tracker.recordActivity(authed.id);
  return Response.json({ streak: status }, { status: 200 });
}

const PatchSchema = z.object({
  enabled: z.boolean().optional(),
  reset: z.boolean().optional(),
});

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

  let status = await tracker.getStatus(authed.id);
  if (parsed.data.enabled !== undefined) {
    status = await tracker.setEnabled(authed.id, parsed.data.enabled);
  }
  if (parsed.data.reset) {
    status = await tracker.reset(authed.id);
  }
  return Response.json({ streak: status }, { status: 200 });
}
