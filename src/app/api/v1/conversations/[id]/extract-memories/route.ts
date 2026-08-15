import { NextResponse } from 'next/server';
import { PgConversationRepository } from '@/conversation/repository';
import { ConversationMemoryExtractionService } from '@/conversation/extractionService';
import { MemoryIngestionService } from '@/memory/ingestionService';
import { PgMemoryRepository } from '@/memory/repository';
import { GeminiMemoryExtractor } from '@/memory/geminiExtractor';
import { GeminiEmbeddingProvider } from '@/memory/geminiEmbedding';
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

    // 5. Initialize extraction service and run extraction
    const conversationRepo = new PgConversationRepository();
    const memoryRepo = new PgMemoryRepository();
    const extractor = new GeminiMemoryExtractor();
    const embeddingProvider = new GeminiEmbeddingProvider();
    const ingestionService = new MemoryIngestionService(memoryRepo, extractor, embeddingProvider);
    
    const extractionService = new ConversationMemoryExtractionService(
      conversationRepo,
      ingestionService
    );

    const memories = await extractionService.extract(conversationId, userId.trim());
    const memoryIds = memories.map((m) => m.id);

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
        extractedCount: memories.length,
        memoryIds,
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

    // Custom status codes for specific service errors
    let status = 500;
    if (errorMsg.includes('Forbidden') || errorMsg.includes('Access denied')) {
      status = 403;
    } else if (errorMsg.includes('not found') || errorMsg.includes('Conversation not found')) {
      status = 404;
    } else if (errorMsg.includes('Empty transcript') || errorMsg.includes('transcript is required')) {
      status = 422;
    }

    const isClientError = status < 500;
    const displayError = isClientError ? errorMsg : 'An error occurred during conversation memory extraction.';

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
