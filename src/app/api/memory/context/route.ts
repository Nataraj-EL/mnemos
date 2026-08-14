import { NextResponse } from 'next/server';
import { GeminiEmbeddingProvider } from '@/memory/geminiEmbedding';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';

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

    const { userId, query, limit: limitInput, maxTokens: maxTokensInput } = body;

    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return NextResponse.json(
        { error: 'Missing or invalid parameter: userId is required.' },
        { status: 400 }
      );
    }

    if (!query || typeof query !== 'string' || !query.trim()) {
      return NextResponse.json(
        { error: 'Missing or invalid parameter: query is required.' },
        { status: 400 }
      );
    }

    const limit = limitInput !== undefined ? parseInt(limitInput, 10) : 10;
    if (isNaN(limit) || limit <= 0 || limit > 100) {
      return NextResponse.json(
        { error: 'Invalid parameter: limit must be a positive integer between 1 and 100.' },
        { status: 400 }
      );
    }

    const maxTokens = maxTokensInput !== undefined ? parseInt(maxTokensInput, 10) : 1500;
    if (isNaN(maxTokens) || maxTokens <= 0 || maxTokens > 100000) {
      return NextResponse.json(
        { error: 'Invalid parameter: maxTokens must be a positive integer between 1 and 100000.' },
        { status: 400 }
      );
    }

    // 1. Retrieve candidates
    const embeddingProvider = new GeminiEmbeddingProvider();
    const retriever = new MemoryRetriever(embeddingProvider);

    // Fetch double the limit from DB to allow for Jaccard deduplication headroom
    const retrievalLimit = limit * 2;
    const candidates = await retriever.retrieve(userId, query, {
      limit: retrievalLimit,
    });

    // 2. Assemble context
    const assembler = new ContextAssembler();
    const result = assembler.assemble(query, candidates, maxTokens);

    // Slice to the requested limit and recalculate final context block to enforce items count limit
    if (result.items.length > limit) {
      result.items = result.items.slice(0, limit);
      const lines = result.items.map((item) => `[${item.type}] ${item.content}`);
      result.context = lines.join('\n');
      result.tokenCount = Math.ceil(result.context.length / 4);
    }

    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error('Context Assembly API Error:', error);

    const errorMessage = error instanceof Error ? error.message : '';
    if (errorMessage.includes('GEMINI_API_KEY')) {
      return NextResponse.json(
        { error: 'Context assembly service is temporarily unavailable.' },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { error: 'An error occurred during context assembly.' },
      { status: 500 }
    );
  }
}
