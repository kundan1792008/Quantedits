/**
 * POST /api/v1/engagement/drafts/remind
 *
 * Run the draft-reminder scan for the authenticated user. Respects the
 * user's preferences (opt-in, quiet hours, rate limits). Safe to call from
 * a background scheduler or manually from an admin endpoint.
 */

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticate } from "@/lib/engagementHttp";
import { DraftReminder, PushDispatcher } from "@/services/engagement";

export async function POST(request: NextRequest) {
  const authed = await authenticate(request);
  if (authed instanceof Response) return authed;

  const dispatcher = new PushDispatcher(prisma);
  const reminder = new DraftReminder(prisma, dispatcher);
  const results = await reminder.runForUser(authed.id);
  return Response.json({ results }, { status: 200 });
}
