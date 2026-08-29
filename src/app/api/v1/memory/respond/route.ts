import { NextResponse } from 'next/server';
import { PgMemoryRepository } from '@/memory/repository';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { GeminiResponseGenerator } from '@/response/geminiGenerator';
import { ResponseService } from '@/response/service';
import { GeminiEmbeddingProvider } from '@/memory/geminiEmbedding';
import { logTelemetry } from '@/core/logger';
import { ConversationRetriever } from '@/conversation/retriever';
import {
  authenticate,
  checkRateLimit,
  checkRequestSize,
  validateQueryInput,
} from '@/memory/security';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const requestId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'req-' + Date.now();
  const startTime = Date.now();

  try {
    // 1. Defend content size limits
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

    // 3. Rate limiting
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
        { status: 'error', error: 'Invalid JSON request body.', requestId },
        { status: 400 }
      );
    }

    const { userId, query, limit, maxTokens, includeHistorical } = body;

    // 4. Input validation
    const validation = validateQueryInput(userId, query, limit, maxTokens);
    if (!validation.valid) {
      return NextResponse.json(
        { status: 'error', error: validation.error, requestId },
        { status: 400 }
      );
    }

    const resolvedLimit = limit !== undefined ? Number(limit) : 10;
    const resolvedMaxTokens = maxTokens !== undefined ? Number(maxTokens) : 1500;

    const repository = new PgMemoryRepository();
    const embeddingProvider = new GeminiEmbeddingProvider();
    const retriever = new MemoryRetriever(embeddingProvider);
    const assembler = new ContextAssembler();
    const generator = new GeminiResponseGenerator();
    const conversationRetriever = new ConversationRetriever();
    const service = new ResponseService(retriever, assembler, generator, repository, conversationRetriever);

    const result = await service.respond(userId.trim(), query.trim(), {
      limit: resolvedLimit,
      maxTokens: resolvedMaxTokens,
      includeHistorical: includeHistorical !== undefined ? !!includeHistorical : undefined,
    });

    const latency = Date.now() - startTime;
    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'success',
      model: process.env.GENERATION_MODEL || 'gemini-3.6-flash',
      candidateCount: result.usedMemories.length,
      selectedCount: result.usedMemories.length,
      estimatedContextTokens: result.contextTokenCount,
    });

    return NextResponse.json({
      status: 'success',
      data: result,
      requestId,
    });
  } catch (error: unknown) {
    const latency = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : '';
    const isTimeout = errorMessage.includes('timeout');
    const isRateLimit = errorMessage.includes('429') || errorMessage.toLowerCase().includes('quota') || errorMessage.toLowerCase().includes('rate limit');

    let displayError = 'An error occurred during contextual response generation.';
    let status = 500;
    let errorCategory = 'PROVIDER_FAILURE';

    if (isTimeout) {
      displayError = 'The grounded response request timed out while communicating with external model provider.';
      status = 504;
      errorCategory = 'TIMEOUT';
    } else if (isRateLimit) {
      displayError = 'Rate limit exceeded. Please wait a moment and try again.';
      status = 429;
      errorCategory = 'RATE_LIMIT';
    }

    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'error',
      errorCategory,
    });

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
