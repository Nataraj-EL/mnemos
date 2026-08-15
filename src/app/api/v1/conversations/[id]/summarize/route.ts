import { NextResponse } from 'next/server';
import { PgConversationRepository } from '@/conversation/repository';
import { GeminiConversationSummarizer } from '@/conversation/summarizer';
import { logTelemetry } from '@/core/logger';
import {
  authenticate,
  checkRateLimit,
} from '@/memory/security';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: conversationId } = await params;
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

    // 3. Parse request body
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { status: 'error', error: 'Invalid JSON request body.', requestId },
        { status: 400 }
      );
    }

    const { userId } = body;

    // 4. Input constraints validations
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

    const repo = new PgConversationRepository();
    const conversation = await repo.getById(conversationId);

    if (!conversation) {
      return NextResponse.json(
        { status: 'error', error: 'Conversation not found.', requestId },
        { status: 404 }
      );
    }

    // 5. Strict user isolation check
    if (conversation.userId !== userId.trim()) {
      return NextResponse.json(
        { status: 'error', error: 'Forbidden: Access denied to this conversation.', requestId },
        { status: 403 }
      );
    }

    const transcript = conversation.transcript ? conversation.transcript.trim() : '';
    if (!transcript) {
      return NextResponse.json(
        { status: 'error', error: 'Empty transcript: No summary can be generated.', requestId },
        { status: 422 }
      );
    }

    // 6. Generate summary via Gemini Summarizer
    const summarizer = new GeminiConversationSummarizer();
    const summaryText = await summarizer.summarize(transcript);

    // 7. Persist to database (must succeed before reporting 200 OK)
    await repo.updateSummary(conversationId, summaryText);

    const latency = Date.now() - startTime;
    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'success',
      model: process.env.EXTRACTION_MODEL || 'gemini-1.5-flash',
    });

    return NextResponse.json({
      status: 'success',
      data: {
        conversationId,
        summary: summaryText,
      },
      requestId,
    });
  } catch (error: unknown) {
    const latency = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);

    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'error',
      errorCategory: errorMsg.includes('Forbidden')
        ? 'ACCESS_DENIED'
        : errorMsg.includes('not found')
        ? 'NOT_FOUND'
        : 'PROVIDER_FAILURE',
    });

    let status = 500;
    if (errorMsg.includes('Forbidden') || errorMsg.includes('Access denied')) {
      status = 403;
    } else if (errorMsg.includes('not found') || errorMsg.includes('Conversation not found')) {
      status = 404;
    } else if (errorMsg.includes('Empty transcript') || errorMsg.includes('cannot be empty')) {
      status = 422;
    }

    const isClientError = status < 500;
    const displayError = isClientError ? errorMsg : 'An error occurred during conversation summarization.';

    return NextResponse.json(
      {
        status: 'error',
        error: displayError,
        requestId,
      },
      { status }
    );
  }
}
