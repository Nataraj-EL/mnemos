import { NextResponse } from 'next/server';
import { PgMemoryRepository } from '@/memory/repository';
import { MemoryIngestionService } from '@/memory/ingestionService';
import { GeminiMemoryExtractor } from '@/memory/geminiExtractor';
import { GeminiEmbeddingProvider } from '@/memory/geminiEmbedding';
import { logTelemetry } from '@/core/logger';
import {
  authenticate,
  checkRateLimit,
  checkRequestSize,
  validateIngestInput,
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

    // 3. Sliding window Rate Limiter
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

    const { userId, content } = body;

    // 4. Input constraints validations
    const validation = validateIngestInput(userId, content);
    if (!validation.valid) {
      return NextResponse.json(
        { status: 'error', error: validation.error, requestId },
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

    // Hardening: Redact raw internal exceptions
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
