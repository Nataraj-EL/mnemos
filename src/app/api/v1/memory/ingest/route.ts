import { NextResponse } from 'next/server';
import { PgMemoryRepository } from '@/memory/repository';
import { MemoryIngestionService } from '@/memory/ingestionService';
import { GeminiMemoryExtractor } from '@/memory/geminiExtractor';
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

    const { userId, content } = body;
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return NextResponse.json(
        { status: 'error', error: 'Missing parameter: userId is required.', requestId },
        { status: 400 }
      );
    }
    if (!content || typeof content !== 'string' || !content.trim()) {
      return NextResponse.json(
        { status: 'error', error: 'Missing parameter: content is required.', requestId },
        { status: 400 }
      );
    }

    const repository = new PgMemoryRepository();
    const extractor = new GeminiMemoryExtractor();
    const embeddingProvider = new GeminiEmbeddingProvider();
    const service = new MemoryIngestionService(repository, extractor, embeddingProvider);

    const memories = await service.ingest(userId.trim(), content.trim());
    const latency = Date.now() - startTime;

    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'success',
      model: process.env.EXTRACTION_MODEL || 'gemini-1.5-flash',
    });

    return NextResponse.json({
      status: 'success',
      data: { memories },
      requestId,
    });
  } catch (error: unknown) {
    const latency = Date.now() - startTime;
    const isTimeout = error instanceof Error && error.message.includes('timeout');
    const displayError = isTimeout
      ? 'The ingestion request timed out while communicating with external model provider.'
      : 'An error occurred during memory ingestion.';

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
