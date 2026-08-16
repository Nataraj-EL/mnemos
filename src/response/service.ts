import { MemoryRetriever } from '@/memory/retriever';
import { normalizeMetadata } from '@/core/types';
import { ContextAssembler } from '@/context/assembler';
import { ContextResult } from '@/context/types';
import { ResponseGenerator } from './generator';
import { PgMemoryRepository } from '@/memory/repository';
import { logTelemetry } from '@/core/logger';
import { ConversationRetriever, ConversationSnippetResult } from '@/conversation/retriever';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { PerformanceTracker } from './tracker';
import { ResilienceTracker } from './resilience';
import { HealthTracker } from './healthTracker';

export interface ContextualResponseResult {
  response: string;
  usedMemories: {
    id: string;
    type: string;
    similarity: number;
    score: number;
    content?: string;
    confidence?: number;
    lifecycleState?: string;
    conversationId?: string;
    sourceType?: string;
    sourceTimestamp?: string;
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
  evaluation?: {
    relevance: number;
    faithfulness: number;
    citationCorrectness: number;
    contextUtilization: number;
  };
  diagnostics?: {
    timings?: {
      prepLatencyMs: number;
      memoryRetrievalLatencyMs: number;
      conversationRetrievalLatencyMs: number;
      assemblyLatencyMs: number;
      generationLatencyMs: number;
      guardrailLatencyMs: number;
      totalLatencyMs: number;
    };
    cache?: {
      memoryRetrievalHit: boolean;
      conversationRetrievalHit: boolean;
    };
    resilience?: {
      retryCount: number;
      finalOutcome: 'success' | 'failure';
      failureCategory?: string;
    };
    health?: {
      memoryRetrievalSuccess?: boolean;
      conversationRetrievalSuccess?: boolean;
      memoryCacheHit?: boolean;
      conversationCacheHit?: boolean;
      memoryFallbackUsed?: boolean;
      conversationFallbackUsed?: boolean;
      retryOccurred: boolean;
      timeoutOccurred: boolean;
      latencyAvailable: boolean;
    };
  };
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
    options?: {
      limit?: number;
      maxTokens?: number;
      includeHistorical?: boolean;
      evaluationRun?: boolean;
      semanticWeight?: number;
      lexicalWeight?: number;
      minSimilarity?: number;
      diversityThreshold?: number;
      maxConversationSnippets?: number;
    }
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
    const isEval = options?.evaluationRun === true;

    const minSimOverride = isEval ? (options?.minSimilarity ?? RETRIEVAL_SETTINGS.minSimilarity) : undefined;
    const semanticWeight = (isEval && options?.semanticWeight !== undefined) ? options.semanticWeight : RETRIEVAL_SETTINGS.semanticWeight;
    const lexicalWeight = (isEval && options?.lexicalWeight !== undefined) ? options.lexicalWeight : RETRIEVAL_SETTINGS.lexicalWeight;
    const diversityThreshold = (isEval && options?.diversityThreshold !== undefined) ? options.diversityThreshold : RETRIEVAL_SETTINGS.diversityThreshold;
    const maxConversationSnippets = (isEval && options?.maxConversationSnippets !== undefined) ? options.maxConversationSnippets : RETRIEVAL_SETTINGS.maxConversationSnippets;

    // Overrides validations
    if (minSimOverride !== undefined && (minSimOverride < 0 || minSimOverride > 1 || isNaN(minSimOverride))) {
      throw new Error('Invalid minSimilarity threshold. Must be between 0 and 1.');
    }
    if (diversityThreshold < 0 || diversityThreshold > 1 || isNaN(diversityThreshold)) {
      throw new Error('Invalid diversityThreshold. Must be between 0 and 1.');
    }
    if (maxConversationSnippets < 0 || !Number.isInteger(maxConversationSnippets)) {
      throw new Error('Invalid maxConversationSnippets limit. Must be a non-negative integer.');
    }
    if (semanticWeight < 0 || lexicalWeight < 0 || isNaN(semanticWeight) || isNaN(lexicalWeight)) {
      throw new Error('Weights must be non-negative.');
    }
    if (semanticWeight + lexicalWeight <= 0) {
      throw new Error('Combined weight total must be positive.');
    }

    const startTime = Date.now();
    const correlationId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : 'fallback-uuid-' + Date.now();

    const tracker = isEval ? new PerformanceTracker() : undefined;
    if (tracker) {
      tracker.start('total');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let candidates: any[] = [];
    let retrievalLatencyMs = 0;
    let selectedCount = 0;
    let estimatedContextTokens = 0;

    const RETRIEVAL_TIMEOUT = Number(process.env.MEMORY_RETRIEVAL_TIMEOUT) || 8000;
    const CONVERSATION_TIMEOUT = Number(process.env.CONVERSATION_RETRIEVAL_TIMEOUT) || 5000;
    const GENERATION_TIMEOUT = Number(process.env.LLM_GENERATION_TIMEOUT) || 15000;

    const withTimeout = async <T>(
      promiseFactory: (signal: AbortSignal) => Promise<T>,
      timeoutMs: number,
      stageName: string
    ): Promise<T> => {
      const controller = new AbortController();
      const signal = controller.signal;

      let timer: NodeJS.Timeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Timeout: ${stageName} stage exceeded limit of ${timeoutMs}ms`));
        }, timeoutMs);
      });

      try {
        return await Promise.race([
          promiseFactory(signal),
          timeoutPromise,
        ]);
      } finally {
        clearTimeout(timer!);
      }
    };

    if (!isEval) {
      // Original production path: NO timings, NO AbortController, NO query timeouts, returning undefined diagnostics
      try {
        const retrievalLimit = limit * 2;
        candidates = await this.retriever.retrieve(userId, query, {
          limit: retrievalLimit,
          includeHistorical,
        });

        if (includeHistorical && this.repository) {
          const extraCandidates: typeof candidates = [];
          const visitedIds = new Set<string>();

          for (const cand of candidates) {
            let current = cand.memory;
            let depth = 0;

            while (current.metadata.supersedes && depth < 10) {
              const parentId = current.metadata.supersedes;
              if (visitedIds.has(parentId)) {
                break;
              }
              visitedIds.add(parentId);

              const parent = await this.repository.get(parentId);
              if (!parent) break;

              if (parent.userId !== userId) {
                break;
              }

              const inCandidates = candidates.some((c) => c.memory.id === parent.id);
              const inExtra = extraCandidates.some((c) => c.memory.id === parent.id);

              if (!inCandidates && !inExtra) {
                extraCandidates.push({
                  memory: parent,
                  similarity: 0.0,
                });
              }

              current = parent;
              depth++;
            }
          }
          candidates = [...candidates, ...extraCandidates];
        }

        const assemblyResult = this.assembler.assemble(query, candidates, maxTokens, {
          includeHistorical,
          semanticWeight,
          lexicalWeight,
          diversityThreshold,
        });

        let finalItems = assemblyResult.items;
        if (finalItems.length > limit) {
          finalItems = finalItems.slice(0, limit);
          const lines = finalItems.map((item) => {
            const statusTag = item.status === 'superseded' ? 'HISTORICAL' : 'CURRENT';
            return `[${item.type}] [${statusTag}] ${item.content}`;
          });
          assemblyResult.context = lines.join('\n');
          assemblyResult.tokenCount = Math.ceil(assemblyResult.context.length / 4);
        }

        selectedCount = finalItems.length;
        estimatedContextTokens = assemblyResult.tokenCount;

        let conversationSnippets: ConversationSnippetResult[] = [];
        if (this.conversationRetriever) {
          try {
            conversationSnippets = await this.conversationRetriever.retrieveSnippets(userId, query, {
              limitConversations: maxConversationSnippets,
              maxSnippetsPerConversation: 3,
              semanticWeight,
              lexicalWeight,
            });
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
              break;
            }
          }

          combinedContext = [...formattedMemoryLines, ...formattedConversationLines].join('\n');
          finalTokenCount = currentTokens;
        }

        estimatedContextTokens = finalTokenCount;

        const generatorResult = await this.generator.generateResponse(
          query,
          combinedContext
        );

        const usedMemories = finalItems.map((item) => ({
          id: item.id,
          type: item.type,
          similarity: item.similarity,
          score: item.score,
          content: item.content,
          confidence: item.confidence !== undefined ? item.confidence : 0.9,
          lifecycleState: item.lifecycleState || 'stable',
          conversationId: item.conversationId,
          sourceType: item.sourceType,
          sourceTimestamp: item.sourceTimestamp,
        }));

        const usedConversations = finalConversationSnippets.map((s) => ({
          id: s.conversationId,
          conversationId: s.conversationId,
          createdAt: s.createdAt.toISOString(),
          text: s.matchedSnippet || s.text,
          matchedSnippet: s.matchedSnippet || s.text,
          similarity: s.similarity,
        }));

        if (this.repository) {
          const now = new Date();
          const nowStr = now.toISOString();

          for (const item of finalItems) {
            try {
              const memory = await this.repository.get(item.id);
              if (memory && memory.userId === userId) {
                const metadata = normalizeMetadata(memory.metadata, memory.createdAt);
                const newAccessCount = (metadata.accessCount ?? 0) + 1;
                const prevLastAccessedStr = metadata.lastAccessedAt || metadata.timestamp;
                const prevLastAccessed = new Date(prevLastAccessedStr);
                const diffSec = Math.max(0, now.getTime() - prevLastAccessed.getTime()) / 1000;

                let newReinforcementCount = metadata.reinforcementCount ?? 0;
                let newConfidence = metadata.confidence ?? 0.9;

                if (diffSec >= 300) {
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

        const totalLatencyMs = Date.now() - startTime;

        logTelemetry({
          correlationId,
          retrievalLatencyMs: totalLatencyMs,
          candidateCount: candidates.length,
          selectedCount,
          estimatedContextTokens,
          generationLatencyMs: 0,
          totalLatencyMs,
          model: process.env.GENERATION_MODEL || 'gemini-3.5-flash',
          status: 'success',
        });

        const validation = this.validateResponseGrounding(
          query,
          generatorResult.text,
          combinedContext,
          usedMemories,
          usedConversations
        );

        return {
          response: validation.refinedResponse,
          usedMemories,
          contextTokenCount: finalTokenCount,
          usedConversations,
          governance: assemblyResult.governance,
        };
      } catch (error: unknown) {
        const totalLatencyMs = Date.now() - startTime;
        logTelemetry({
          correlationId,
          retrievalLatencyMs: totalLatencyMs,
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

    const memoryHitTracker = { hit: false };
    const conversationHitTracker = { hit: false };
    const memoryFallbackTracker = { used: false };
    const conversationFallbackTracker = { used: false };
    const resilienceTracker = isEval ? new ResilienceTracker() : undefined;
    const healthTracker = isEval ? new HealthTracker() : undefined;

    try {
      // 1. Retrieve candidate memories & 2. Ancestor traversal
      if (tracker) {
        tracker.start('memoryRetrieval');
      }

      if (healthTracker) {
        healthTracker.setMemoryRetrievalSuccess(false); // Assume failure until it succeeds
      }

      candidates = await withTimeout(
        async (signal) => {
          const retrievalLimit = limit * 2;
          const retrieved = await this.retriever.retrieve(userId, query, {
            limit: retrievalLimit,
            includeHistorical,
            tracker,
            signal,
            queryTimeout: RETRIEVAL_TIMEOUT,
            evaluationRun: true,
            cacheHitTracker: memoryHitTracker,
            fallbackTracker: memoryFallbackTracker,
            resilienceTracker,
            ...(minSimOverride !== undefined ? { minSimilarity: minSimOverride } : {}),
          });

          if (signal.aborted) {
            throw new Error('Retrieval aborted');
          }

          let traversed = [...retrieved];
          // Ancestor traversal for temporal queries (bounded, cycle-safe, user-isolated)
          if (includeHistorical && this.repository) {
            const extraCandidates: typeof traversed = [];
            const visitedIds = new Set<string>();

            for (const cand of retrieved) {
              if (signal.aborted) {
                throw new Error('Retrieval aborted');
              }
              let current = cand.memory;
              let depth = 0;

              while (current.metadata.supersedes && depth < 10) {
                if (signal.aborted) {
                  throw new Error('Retrieval aborted');
                }
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

                // Deduplicate
                const inCandidates = retrieved.some((c) => c.memory.id === parent.id);
                const inExtra = extraCandidates.some((c) => c.memory.id === parent.id);

                if (!inCandidates && !inExtra) {
                  extraCandidates.push({
                    memory: parent,
                    similarity: 0.0,
                  });
                }

                current = parent;
                depth++;
              }
            }
            traversed = [...retrieved, ...extraCandidates];
          }
          return traversed;
        },
        RETRIEVAL_TIMEOUT,
        'memoryRetrieval'
      );

      if (healthTracker) {
        healthTracker.setMemoryRetrievalSuccess(true);
        healthTracker.setMemoryCacheHit(memoryHitTracker.hit);
        healthTracker.setMemoryFallbackUsed(memoryFallbackTracker.used);
      }

      if (tracker) {
        tracker.stop('memoryRetrieval');
      }

      // 3. Assemble context
      if (tracker) {
        tracker.start('assembly');
      }
      const assemblyResult = this.assembler.assemble(query, candidates, maxTokens, {
        includeHistorical,
        semanticWeight,
        lexicalWeight,
        diversityThreshold,
      });

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
        const retriever = this.conversationRetriever;
        if (tracker) {
          tracker.start('conversationRetrieval');
        }
        if (healthTracker) {
          healthTracker.setConversationRetrievalSuccess(false); // Assume failure until it succeeds
        }
        try {
          conversationSnippets = await withTimeout(
            async (signal) => {
              return await retriever.retrieveSnippets(userId, query, {
                limitConversations: maxConversationSnippets,
                maxSnippetsPerConversation: 3,
                semanticWeight,
                lexicalWeight,
                queryTimeout: CONVERSATION_TIMEOUT,
                signal,
                evaluationRun: true,
                cacheHitTracker: conversationHitTracker,
                fallbackTracker: conversationFallbackTracker,
                resilienceTracker,
              });
            },
            CONVERSATION_TIMEOUT,
            'conversationRetrieval'
          );
          if (healthTracker) {
            healthTracker.setConversationRetrievalSuccess(true);
            healthTracker.setConversationCacheHit(conversationHitTracker.hit);
            healthTracker.setConversationFallbackUsed(conversationFallbackTracker.used);
          }
        } catch (snippetErr) {
          console.error('Failed to retrieve conversation snippets:', snippetErr);
          if (snippetErr instanceof Error && snippetErr.message.includes('Timeout')) {
            throw snippetErr;
          }
        } finally {
          if (tracker) {
            tracker.stop('conversationRetrieval');
          }
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
      if (tracker) {
        tracker.stop('assembly');
      }

      // 4. Generate grounded response
      if (tracker) {
        tracker.start('generation');
      }
      const generatorResult = await withTimeout(
        async (signal) => {
          return await this.generator.generateResponse(
            query,
            combinedContext,
            { signal, resilienceTracker }
          );
        },
        GENERATION_TIMEOUT,
        'generation'
      );
      if (tracker) {
        tracker.stop('generation');
      }

      // 5. Trace memories actually passed into the generator context
      const usedMemories = finalItems.map((item) => ({
        id: item.id,
        type: item.type,
        similarity: item.similarity,
        score: item.score,
        content: item.content,
        confidence: item.confidence !== undefined ? item.confidence : 0.9,
        lifecycleState: item.lifecycleState || 'stable',
        conversationId: item.conversationId,
        sourceType: item.sourceType,
        sourceTimestamp: item.sourceTimestamp,
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
      const prepLatencyMs = tracker ? (tracker.get('prep') ?? 0) : 0;
      const memoryRetrievalLatencyMs = tracker ? (tracker.get('memoryRetrieval') ?? 0) : 0;
      const conversationRetrievalLatencyMs = tracker ? (tracker.get('conversationRetrieval') ?? 0) : 0;
      retrievalLatencyMs = prepLatencyMs + memoryRetrievalLatencyMs + conversationRetrievalLatencyMs;
      const totalLatencyMs = Date.now() - startTime;

      logTelemetry({
        correlationId,
        retrievalLatencyMs,
        candidateCount: candidates.length,
        selectedCount,
        estimatedContextTokens,
        generationLatencyMs: tracker ? (tracker.get('generation') ?? 0) : (totalLatencyMs - retrievalLatencyMs),
        totalLatencyMs,
        model: process.env.GENERATION_MODEL || 'gemini-3.5-flash',
        status: 'success',
      });

      // --- SPRINT 32: Grounding Validation ---
      if (tracker) {
        tracker.start('guardrail');
      }
      const validation = this.validateResponseGrounding(
        query,
        generatorResult.text,
        combinedContext,
        usedMemories,
        usedConversations
      );
      if (tracker) {
        tracker.stop('guardrail');
      }

      if (tracker) {
        tracker.stop('total');
      }

      let evaluation = undefined;
      if (options?.evaluationRun) {
        const isPersonalQuery = /\b(my|me|i|myself|mine)\b/i.test(query.toLowerCase());
        const hasContext = usedMemories.length > 0 || usedConversations.length > 0;
        const relevance = (isPersonalQuery && !hasContext)
          ? (validation.isValid ? 1.0 : 0.0)
          : 1.0;
        const faithfulness = validation.isValid ? 1.0 : 0.0;

        let citationCorrectness = 1.0;
        const citMatches = generatorResult.text.match(/\[MEMORY\s+([a-zA-Z0-9_-]+)\]|\[PAST\s+CONVERSATION\s+([a-zA-Z0-9_-]+)\]/gi);
        if (citMatches) {
          for (const cit of citMatches) {
            const idM = cit.match(/\[(?:MEMORY|PAST\s+CONVERSATION)\s+([a-zA-Z0-9_-]+)\]/i);
            if (idM) {
              const citId = idM[1];
              const ok = usedMemories.some(m => m.id === citId) || usedConversations.some(c => c.conversationId === citId);
              if (!ok) {
                citationCorrectness = 0.0;
              }
            }
          }
        }

        const contextUtilization = (hasContext && validation.isValid) ? 1.0 : 0.0;

        evaluation = {
          relevance,
          faithfulness,
          citationCorrectness,
          contextUtilization
        };
      }

      if (healthTracker) {
        healthTracker.setLatencyAvailable(true);
        if (resilienceTracker && resilienceTracker.getRetryCount() > 0) {
          healthTracker.setRetryOccurred(true);
        }
      }

      return {
        response: validation.refinedResponse,
        usedMemories,
        contextTokenCount: finalTokenCount,
        usedConversations,
        governance: assemblyResult.governance,
        evaluation,
        diagnostics: options?.evaluationRun ? {
          timings: tracker ? {
            prepLatencyMs: tracker.get('prep') ?? 0,
            memoryRetrievalLatencyMs: tracker.get('memoryRetrieval') ?? 0,
            conversationRetrievalLatencyMs: tracker.get('conversationRetrieval') ?? 0,
            assemblyLatencyMs: tracker.get('assembly') ?? 0,
            generationLatencyMs: tracker.get('generation') ?? 0,
            guardrailLatencyMs: tracker.get('guardrail') ?? 0,
            totalLatencyMs: tracker.get('total') ?? 0,
          } : undefined,
          cache: {
            memoryRetrievalHit: memoryHitTracker.hit,
            conversationRetrievalHit: conversationHitTracker.hit,
          },
          resilience: resilienceTracker ? {
            retryCount: resilienceTracker.getRetryCount(),
            finalOutcome: resilienceTracker.getOutcome(),
            failureCategory: resilienceTracker.getFailureCategory(),
          } : undefined,
          health: healthTracker ? healthTracker.getSummary() : undefined,
        } : undefined,
      };
    } catch (error: unknown) {
      if (resilienceTracker) {
        resilienceTracker.setOutcome('failure');
        resilienceTracker.setFailureCategory(error instanceof Error ? error.name : 'UnknownError');
      }
      if (healthTracker) {
        healthTracker.setLatencyAvailable(false);
        const isTimeout = error instanceof Error && error.message.includes('Timeout');
        if (isTimeout) {
          healthTracker.setTimeoutOccurred(true);
        }
        if (resilienceTracker && resilienceTracker.getRetryCount() > 0) {
          healthTracker.setRetryOccurred(true);
        }
      }
      if (tracker) {
        tracker.stop('total');
      }
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
      if (error instanceof Error && options?.evaluationRun) {
        (error as unknown as { diagnostics?: unknown }).diagnostics = {
          timings: tracker ? {
            prepLatencyMs: tracker.get('prep') ?? 0,
            memoryRetrievalLatencyMs: tracker.get('memoryRetrieval') ?? 0,
            conversationRetrievalLatencyMs: tracker.get('conversationRetrieval') ?? 0,
            assemblyLatencyMs: tracker.get('assembly') ?? 0,
            generationLatencyMs: tracker.get('generation') ?? 0,
            guardrailLatencyMs: tracker.get('guardrail') ?? 0,
            totalLatencyMs: tracker.get('total') ?? 0,
          } : undefined,
          cache: {
            memoryRetrievalHit: memoryHitTracker.hit,
            conversationRetrievalHit: conversationHitTracker.hit,
          },
          resilience: resilienceTracker ? {
            retryCount: resilienceTracker.getRetryCount(),
            finalOutcome: resilienceTracker.getOutcome(),
            failureCategory: resilienceTracker.getFailureCategory(),
          } : undefined,
          health: healthTracker ? healthTracker.getSummary() : undefined,
        };
      }
      throw error;
    }
  }

  private validateResponseGrounding(
    query: string,
    response: string,
    context: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    usedMemories: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    usedConversations: any[]
  ): { isValid: boolean; refinedResponse: string } {
    const queryLower = query.toLowerCase();
    const responseLower = response.toLowerCase();

    // 1. Never expose prompts, internal IDs, provider errors, or developer diagnostics.
    const diagnosticsKeywords = [
      'systemprompt',
      'user memory context',
      'gemini_api_key',
      'api key',
      'database records',
      'architecture',
      'uuid',
      'req-',
      'correlationid',
    ];
    if (diagnosticsKeywords.some((kw) => responseLower.includes(kw))) {
      return { isValid: false, refinedResponse: "I cannot expose internal diagnostics. Please ask another question about your memories." };
    }

    // 2. Prevent presenting personal facts as known when no trustworthy context exists.
    const isPersonalQuery = /\b(my|me|i|myself|mine)\b/i.test(queryLower);
    const hasContext = usedMemories.length > 0 || usedConversations.length > 0;
    if (isPersonalQuery && !hasContext) {
      const statesUnknown = [
        'unknown',
        "don't know",
        "don't have",
        "do not have",
        'not sure',
        'no context',
        'no memories',
        'no user memories',
        'cannot verify',
        'sorry',
        'unable to',
        'not in my memory',
        'no memory'
      ].some(k => responseLower.includes(k));
      if (!statesUnknown) {
        return {
          isValid: false,
          refinedResponse: "I do not have any saved memory context to answer this query. You can add memories or start a conversation to save this information."
        };
      }
    }

    // 3. Ensure only context actually included within the final token budget can be cited.
    const citationMatches = response.match(/\[MEMORY\s+([a-zA-Z0-9_-]+)\]|\[PAST\s+CONVERSATION\s+([a-zA-Z0-9_-]+)\]/gi);
    if (citationMatches) {
      for (const cit of citationMatches) {
        const idMatch = cit.match(/\[(?:MEMORY|PAST\s+CONVERSATION)\s+([a-zA-Z0-9_-]+)\]/i);
        if (idMatch) {
          const citId = idMatch[1];
          const isValidId = usedMemories.some(m => m.id === citId) || usedConversations.some(c => c.conversationId === citId);
          if (!isValidId) {
            return {
              isValid: false,
              refinedResponse: "I cannot retrieve details from that specific cited source. Please ask a query using available memories."
            };
          }
        }
      }
    }

    // 4. Semantic check for word overlap on personal claims
    if (isPersonalQuery && hasContext) {
      const contextWords = new Set(
        context.toLowerCase()
          .replace(/[^\w\s]/g, '')
          .split(/\s+/)
          .filter(w => w.length > 3)
      );

      const ignoreWords = new Set([
        'you', 'your', 'have', 'saved', 'memory', 'memories', 'here', 'are', 'what', 'like', 'likes', 'want', 'wants',
        'about', 'this', 'that', 'from', 'with', 'will', 'would', 'could', 'should', 'been', 'were', 'have', 'has', 'had',
        'stated', 'preference', 'preference', 'preference', 'fact', 'facts', 'goal', 'goals', 'decision', 'decisions',
        'conversation', 'conversations', 'date', 'past', 'information', 'grounded', 'source', 'sources', 'citation',
        'citations'
      ]);

      const responseWords = responseLower
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 3 && !ignoreWords.has(w) && !queryLower.includes(w));

      let mismatchCount = 0;
      for (const w of responseWords) {
        if (!contextWords.has(w)) {
          mismatchCount++;
        }
      }

      if (responseWords.length > 4 && (mismatchCount / responseWords.length) > 0.6) {
        return {
          isValid: false,
          refinedResponse: "I could not fully ground that response in your saved memory context. Some details seem unsupported by the retrieved information."
        };
      }
    }

    return { isValid: true, refinedResponse: response };
  }
}
