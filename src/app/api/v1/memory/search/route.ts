import { NextResponse } from 'next/server';
import { MemoryRetriever } from '@/memory/retriever';
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

    const { userId, query, limit: limitInput } = body;
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

    const embeddingProvider = new GeminiEmbeddingProvider();
    const retriever = new MemoryRetriever(embeddingProvider);

    const results = await retriever.retrieve(userId.trim(), query.trim(), { limit });
    const latency = Date.now() - startTime;

    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'success',
      model: process.env.EMBEDDING_MODEL || 'gemini-embedding-2',
      candidateCount: results.length,
    });

    return NextResponse.json({
      status: 'success',
      data: { results },
      requestId,
    });
  } catch (error: unknown) {
    const latency = Date.now() - startTime;
    const isTimeout = error instanceof Error && error.message.includes('timeout');
    const displayError = isTimeout
      ? 'The search request timed out while generating search vector embeddings.'
      : 'An error occurred during memory search.';

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
