import { Memory, MemoryType } from '@/core/types';
import { ContextItem, ContextResult } from './types';

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
    maxTokens: number = 1500
  ): ContextResult {
    // 1. Exclude superseded memories defensively
    const activeCandidates = retrieved.filter(
      (item) => item.memory.metadata.status !== 'superseded'
    );

    // 2. Score candidates using normalized weighted formulas
    const scoredItems: ContextItem[] = activeCandidates.map((item) => {
      const { memory, similarity } = item;

      // Normalized Importance (1-10 -> 0.1-1.0)
      const importanceVal = memory.metadata.importance ?? 5;
      const normalizedImportance = importanceVal / 10;

      // Recency decay calculation
      const timestampStr =
        memory.metadata.timestamp ||
        (memory.createdAt ? new Date(memory.createdAt).toISOString() : new Date().toISOString());
      const memoryDate = new Date(timestampStr);
      const now = new Date();
      const elapsedMs = Math.max(0, now.getTime() - memoryDate.getTime());
      const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
      const recencyScore = 1 / (1 + elapsedDays / HALF_LIFE_DAYS);

      // Type weight
      const typeWeight = TYPE_WEIGHTS[memory.type] ?? 0.5;

      // Final score
      const score =
        similarity * SCORING_WEIGHTS.similarity +
        normalizedImportance * SCORING_WEIGHTS.importance +
        recencyScore * SCORING_WEIGHTS.recency +
        typeWeight * SCORING_WEIGHTS.type;

      const reason = `Score ${score.toFixed(3)} [Sim: ${similarity.toFixed(2)}, Imp: ${importanceVal}/10, Recency: ${recencyScore.toFixed(2)}, Type: ${memory.type}]`;

      return {
        id: memory.id,
        type: memory.type,
        content: memory.content,
        similarity,
        importance: importanceVal,
        score,
        reason,
      };
    });

    // 3. Sort by selection score descending
    scoredItems.sort((a, b) => b.score - a.score);

    // 4. Deduplicate using text Jaccard similarity (Threshold = 0.70)
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
        if (similarityScore > DEDUPLICATION_THRESHOLD) {
          isDuplicate = true;
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
      const line = `[${item.type}] ${item.content}`;
      const candidateContext = compiledContext ? `${compiledContext}\n${line}` : line;
      const candidateTokens = estimateTokens(candidateContext);

      // Defensively stop adding if it exceeds budget
      if (candidateTokens > maxTokens) {
        break;
      }

      compiledContext = candidateContext;
      selectedItems.push(item);
    }

    return {
      query,
      items: selectedItems,
      context: compiledContext,
      tokenCount: estimateTokens(compiledContext),
    };
  }
}
