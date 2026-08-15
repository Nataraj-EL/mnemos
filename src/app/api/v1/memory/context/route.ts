import { NextResponse } from 'next/server';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { GeminiEmbeddingProvider } from '@/memory/geminiEmbedding';
import { logTelemetry } from '@/core/logger';
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

    const embeddingProvider = new GeminiEmbeddingProvider();
    const retriever = new MemoryRetriever(embeddingProvider);
    const assembler = new ContextAssembler();

    const candidates = await retriever.retrieve(userId.trim(), query.trim(), {
      limit: resolvedLimit * 2,
      includeHistorical: !!includeHistorical,
    });

    const contextResult = assembler.assemble(
      query.trim(),
      candidates,
      resolvedMaxTokens,
      !!includeHistorical
    );

    // Enforce limit slicing on context items
    let finalItems = contextResult.items;
    if (finalItems.length > resolvedLimit) {
      finalItems = finalItems.slice(0, resolvedLimit);
      const lines = finalItems.map((item) => {
        const statusTag = item.status === 'superseded' ? 'HISTORICAL' : 'CURRENT';
        return `[${item.type}] [${statusTag}] ${item.content}`;
      });
      contextResult.context = lines.join('\n');
      contextResult.items = finalItems;
      contextResult.tokenCount = Math.ceil(contextResult.context.length / 4);
    }

    const latency = Date.now() - startTime;
    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'success',
      model: process.env.EMBEDDING_MODEL || 'gemini-embedding-2',
      candidateCount: candidates.length,
      selectedCount: finalItems.length,
      estimatedContextTokens: contextResult.tokenCount,
    });

    return NextResponse.json({
      status: 'success',
      data: contextResult,
      requestId,
    });
  } catch (error: unknown) {
    const latency = Date.now() - startTime;
    const isTimeout = error instanceof Error && error.message.includes('timeout');
    const displayError = isTimeout
      ? 'The context assembly request timed out while generating query vector embeddings.'
      : 'An error occurred during context assembly.';

    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'error',
      errorCategory: isTimeout ? 'TIMEOUT' : 'PROVIDER_FAILURE',
    });

    return NextResponse.json(
      {
        status: 'error',
        error: displayError,
        requestId,
      },
      { status: isTimeout ? 504 : 500 }
    );
  }
}
