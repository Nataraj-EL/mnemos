import { NextResponse } from 'next/server';
import { PgConversationRepository } from '@/conversation/repository';
import { ConversationMemoryExtractionService } from '@/conversation/extractionService';
import { MemoryIngestionService } from '@/memory/ingestionService';
import { PgMemoryRepository } from '@/memory/repository';
import { GeminiMemoryExtractor } from '@/memory/geminiExtractor';
import { GeminiEmbeddingProvider } from '@/memory/geminiEmbedding';
import { GeminiConversationSummarizer } from '@/conversation/summarizer';
import { ConversationIntelligenceService } from '@/conversation/intelligenceService';
import { logTelemetry } from '@/core/logger';
import {
  authenticate,
  checkRateLimit,
  checkRequestSize,
} from '@/memory/security';

export const dynamic = 'force-dynamic';

const MAX_JSON_SIZE_BYTES = 50 * 1024; // 50KB

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'req-' + Date.now();
  const startTime = Date.now();
  const { id } = await params;

  try {
    // 1. Defend request size limits
    if (!checkRequestSize(request.headers, MAX_JSON_SIZE_BYTES)) {
      return NextResponse.json(
        {
          status: 'error',
          error: 'Payload Too Large: Request body size limit of 50 KB exceeded.',
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

    // 3. Rate Limiter check
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

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { status: 'error', error: 'Invalid request body. Expected JSON.', requestId },
        { status: 400 }
      );
    }

    const { userId, operation } = body;

    // 4. Input validations
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return NextResponse.json(
        { status: 'error', error: 'Missing or invalid parameter: userId is required.', requestId },
        { status: 400 }
      );
    }

    if (!operation || typeof operation !== 'string' || !operation.trim()) {
      return NextResponse.json(
        { status: 'error', error: 'Missing or invalid parameter: operation is required.', requestId },
        { status: 400 }
      );
    }

    if (operation !== 'summarize' && operation !== 'extract-memories') {
      return NextResponse.json(
        { status: 'error', error: 'Invalid parameter: operation must be "summarize" or "extract-memories".', requestId },
        { status: 400 }
      );
    }

    if (!id || typeof id !== 'string' || !id.trim()) {
      return NextResponse.json(
        { status: 'error', error: 'Missing or invalid parameter: conversationId is required.', requestId },
        { status: 400 }
      );
    }

    // Initialize services
    const repo = new PgConversationRepository();
    const ingestionService = new MemoryIngestionService(
      new PgMemoryRepository(),
      new GeminiMemoryExtractor(),
      new GeminiEmbeddingProvider()
    );
    const extractionService = new ConversationMemoryExtractionService(repo, ingestionService);
    const summarizer = new GeminiConversationSummarizer();
    const intelligenceService = new ConversationIntelligenceService(repo, extractionService, summarizer);

    // 5. Execute operation
    if (operation === 'summarize') {
      const summary = await intelligenceService.summarize(id, userId);

      const latency = Date.now() - startTime;
      logTelemetry({
        correlationId: requestId,
        totalLatencyMs: latency,
        status: 'success',
        model: 'gemini-1.5-flash',
      });

      return NextResponse.json({
        status: 'success',
        data: {
          conversationId: id,
          operation,
          summary,
        },
        requestId,
      });
    } else {
      const result = await intelligenceService.extractMemories(id, userId);

      const latency = Date.now() - startTime;
      logTelemetry({
        correlationId: requestId,
        totalLatencyMs: latency,
        status: 'success',
        model: 'gemini-1.5-flash',
      });

      return NextResponse.json({
        status: 'success',
        data: {
          conversationId: id,
          operation,
          extractedCount: result.count,
          memoryIds: result.ids,
        },
        requestId,
      });
    }
  } catch (error: unknown) {
    const latency = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    const statusCode = (error as { statusCode?: number }).statusCode || 500;

    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'error',
      errorCategory: statusCode === 409 ? 'CONCURRENCY_ERROR' : 'PROVIDER_FAILURE',
    });

    if (errorMsg.includes('GEMINI_API_KEY')) {
      return NextResponse.json(
        {
          status: 'error',
          error: 'AI intelligence service is temporarily unavailable.',
          requestId,
        },
        { status: 503 }
      );
    }

    // Friendly inline error mapping without exposing raw stack trace / system credentials
    const friendlyError = statusCode === 409
      ? errorMsg
      : statusCode === 403
      ? errorMsg
      : statusCode === 404
      ? errorMsg
      : statusCode === 422
      ? errorMsg
      : 'An error occurred during conversation intelligence processing.';

    return NextResponse.json(
      {
        status: 'error',
        error: friendlyError,
        requestId,
      },
      { status: statusCode }
    );
  }
}
