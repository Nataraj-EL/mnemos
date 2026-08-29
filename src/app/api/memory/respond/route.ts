import { NextResponse } from 'next/server';
import { GeminiEmbeddingProvider } from '@/memory/geminiEmbedding';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { GeminiResponseGenerator } from '@/response/geminiGenerator';
import { ResponseService } from '@/response/service';
import { PgMemoryRepository } from '@/memory/repository';
import { ConversationRetriever } from '@/conversation/retriever';

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

    const { userId, query, limit: limitInput, maxTokens: maxTokensInput, includeHistorical } = body;

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

    // Initialize dependencies
    const embeddingProvider = new GeminiEmbeddingProvider();
    const retriever = new MemoryRetriever(embeddingProvider);
    const assembler = new ContextAssembler();
    const generator = new GeminiResponseGenerator();
    const repository = new PgMemoryRepository();
    const conversationRetriever = new ConversationRetriever();
    const service = new ResponseService(retriever, assembler, generator, repository, conversationRetriever);

    const result = await service.respond(userId, query, {
      limit,
      maxTokens,
      includeHistorical: includeHistorical !== undefined ? !!includeHistorical : undefined,
    });

    return NextResponse.json({
      status: 'success',
      ...result,
    });
  } catch (error: unknown) {
    console.error('Contextual Response API Error:', error);

    const errorMessage = error instanceof Error ? error.message : '';
    if (errorMessage.includes('GEMINI_API_KEY')) {
      return NextResponse.json(
        { error: 'Grounded response service is temporarily unavailable.' },
        { status: 503 }
      );
    }

    if (errorMessage.includes('429') || errorMessage.toLowerCase().includes('quota') || errorMessage.toLowerCase().includes('rate limit')) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Please wait a moment and try again.' },
        { status: 429 }
      );
    }

    return NextResponse.json(
      { error: 'An error occurred during contextual response generation.' },
      { status: 500 }
    );
  }
}
