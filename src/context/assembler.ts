import { Memory, MemoryType, normalizeMetadata, deriveLifecycleState } from '@/core/types';
import { ContextItem, ContextResult } from './types';
import { MemoryGovernance } from '@/memory/governance';
import { RETRIEVAL_SETTINGS } from '@/core/config';

export const HALF_LIFE_DAYS = 30;
export const DEDUPLICATION_THRESHOLD = 0.70;

export const SCORING_WEIGHTS = {
  similarity: 0.50,
  importance: 0.20,
  recency: 0.20,
  type: 0.10,
};

export const TYPE_WEIGHTS: Record<MemoryType, number> = {
  PREFERENCE: 1.0,
  DECISION: 0.9,
  FACT: 0.8,
  GOAL: 0.7,
  EVENT: 0.6,
  RELATIONSHIP: 0.6,
};

export interface AssembleOptions {
  includeHistorical?: boolean;
  semanticWeight?: number;
  lexicalWeight?: number;
  diversityThreshold?: number;
}

function redactUUID(id: string): string {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(id)) {
    return `uuid-${id.substring(0, 8)}...`;
  }
  return id;
}

/**
 * Calculates Jaccard similarity between two strings based on normalized word overlap.
 * Ignores casing and punctuation.
 */
export function getJaccardSimilarity(a: string, b: string): number {
  const cleanA = a.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, '');
  const cleanB = b.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, '');

  const wordsA = new Set(cleanA.split(/\s+/).filter((w) => w.length > 0));
  const wordsB = new Set(cleanB.split(/\s+/).filter((w) => w.length > 0));

  if (wordsA.size === 0 && wordsB.size === 0) return 1.0;

  const intersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);

  return intersection.size / union.size;
}

/**
 * Estimates tokens using standard character-based heuristic (1 token ~ 4 chars).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export class ContextAssembler {
  /**
   * Scores, ranks, filters out duplicates, and aggregates retrieved memories into a formatted
   * context block under the requested token budget.
   */
  assemble(
    query: string,
    retrieved: { memory: Memory; similarity: number }[],
    maxTokens: number = 1500,
    options?: AssembleOptions | boolean
  ): ContextResult {
    const includeHistorical = typeof options === 'boolean' ? options : (options?.includeHistorical ?? false);
    const semanticWeight = (options && typeof options === 'object' && options.semanticWeight !== undefined) ? options.semanticWeight : SCORING_WEIGHTS.similarity;
    const diversityThreshold = (options && typeof options === 'object' && options.diversityThreshold !== undefined) ? options.diversityThreshold : RETRIEVAL_SETTINGS.diversityThreshold;

    const filteredSources: { id: string; content: string; reason: string }[] = [];

    // 1. Run conflict detection on the candidate memories to find losing conflict IDs
    const rawMemories = retrieved.map((r) => r.memory);
    const conflicts = MemoryGovernance.detectConflicts(rawMemories);
    const conflictingIds = new Set<string>();
    for (const c of conflicts) {
      for (const id of c.conflictingIds) {
        conflictingIds.add(id);
      }
    }

    // Initialize governance counters
    let allowedCount = 0;
    let downrankedCount = 0;
    let excludedCount = 0;
    const conflictsDetectedCount = conflictingIds.size;
    let lowConfidenceCount = 0;
    let injectionBlockedCount = 0;
    const governanceDetails: Record<
      string,
      { decision: 'ALLOW' | 'DOWNRANK' | 'EXCLUDE'; reasons: string[] }
    > = {};

    // 2. Score candidates using normalized weighted formulas + governance decisions
    const scoredItems: ContextItem[] = [];
    const now = new Date();

    for (const item of retrieved) {
      const { memory, similarity } = item;

      // Governance check
      const gov = MemoryGovernance.govern(memory, { includeHistorical, conflictingIds });
      governanceDetails[memory.id] = {
        decision: gov.decision,
        reasons: gov.reasons,
      };

      // Count stats
      if (gov.decision === 'ALLOW') {
        allowedCount++;
      } else if (gov.decision === 'DOWNRANK') {
        downrankedCount++;
      } else if (gov.decision === 'EXCLUDE') {
        excludedCount++;
      }

      // Check specific categories
      const metadata = normalizeMetadata(memory.metadata, memory.createdAt);
      if (metadata.confidence < 0.5) {
        lowConfidenceCount++;
      }

      const contentLower = memory.content.toLowerCase();
      const unsafeKeywords = [
        'ignore previous instructions',
        'ignore instructions',
        'reveal system prompt',
        'reveal the system prompt',
        'bypass system instructions',
        'override system settings',
        'instead print',
      ];
      const hasUnsafe =
        unsafeKeywords.some((keyword) => contentLower.includes(keyword)) ||
        metadata.unsafe === true;
      if (hasUnsafe) {
        injectionBlockedCount++;
      }

      // If EXCLUDE, discard from context
      if (gov.decision === 'EXCLUDE') {
        filteredSources.push({ id: memory.id, content: memory.content, reason: `Governance exclude: ${gov.reasons.join(', ')}` });
        continue;
      }

      const importanceVal = metadata.importance;
      const normalizedImportance = importanceVal / 10;
      const confidence = metadata.confidence;

      // Recency decay calculation
      const timestampStr = metadata.timestamp;
      const memoryDate = new Date(timestampStr);
      const elapsedMs = Math.max(0, now.getTime() - memoryDate.getTime());
      const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
      const recencyScore = 1 / (1 + elapsedDays / HALF_LIFE_DAYS);

      // Deterministic decay calculation based on time since lastAccessedAt
      const lastAccessedStr = metadata.lastAccessedAt || timestampStr;
      const lastAccessedDate = new Date(lastAccessedStr);
      const elapsedAccessMs = Math.max(0, now.getTime() - lastAccessedDate.getTime());
      const elapsedAccessDays = elapsedAccessMs / (1000 * 60 * 60 * 24);
      const decayFactor = 1 / (1 + elapsedAccessDays / 90);

      // Type weight
      const typeWeight = TYPE_WEIGHTS[memory.type] ?? 0.5;

      const effectiveImportance = normalizedImportance * confidence;
      const effectiveRecency = recencyScore * decayFactor;

      // Final score formula using standard selector weights or configurable semanticWeight
      let score =
        similarity * semanticWeight +
        effectiveImportance * SCORING_WEIGHTS.importance +
        effectiveRecency * SCORING_WEIGHTS.recency +
        typeWeight * SCORING_WEIGHTS.type;

      let reason = `Score ${score.toFixed(3)} [Sim: ${similarity.toFixed(2)}, Imp: ${importanceVal}/10, Conf: ${confidence.toFixed(2)}, Recency: ${recencyScore.toFixed(2)}, Decay: ${decayFactor.toFixed(2)}, Type: ${memory.type}]`;

      // Apply downranking penalty if DOWNRANK decision
      if (gov.decision === 'DOWNRANK') {
        score = score * 0.7;
        reason = `Score ${score.toFixed(3)} (Downranked 0.70x: ${gov.reasons.join(', ')}) [Sim: ${similarity.toFixed(2)}, Imp: ${importanceVal}/10, Conf: ${confidence.toFixed(2)}, Recency: ${recencyScore.toFixed(2)}, Decay: ${decayFactor.toFixed(2)}, Type: ${memory.type}]`;
      }

      scoredItems.push({
        id: memory.id,
        type: memory.type,
        content: memory.content,
        similarity,
        importance: importanceVal,
        score,
        reason,
        status: (metadata.status || 'active') as 'active' | 'superseded',
        governanceDecision: gov.decision,
        governanceReasons: gov.reasons,
        confidence: metadata.confidence,
        lifecycleState: deriveLifecycleState(memory),
        conversationId: metadata.conversationId,
        sourceType: metadata.sourceType,
        sourceTimestamp: metadata.sourceTimestamp,
        createdAt: memory.createdAt,
      });
    }

    // 3. Sort by: hybridScore DESC -> similarity DESC -> createdAt DESC -> stable ID ASC
    scoredItems.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (bTime !== aTime) return bTime - aTime;
      return a.id.localeCompare(b.id);
    });

    // 4. Deduplicate using text Jaccard similarity and configurable diversityThreshold
    const deduplicatedItems: ContextItem[] = [];
    for (const candidate of scoredItems) {
      let isDuplicate = false;
      for (const selected of deduplicatedItems) {
        const jaccard = getJaccardSimilarity(candidate.content, selected.content);

        const cleanCand = candidate.content.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, '');
        const cleanSel = selected.content.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, '');
        const wordsCand = new Set(cleanCand.split(/\s+/).filter((w) => w.length > 0));
        const wordsSel = new Set(cleanSel.split(/\s+/).filter((w) => w.length > 0));
        const intersection = new Set([...wordsCand].filter((x) => wordsSel.has(x)));
        const overlap = wordsCand.size > 0 && wordsSel.size > 0
          ? intersection.size / Math.min(wordsCand.size, wordsSel.size)
          : 0;

        const similarityScore = Math.max(jaccard, overlap);
        if (similarityScore > diversityThreshold) {
          isDuplicate = true;
          filteredSources.push({ id: candidate.id, content: candidate.content, reason: `Deduplication overlap: ${(similarityScore * 100).toFixed(0)}% > ${(diversityThreshold * 100).toFixed(0)}%` });
          break;
        }
      }
      if (!isDuplicate) {
        deduplicatedItems.push(candidate);
      }
    }

    // 5. Aggregate items under token budget constraint (applying check on COMPLETE context)
    const selectedItems: ContextItem[] = [];
    let compiledContext = '';

    for (const item of deduplicatedItems) {
      const statusTag = item.status === 'superseded' ? 'HISTORICAL' : 'CURRENT';
      const line = `[${item.type}] [${statusTag}] ${item.content}`;
      const candidateContext = compiledContext ? `${compiledContext}\n${line}` : line;
      const candidateTokens = estimateTokens(candidateContext);

      // Defensively stop adding if it exceeds budget
      if (candidateTokens > maxTokens) {
        filteredSources.push({ id: item.id, content: item.content, reason: `Token budget limit: context tokens would exceed ${maxTokens}` });
        continue;
      }

      compiledContext = candidateContext;
      selectedItems.push(item);
    }

    return {
      query,
      items: selectedItems,
      context: compiledContext,
      tokenCount: estimateTokens(compiledContext),
      governance: {
        allowedCount,
        downrankedCount,
        excludedCount,
        conflictsDetectedCount,
        lowConfidenceCount,
        injectionBlockedCount,
        details: governanceDetails,
      },
      diagnostics: {
        retrievedCandidates: retrieved.map((r) => ({ id: redactUUID(r.memory.id), content: r.memory.content, similarity: r.similarity })),
        acceptedSources: selectedItems.map((item) => ({ id: redactUUID(item.id), content: item.content })),
        filteredSources: filteredSources.map((f) => ({ id: redactUUID(f.id), content: f.content, reason: f.reason })),
        finalContextCount: selectedItems.length,
      },
    };
  }
}
