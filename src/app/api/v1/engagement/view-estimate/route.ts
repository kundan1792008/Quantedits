/**
 * POST /api/v1/engagement/view-estimate
 *
 * Returns a labeled view estimate for the authenticated user, grounded in
 * their real published-video history. When history is insufficient the
 * response explicitly says so — never a fabricated number.
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authenticate, validationError } from "@/lib/engagementHttp";
import { ViewEstimator } from "@/services/engagement";

const BodySchema = z
  .object({
    durationSec: z.number().min(0).max(86_400).optional(),
    qualityScore: z.number().min(0).max(100).optional(),
  })
  .strict();

const estimator = new ViewEstimator(prisma);

export async function POST(request: NextRequest) {
  const authed = await authenticate(request);
  if (authed instanceof Response) return authed;

  let body: unknown = {};
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return validationError({ _: ["Body must be valid JSON"] });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error.flatten().fieldErrors);

  const estimate = await estimator.estimate(authed.id, parsed.data);
  return Response.json({ estimate }, { status: 200 });
}
