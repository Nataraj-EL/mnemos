import { NextResponse } from 'next/server';
import { PgConversationRepository } from '@/conversation/repository';
import { logTelemetry } from '@/core/logger';
import {
  authenticate,
  checkRateLimit,
} from '@/memory/security';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
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

    const repo = new PgConversationRepository();
    const conversation = await repo.getById(id);

    if (!conversation) {
      return NextResponse.json(
        { status: 'error', error: 'Conversation not found.', requestId },
        { status: 404 }
      );
    }

    // 4. Strict user isolation check
    if (conversation.userId !== userId.trim()) {
      return NextResponse.json(
        { status: 'error', error: 'Forbidden: Access denied to this conversation.', requestId },
        { status: 403 }
      );
    }

    const latency = Date.now() - startTime;
    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'success',
      model: 'postgres-db',
    });

    return NextResponse.json({
      status: 'success',
      data: { conversation },
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
        error: 'An error occurred while retrieving the conversation.',
        requestId,
      },
      { status: 500 }
    );
  }
}
