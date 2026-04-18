/**
 * POST /api/v1/engagement/push/subscribe
 *
 * Persist a Web Push subscription for the authenticated user.
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authenticate, validationError } from "@/lib/engagementHttp";
import { PushDispatcher } from "@/services/engagement";

const BodySchema = z
  .object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    }),
    userAgent: z.string().max(512).optional(),
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
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error.flatten().fieldErrors);

  const dispatcher = new PushDispatcher(prisma);
  await dispatcher.subscribe(authed.id, parsed.data);
  return Response.json({ ok: true }, { status: 201 });
}
