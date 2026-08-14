import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from './generator';

import { logTelemetry } from '@/core/logger';

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
    const startTime = Date.now();
    const correlationId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : 'fallback-uuid-' + Date.now();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let candidates: any[] = [];
    let retrievalLatencyMs = 0;
    let selectedCount = 0;
    let estimatedContextTokens = 0;

    try {
      // 1. Retrieve candidate memories (double limit for Jaccard/Overlap headroom)
      const retrievalLimit = limit * 2;
      const retStart = Date.now();
      candidates = await this.retriever.retrieve(userId, query, {
        limit: retrievalLimit,
      });
      retrievalLatencyMs = Date.now() - retStart;

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

      selectedCount = finalItems.length;
      estimatedContextTokens = assemblyResult.tokenCount;

      // 3. Generate grounded response
      const genStart = Date.now();
      const generatorResult = await this.generator.generateResponse(
        query,
        assemblyResult.context
      );
      const generationLatencyMs = Date.now() - genStart;
      const totalLatencyMs = Date.now() - startTime;

      // 4. Trace memories actually passed into the generator context
      const usedMemories = finalItems.map((item) => ({
        id: item.id,
        type: item.type,
        similarity: item.similarity,
        score: item.score,
      }));

      // Log success telemetry
      logTelemetry({
        correlationId,
        retrievalLatencyMs,
        candidateCount: candidates.length,
        selectedCount,
        estimatedContextTokens,
        generationLatencyMs,
        totalLatencyMs,
        model: process.env.GENERATION_MODEL || 'gemini-3.5-flash',
        status: 'success',
      });

      return {
        response: generatorResult.text,
        usedMemories,
        contextTokenCount: assemblyResult.tokenCount,
      };
    } catch (error: unknown) {
      const totalLatencyMs = Date.now() - startTime;
      // Log error telemetry
      logTelemetry({
        correlationId,
        retrievalLatencyMs,
        candidateCount: candidates.length,
        selectedCount,
        estimatedContextTokens,
        totalLatencyMs,
        model: process.env.GENERATION_MODEL || 'gemini-3.5-flash',
        status: 'error',
        errorCategory: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
  }
}
