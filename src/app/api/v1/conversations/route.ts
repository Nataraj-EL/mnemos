import { NextResponse } from 'next/server';
import { PgConversationRepository } from '@/conversation/repository';
import { logTelemetry } from '@/core/logger';
import { GeminiEmbeddingProvider } from '@/memory/geminiEmbedding';
import {
  authenticate,
  checkRateLimit,
  checkRequestSize,
} from '@/memory/security';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const requestId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'req-' + Date.now();
  const startTime = Date.now();

  try {
    // 1. Defend request size limits
    if (!checkRequestSize(request.headers, 100 * 1024)) {
      return NextResponse.json(
        {
          status: 'error',
          error: 'Payload Too Large: Request body size limit of 100 KB exceeded.',
          requestId,
        },
        { status: 413 }
      );
    }

    // 2. Authentication check
    const authResult = authenticate(request.headers);
    if (!authResult.authenticated) {
      return NextResponse.json(
        {
          status: 'error',
          error: authResult.error || 'Unauthorized: Missing or invalid API key.',
          requestId,
        },
        { status: 401 }
      );
    }

    // 3. Sliding window Rate Limiter
    const rateLimitMax = Number(process.env.RATE_LIMIT_MAX_REQUESTS || '100');
    const rateLimitWindow = Number(process.env.RATE_LIMIT_WINDOW_SECONDS || '60');
    const clientIp = request.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateLimitResult = checkRateLimit(clientIp, rateLimitMax, rateLimitWindow);
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        {
          status: 'error',
          error: 'Too Many Requests: Rate limit exceeded. Try again later.',
          requestId,
        },
        { status: 429 }
      );
    }

    // 4. Parse request body
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { status: 'error', error: 'Invalid JSON request body.', requestId },
        { status: 400 }
      );
    }

    const { userId, transcript, startedAt, endedAt, durationSeconds } = body;

    // 5. Input constraints validations
    if (typeof userId !== 'string' || !userId.trim()) {
      return NextResponse.json(
        { status: 'error', error: 'Missing or invalid parameter: userId is required.', requestId },
        { status: 400 }
      );
    }
    if (userId.length > 128) {
      return NextResponse.json(
        { status: 'error', error: 'Invalid parameter: userId cannot exceed 128 characters.', requestId },
        { status: 400 }
      );
    }

    if (typeof transcript !== 'string' || !transcript.trim()) {
      return NextResponse.json(
        { status: 'error', error: 'Missing or invalid parameter: transcript is required.', requestId },
        { status: 400 }
      );
    }
    if (transcript.length > 10000) {
      return NextResponse.json(
        { status: 'error', error: 'Invalid parameter: transcript cannot exceed 10,000 characters.', requestId },
        { status: 400 }
      );
    }

    let parsedStartedAt: Date | undefined = undefined;
    if (startedAt !== undefined && startedAt !== null) {
      parsedStartedAt = new Date(startedAt);
      if (isNaN(parsedStartedAt.getTime())) {
        return NextResponse.json(
          { status: 'error', error: 'Invalid parameter: startedAt must be a valid timestamp.', requestId },
          { status: 400 }
        );
      }
    }

    let parsedEndedAt: Date | undefined = undefined;
    if (endedAt !== undefined && endedAt !== null) {
      parsedEndedAt = new Date(endedAt);
      if (isNaN(parsedEndedAt.getTime())) {
        return NextResponse.json(
          { status: 'error', error: 'Invalid parameter: endedAt must be a valid timestamp.', requestId },
          { status: 400 }
        );
      }
    }

    let parsedDuration: number | undefined = undefined;
    if (durationSeconds !== undefined && durationSeconds !== null) {
      parsedDuration = Number(durationSeconds);
      if (isNaN(parsedDuration) || !Number.isInteger(parsedDuration) || parsedDuration < 0 || parsedDuration > 86400) {
        return NextResponse.json(
          { status: 'error', error: 'Invalid parameter: durationSeconds must be a non-negative integer under 24 hours.', requestId },
          { status: 400 }
        );
      }
    }

    // 6. DB Interaction
    let embedding: number[] | undefined = undefined;
    try {
      const embeddingProvider = new GeminiEmbeddingProvider();
      embedding = await embeddingProvider.generateEmbedding(transcript.trim());
    } catch (embedErr) {
      console.warn('Embedding generation failed for conversation transcript:', embedErr);
    }

    const repo = new PgConversationRepository();
    const created = await repo.create({
      userId: userId.trim(),
      transcript: transcript.trim(),
      startedAt: parsedStartedAt,
      endedAt: parsedEndedAt,
      durationSeconds: parsedDuration,
      embedding,
    });

    const latency = Date.now() - startTime;

    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'success',
      model: 'postgres-db',
    });

    return NextResponse.json({
      status: 'success',
      data: { conversation: created },
      requestId,
    });
  } catch {
    const latency = Date.now() - startTime;
    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'error',
      errorCategory: 'DATABASE_FAILURE',
    });

    return NextResponse.json(
      {
        status: 'error',
        error: 'An error occurred while saving the conversation.',
        requestId,
      },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  const requestId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'req-' + Date.now();
  const startTime = Date.now();

  try {
    // 1. Authentication check
    const authResult = authenticate(request.headers);
    if (!authResult.authenticated) {
      return NextResponse.json(
        {
          status: 'error',
          error: authResult.error || 'Unauthorized: Missing or invalid API key.',
          requestId,
        },
        { status: 401 }
      );
    }

    // 2. Sliding window Rate Limiter
    const rateLimitMax = Number(process.env.RATE_LIMIT_MAX_REQUESTS || '100');
    const rateLimitWindow = Number(process.env.RATE_LIMIT_WINDOW_SECONDS || '60');
    const clientIp = request.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateLimitResult = checkRateLimit(clientIp, rateLimitMax, rateLimitWindow);
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        {
          status: 'error',
          error: 'Too Many Requests: Rate limit exceeded. Try again later.',
          requestId,
        },
        { status: 429 }
      );
    }

    // 3. Parse query arguments
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');
    const limitParam = searchParams.get('limit');

    if (!userId || !userId.trim()) {
      return NextResponse.json(
        { status: 'error', error: 'Missing or invalid parameter: userId is required.', requestId },
        { status: 400 }
      );
    }

    if (userId.length > 128) {
      return NextResponse.json(
        { status: 'error', error: 'Invalid parameter: userId cannot exceed 128 characters.', requestId },
        { status: 400 }
      );
    }

    let limit = 20;
    if (limitParam !== null) {
      const parsedLimit = Number(limitParam);
      if (isNaN(parsedLimit) || !Number.isInteger(parsedLimit) || parsedLimit <= 0 || parsedLimit > 50) {
        return NextResponse.json(
          { status: 'error', error: 'Invalid parameter: limit must be an integer between 1 and 50.', requestId },
          { status: 400 }
        );
      }
      limit = parsedLimit;
    }

    const repo = new PgConversationRepository();
    const list = await repo.listByUser(userId.trim(), limit);
    const latency = Date.now() - startTime;

    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'success',
      model: 'postgres-db',
    });

    return NextResponse.json({
      status: 'success',
      data: { conversations: list },
      requestId,
    });
  } catch {
    const latency = Date.now() - startTime;
    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'error',
      errorCategory: 'DATABASE_FAILURE',
    });

    return NextResponse.json(
      {
        status: 'error',
        error: 'An error occurred while listing conversations.',
        requestId,
      },
      { status: 500 }
    );
  }
}
