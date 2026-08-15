import { MemoryRetriever } from '@/memory/retriever';
import { normalizeMetadata } from '@/core/types';
import { ContextAssembler } from '@/context/assembler';
import { ContextResult } from '@/context/types';
import { ResponseGenerator } from './generator';
import { PgMemoryRepository } from '@/memory/repository';
import { logTelemetry } from '@/core/logger';
import { ConversationRetriever, ConversationSnippetResult } from '@/conversation/retriever';

export interface ContextualResponseResult {
  response: string;
  usedMemories: {
    id: string;
    type: string;
    similarity: number;
    score: number;
    content?: string;
  }[];
  contextTokenCount: number;
  usedConversations?: {
    id: string;
    conversationId: string;
    createdAt: string;
    text: string;
    matchedSnippet: string;
    similarity?: number;
  }[];
  governance?: ContextResult['governance'];
}

export class ResponseService {
  constructor(
    private retriever: MemoryRetriever,
    private assembler: ContextAssembler,
    private generator: ResponseGenerator,
    private repository?: PgMemoryRepository,
    private conversationRetriever?: ConversationRetriever
  ) {}

  private isTemporalQuery(query: string): boolean {
    const temporalKeywords = [
      'before',
      'previously',
      'earlier',
      'used to',
      'changed',
      'history',
      'old',
      'previous',
    ];
    const lower = query.toLowerCase();
    return temporalKeywords.some((keyword) => lower.includes(keyword));
  }

  /**
   * Orchestrates candidate retrieval, context assembly (ranking, deduplication, budget filtering),
   * and grounded response generation.
   */
  async respond(
    userId: string,
    query: string,
    options?: { limit?: number; maxTokens?: number; includeHistorical?: boolean }
  ): Promise<ContextualResponseResult> {
    if (!userId || !userId.trim()) {
      throw new Error('User ID is required.');
    }
    if (!query || !query.trim()) {
      throw new Error('Query is required.');
    }

    const limit = options?.limit ?? 10;
    const maxTokens = options?.maxTokens ?? 1500;
    const includeHistorical =
      options?.includeHistorical !== undefined
        ? options.includeHistorical
        : this.isTemporalQuery(query);

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
        includeHistorical,
      });
      retrievalLatencyMs = Date.now() - retStart;

      // 2. Ancestor traversal for temporal queries (bounded, cycle-safe, user-isolated)
      if (includeHistorical && this.repository) {
        const extraCandidates: typeof candidates = [];
        const visitedIds = new Set<string>();

        for (const cand of candidates) {
          let current = cand.memory;
          let depth = 0;

          while (current.metadata.supersedes && depth < 10) {
            const parentId = current.metadata.supersedes;
            if (visitedIds.has(parentId)) {
              console.warn(`Temporal Traversal: Cycle detected at memory ID ${parentId}`);
              break;
            }
            visitedIds.add(parentId);

            const parent = await this.repository.get(parentId);
            if (!parent) break;

            // Security guard: verify user isolation on traversed ancestor
            if (parent.userId !== userId) {
              console.warn(`Security Warning: Traversal crossed user boundary for ancestor ID ${parentId}`);
              break;
            }

            // Deduplicate: check if parent is already in candidates or extraCandidates
            const inCandidates = candidates.some((c) => c.memory.id === parent.id);
            const inExtra = extraCandidates.some((c) => c.memory.id === parent.id);

            if (!inCandidates && !inExtra) {
              extraCandidates.push({
                memory: parent,
                similarity: 0.0, // Do NOT copy similarity blindly, keep as 0.0
              });
            }

            current = parent;
            depth++;
          }
        }
        candidates = [...candidates, ...extraCandidates];
      }

      // 3. Assemble context
      const assemblyResult = this.assembler.assemble(query, candidates, maxTokens, includeHistorical);

      // Enforce limit slicing on context items
      let finalItems = assemblyResult.items;
      if (finalItems.length > limit) {
        finalItems = finalItems.slice(0, limit);
        // Reassemble context block to keep text block and token counts synced
        const lines = finalItems.map((item) => {
          const statusTag = item.status === 'superseded' ? 'HISTORICAL' : 'CURRENT';
          return `[${item.type}] [${statusTag}] ${item.content}`;
        });
        assemblyResult.context = lines.join('\n');
        assemblyResult.tokenCount = Math.ceil(assemblyResult.context.length / 4);
      }

      selectedCount = finalItems.length;
      estimatedContextTokens = assemblyResult.tokenCount;

      // Sprint 20 Conversation Snippet Retrieval
      let conversationSnippets: ConversationSnippetResult[] = [];
      if (this.conversationRetriever) {
        try {
          conversationSnippets = await this.conversationRetriever.retrieveSnippets(userId, query);
        } catch (snippetErr) {
          console.error('Failed to retrieve conversation snippets:', snippetErr);
        }
      }

      let combinedContext = assemblyResult.context;
      let finalTokenCount = assemblyResult.tokenCount;
      const finalConversationSnippets: ConversationSnippetResult[] = [];

      if (conversationSnippets.length > 0) {
        const memoryLines = assemblyResult.context ? assemblyResult.context.split('\n').filter(Boolean) : [];
        const formattedMemoryLines = memoryLines.map(line => `[MEMORY] ${line}`);
        const formattedConversationLines: string[] = [];

        // Build combined context line by line to respect maxTokens
        let currentTokens = Math.ceil(formattedMemoryLines.join('\n').length / 4);

        for (const s of conversationSnippets) {
          const snippetText = s.matchedSnippet || s.text;
          const line = `[PAST CONVERSATION] [Date: ${s.createdAt.toISOString().split('T')[0]}] ${snippetText}`;
          const snippetTokens = Math.ceil(line.length / 4);
          
          if (currentTokens + snippetTokens <= maxTokens || formattedConversationLines.length === 0) {
            formattedConversationLines.push(line);
            finalConversationSnippets.push(s);
            currentTokens += snippetTokens;
          } else {
            // Exceeds maxTokens budget
            break;
          }
        }

        combinedContext = [...formattedMemoryLines, ...formattedConversationLines].join('\n');
        finalTokenCount = currentTokens;
      }

      estimatedContextTokens = finalTokenCount;

      // 4. Generate grounded response
      const genStart = Date.now();
      const generatorResult = await this.generator.generateResponse(
        query,
        combinedContext
      );
      const generationLatencyMs = Date.now() - genStart;
      const totalLatencyMs = Date.now() - startTime;

      // 5. Trace memories actually passed into the generator context
      const usedMemories = finalItems.map((item) => ({
        id: item.id,
        type: item.type,
        similarity: item.similarity,
        score: item.score,
        content: item.content,
        confidence: item.confidence !== undefined ? item.confidence : 0.9,
        lifecycleState: item.lifecycleState || 'stable',
      }));

      const usedConversations = finalConversationSnippets.map((s) => ({
        id: s.conversationId,
        conversationId: s.conversationId,
        createdAt: s.createdAt.toISOString(),
        text: s.matchedSnippet || s.text,
        matchedSnippet: s.matchedSnippet || s.text,
        similarity: s.similarity,
      }));

      // 5.5 Reinforce memories actually included in the final context
      if (this.repository) {
        const now = new Date();
        const nowStr = now.toISOString();

        for (const item of finalItems) {
          try {
            // Retrieve fresh memory state
            const memory = await this.repository.get(item.id);
            if (memory && memory.userId === userId) {
              const metadata = normalizeMetadata(memory.metadata, memory.createdAt);
              
              // Increment accessCount
              const newAccessCount = (metadata.accessCount ?? 0) + 1;

              // Cooldown calculation: use the PREVIOUS lastAccessedAt for cooldown calculation
              const prevLastAccessedStr = metadata.lastAccessedAt || metadata.timestamp;
              const prevLastAccessed = new Date(prevLastAccessedStr);
              const diffSec = Math.max(0, now.getTime() - prevLastAccessed.getTime()) / 1000;

              let newReinforcementCount = metadata.reinforcementCount ?? 0;
              let newConfidence = metadata.confidence ?? 0.9;

              if (diffSec >= 300) {
                // Cooldown of 300 seconds passed
                newReinforcementCount += 1;
                newConfidence = Math.min(1.0, newConfidence + 0.05);
              }

              await this.repository.update(item.id, {
                metadata: {
                  ...metadata,
                  accessCount: newAccessCount,
                  lastAccessedAt: nowStr,
                  reinforcementCount: newReinforcementCount,
                  confidence: parseFloat(newConfidence.toFixed(4)),
                  lifecycleUpdatedAt: nowStr,
                },
              });
            }
          } catch (reinforceErr) {
            console.error(`Reinforcement failed for memory ${item.id}:`, reinforceErr);
          }
        }
      }

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
        contextTokenCount: finalTokenCount,
        usedConversations,
        governance: assemblyResult.governance,
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
