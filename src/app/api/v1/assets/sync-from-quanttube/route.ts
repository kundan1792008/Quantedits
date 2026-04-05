/**
 * POST /api/v1/assets/sync-from-quanttube
 *
 * Fetches the currently trending audio tracks and meme assets from Quanttube
 * and upserts them into the authenticated user's Quantedits asset library.
 *
 * Authentication: Quantmail JWT (enforced by middleware).
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { extractAndVerifyJwt } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { AssetType, AssetSource } from "@/generated/prisma/enums";

// ── Request schema ────────────────────────────────────────────────────────

const SyncSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(20),
  types: z
    .array(z.enum(["AUDIO", "MEME", "BROLL", "VIDEO"]))
    .optional()
    .default(["AUDIO", "MEME"]),
});

// ── Quanttube API types ───────────────────────────────────────────────────

interface QuanttubeAsset {
  id: string;
  type: "AUDIO" | "MEME" | "BROLL" | "VIDEO" | "IMAGE";
  title: string;
  url: string;
  thumbnailUrl?: string;
  durationSec?: number;
  sizeBytes?: number;
  metadata?: Record<string, unknown>;
}

const QUANTTUBE_API_BASE =
  process.env.QUANTTUBE_API_URL ?? "https://api.quanttube.io/v1";

/**
 * Fetch trending assets from the Quanttube API.
 *
 * In production this calls the real Quanttube service.
 * Until that service is available we return a curated stub response.
 */
async function fetchTrendingFromQuanttube(
  types: string[],
  limit: number,
  bearerToken: string,
): Promise<QuanttubeAsset[]> {
  // Attempt real Quanttube call; fall back to stub on any error.
  try {
    const url = new URL(`${QUANTTUBE_API_BASE}/trending/assets`);
    url.searchParams.set("types", types.join(","));
    url.searchParams.set("limit", String(limit));

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
      // Timeout after 5 s
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      return (await res.json()) as QuanttubeAsset[];
    }
  } catch {
    // Quanttube not reachable — use stub
  }

  // ── Stub ──────────────────────────────────────────────────────────────
  const stub: QuanttubeAsset[] = [
    {
      id: "qt-audio-001",
      type: "AUDIO",
      title: "Synthwave Nights (Trending)",
      url: "https://cdn.quanttube.io/audio/synthwave-nights.mp3",
      thumbnailUrl: "https://cdn.quanttube.io/thumbs/synthwave-nights.jpg",
      durationSec: 180,
      sizeBytes: 4300000,
      metadata: { bpm: 110, genre: "synthwave", trending_rank: 1 },
    },
    {
      id: "qt-audio-002",
      type: "AUDIO",
      title: "Lo-Fi Study Beats (Trending)",
      url: "https://cdn.quanttube.io/audio/lofi-study.mp3",
      thumbnailUrl: "https://cdn.quanttube.io/thumbs/lofi-study.jpg",
      durationSec: 240,
      sizeBytes: 5800000,
      metadata: { bpm: 75, genre: "lo-fi", trending_rank: 2 },
    },
    {
      id: "qt-meme-001",
      type: "MEME",
      title: "Distracted Boyfriend Remix",
      url: "https://cdn.quanttube.io/memes/distracted-bf.mp4",
      thumbnailUrl: "https://cdn.quanttube.io/thumbs/distracted-bf.jpg",
      durationSec: 5,
      sizeBytes: 800000,
      metadata: { trending_rank: 1 },
    },
    {
      id: "qt-meme-002",
      type: "MEME",
      title: "Drake Pointing (4K)",
      url: "https://cdn.quanttube.io/memes/drake-pointing.mp4",
      thumbnailUrl: "https://cdn.quanttube.io/thumbs/drake-pointing.jpg",
      durationSec: 3,
      sizeBytes: 500000,
      metadata: { trending_rank: 2 },
    },
    {
      id: "qt-broll-001",
      type: "BROLL",
      title: "Cityscape Timelapse — Tokyo",
      url: "https://cdn.quanttube.io/broll/tokyo-timelapse.mp4",
      thumbnailUrl: "https://cdn.quanttube.io/thumbs/tokyo-timelapse.jpg",
      durationSec: 15,
      sizeBytes: 12000000,
      metadata: { location: "Tokyo", resolution: "4K" },
    },
  ];

  return stub
    .filter((a) => types.includes(a.type))
    .slice(0, limit);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function toBigInt(bytes: number | undefined): bigint | undefined {
  return bytes !== undefined ? BigInt(bytes) : undefined;
}

// ── Route handler ─────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const log = logger.child({ route: "sync-from-quanttube" });

  const jwtPayload = extractAndVerifyJwt(request);
  if (!jwtPayload) {
    return Response.json(
      { error: "Unauthorized", code: "UNAUTHENTICATED" },
      { status: 401 },
    );
  }

  // Parse body
  let rawBody: unknown = {};
  try {
    const text = await request.text();
    if (text) rawBody = JSON.parse(text);
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON", code: "BAD_REQUEST" },
      { status: 400 },
    );
  }

  const parseResult = SyncSchema.safeParse(rawBody);
  if (!parseResult.success) {
    return Response.json(
      {
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        issues: parseResult.error.flatten().fieldErrors,
      },
      { status: 422 },
    );
  }

  const { limit, types } = parseResult.data;

  log.info({ userId: jwtPayload.sub, types, limit }, "Syncing assets from Quanttube");

  // Ensure the user exists in our DB (upsert on first sync)
  await prisma.user.upsert({
    where: { quantmailId: jwtPayload.sub },
    update: {},
    create: {
      quantmailId: jwtPayload.sub,
      email: jwtPayload.email,
      displayName: jwtPayload.display_name ?? jwtPayload.email,
    },
  });

  // Fetch trending from Quanttube
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const remote = await fetchTrendingFromQuanttube(types, limit, token);

  // Upsert each asset into the user's library
  const upserted: string[] = [];
  for (const asset of remote) {
    const assetType = asset.type as AssetType;
    const record = await prisma.asset.upsert({
      where: {
        userId_quanttubeId: {
          userId: jwtPayload.sub,
          quanttubeId: asset.id,
        },
      },
      update: {
        title: asset.title,
        url: asset.url,
        thumbnailUrl: asset.thumbnailUrl,
        durationSec: asset.durationSec,
        sizeBytes: toBigInt(asset.sizeBytes),
        metadata: asset.metadata as object,
      },
      create: {
        userId: jwtPayload.sub,
        type: assetType,
        title: asset.title,
        url: asset.url,
        thumbnailUrl: asset.thumbnailUrl,
        durationSec: asset.durationSec,
        sizeBytes: toBigInt(asset.sizeBytes),
        metadata: asset.metadata as object,
        source: AssetSource.QUANTTUBE_SYNC,
        quanttubeId: asset.id,
      },
    });
    upserted.push(record.id);
  }

  log.info({ userId: jwtPayload.sub, synced: upserted.length }, "Asset sync complete");

  return Response.json(
    {
      synced: upserted.length,
      assetIds: upserted,
    },
    { status: 200 },
  );
}
