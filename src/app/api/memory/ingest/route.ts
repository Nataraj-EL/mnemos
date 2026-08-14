import { NextResponse } from 'next/server';
import { PgMemoryRepository } from '@/memory/repository';
import { GeminiMemoryExtractor } from '@/memory/geminiExtractor';
import { MemoryIngestionService } from '@/memory/ingestionService';

import { GeminiEmbeddingProvider } from '@/memory/geminiEmbedding';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid request body. Expected JSON.' },
        { status: 400 }
      );
    }

    const { userId, content } = body;

    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return NextResponse.json(
        { error: 'Missing or invalid parameter: userId is required.' },
        { status: 400 }
      );
    }

    if (!content || typeof content !== 'string' || !content.trim()) {
      return NextResponse.json(
        { error: 'Missing or invalid parameter: content is required.' },
        { status: 400 }
      );
    }

    const repository = new PgMemoryRepository();
    const extractor = new GeminiMemoryExtractor();
    const embeddingProvider = new GeminiEmbeddingProvider();
    const service = new MemoryIngestionService(repository, extractor, embeddingProvider);

    const processed = await service.ingest(userId, content);

    return NextResponse.json({
      status: 'success',
      processedCount: processed.length,
      memories: processed,
    });
  } catch (error: unknown) {
    console.error('Ingestion API Error:', error);

    const errorMessage = error instanceof Error ? error.message : '';
    if (errorMessage.includes('GEMINI_API_KEY')) {
      return NextResponse.json(
        { error: 'Memory extraction service is temporarily unavailable.' },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { error: 'An error occurred during memory ingestion.' },
      { status: 500 }
    );
  }
}
