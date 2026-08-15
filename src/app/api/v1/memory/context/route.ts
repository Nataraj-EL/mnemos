import { NextResponse } from 'next/server';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
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

    const embeddingProvider = new GeminiEmbeddingProvider();
    const retriever = new MemoryRetriever(embeddingProvider);
    const assembler = new ContextAssembler();

    // Retrieve memories (enforces active status and user isolation internally)
    const candidates = await retriever.retrieve(userId.trim(), query.trim(), {
      limit: limit * 2,
      includeHistorical: !!includeHistorical,
    });

    const contextResult = assembler.assemble(
      query.trim(),
      candidates,
      maxTokens,
      !!includeHistorical
    );

    // Enforce limit slicing on context items
    let finalItems = contextResult.items;
    if (finalItems.length > limit) {
      finalItems = finalItems.slice(0, limit);
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
