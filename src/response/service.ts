import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from './generator';

export interface ContextualResponseResult {
  response: string;
  usedMemories: {
    id: string;
    type: string;
    similarity: number;
    score: number;
  }[];
  contextTokenCount: number;
}

export class ResponseService {
  constructor(
    private retriever: MemoryRetriever,
    private assembler: ContextAssembler,
    private generator: ResponseGenerator
  ) {}

  /**
   * Orchestrates candidate retrieval, context assembly (ranking, deduplication, budget filtering),
   * and grounded response generation.
   */
  async respond(
    userId: string,
    query: string,
    options?: { limit?: number; maxTokens?: number }
  ): Promise<ContextualResponseResult> {
    if (!userId || !userId.trim()) {
      throw new Error('User ID is required.');
    }
    if (!query || !query.trim()) {
      throw new Error('Query is required.');
    }

    const limit = options?.limit ?? 10;
    const maxTokens = options?.maxTokens ?? 1500;

    // 1. Retrieve candidate memories (double limit for Jaccard/Overlap headroom)
    const retrievalLimit = limit * 2;
    const candidates = await this.retriever.retrieve(userId, query, {
      limit: retrievalLimit,
    });

    // 2. Assemble context
    const assemblyResult = this.assembler.assemble(query, candidates, maxTokens);

    // Enforce limit slicing on context items
    let finalItems = assemblyResult.items;
    if (finalItems.length > limit) {
      finalItems = finalItems.slice(0, limit);
      // Reassemble context block to keep text block and token counts synced
      const lines = finalItems.map((item) => `[${item.type}] ${item.content}`);
      assemblyResult.context = lines.join('\n');
      assemblyResult.tokenCount = Math.ceil(assemblyResult.context.length / 4);
    }

    // 3. Generate grounded response
    const generatorResult = await this.generator.generateResponse(
      query,
      assemblyResult.context
    );

    // 4. Trace memories actually passed into the generator context
    const usedMemories = finalItems.map((item) => ({
      id: item.id,
      type: item.type,
      similarity: item.similarity,
      score: item.score,
    }));

    return {
      response: generatorResult.text,
      usedMemories,
      contextTokenCount: assemblyResult.tokenCount,
    };
  }
}
