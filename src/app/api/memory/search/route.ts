import { NextResponse } from 'next/server';
import { GeminiEmbeddingProvider } from '@/memory/geminiEmbedding';
import { MemoryRetriever } from '@/memory/retriever';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');
    const q = searchParams.get('q');
    const limitParam = searchParams.get('limit');
    const thresholdParam = searchParams.get('threshold');

    if (!userId || !userId.trim()) {
      return NextResponse.json(
        { error: 'Missing or invalid parameter: userId is required.' },
        { status: 400 }
      );
    }

    if (!q || !q.trim()) {
      return NextResponse.json(
        { error: 'Missing or invalid parameter: q (query) is required.' },
        { status: 400 }
      );
    }

    const limit = limitParam ? parseInt(limitParam, 10) : 5;
    if (isNaN(limit) || limit <= 0) {
      return NextResponse.json(
        { error: 'Invalid parameter: limit must be a positive integer.' },
        { status: 400 }
      );
    }

    const threshold = thresholdParam ? parseFloat(thresholdParam) : 0.0;
    if (isNaN(threshold) || threshold < 0.0 || threshold > 1.0) {
      return NextResponse.json(
        { error: 'Invalid parameter: threshold must be a float between 0.0 and 1.0.' },
        { status: 400 }
      );
    }

    const embeddingProvider = new GeminiEmbeddingProvider();
    const retriever = new MemoryRetriever(embeddingProvider);

    const includeHistorical = searchParams.get('includeHistorical') === 'true';

    const results = await retriever.retrieve(userId, q, {
      limit,
      minSimilarity: threshold,
      includeHistorical,
    });

    return NextResponse.json({
      status: 'success',
      results,
    });
  } catch (error: unknown) {
    console.error('Search API Error:', error);

    const errorMessage = error instanceof Error ? error.message : '';
    if (errorMessage.includes('GEMINI_API_KEY')) {
      return NextResponse.json(
        { error: 'Embedding service is temporarily unavailable.' },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { error: 'An error occurred during semantic memory search.' },
      { status: 500 }
    );
  }
}
