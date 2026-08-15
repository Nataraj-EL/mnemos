import { NextResponse } from 'next/server';
import { PgMemoryRepository } from '@/memory/repository';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { GeminiResponseGenerator } from '@/response/geminiGenerator';
import { ResponseService } from '@/response/service';
import { GeminiEmbeddingProvider } from '@/memory/geminiEmbedding';
import { logTelemetry } from '@/core/logger';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const requestId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'req-' + Date.now();
  const startTime = Date.now();

  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { status: 'error', error: 'Invalid JSON request body.', requestId },
        { status: 400 }
      );
    }

    const { userId, query, limit: limitInput, maxTokens: maxTokensInput, includeHistorical } = body;
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return NextResponse.json(
        { status: 'error', error: 'Missing parameter: userId is required.', requestId },
        { status: 400 }
      );
    }
    if (!query || typeof query !== 'string' || !query.trim()) {
      return NextResponse.json(
        { status: 'error', error: 'Missing parameter: query is required.', requestId },
        { status: 400 }
      );
    }

    const limit = limitInput !== undefined ? parseInt(limitInput, 10) : 10;
    if (isNaN(limit) || limit <= 0 || limit > 100) {
      return NextResponse.json(
        {
          status: 'error',
          error: 'Invalid parameter: limit must be an integer between 1 and 100.',
          requestId,
        },
        { status: 400 }
      );
    }

    const maxTokens = maxTokensInput !== undefined ? parseInt(maxTokensInput, 10) : 1500;
    if (isNaN(maxTokens) || maxTokens <= 0 || maxTokens > 100000) {
      return NextResponse.json(
        {
          status: 'error',
          error: 'Invalid parameter: maxTokens must be an integer between 1 and 100000.',
          requestId,
        },
        { status: 400 }
      );
    }

    const repository = new PgMemoryRepository();
    const embeddingProvider = new GeminiEmbeddingProvider();
    const retriever = new MemoryRetriever(embeddingProvider);
    const assembler = new ContextAssembler();
    const generator = new GeminiResponseGenerator();
    const service = new ResponseService(retriever, assembler, generator, repository);

    const result = await service.respond(userId.trim(), query.trim(), {
      limit,
      maxTokens,
      includeHistorical: includeHistorical !== undefined ? !!includeHistorical : undefined,
    });

    const latency = Date.now() - startTime;
    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'success',
      model: process.env.GENERATION_MODEL || 'gemini-3.5-flash',
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
    const isTimeout = error instanceof Error && error.message.includes('timeout');
    const displayError = isTimeout
      ? 'The grounded response request timed out while communicating with external model provider.'
      : 'An error occurred during contextual response generation.';

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
