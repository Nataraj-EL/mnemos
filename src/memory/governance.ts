import { Memory, normalizeMetadata, deriveLifecycleState } from '@/core/types';
import { getJaccardSimilarity } from '@/context/assembler';

export type GovernanceDecisionType = 'ALLOW' | 'DOWNRANK' | 'EXCLUDE';

export interface GovernanceDecision {
  decision: GovernanceDecisionType;
  reasons: string[];
}

export interface DetectedConflict {
  primaryId: string;
  conflictingIds: string[];
  content: string;
}

export class MemoryGovernance {
  /**
   * Helper to check if two sentences have opposing polarity words.
   */
  static hasContradictoryPolarity(a: string, b: string): boolean {
    const negations = ['not', 'no', 'never', "don't", 'dont', 'cannot', 'cant', "can't", 'stop', 'avoid'];
    const wordsA = a.toLowerCase().split(/\s+/);
    const wordsB = b.toLowerCase().split(/\s+/);

    const hasNegA = wordsA.some((w) => negations.includes(w));
    const hasNegB = wordsB.some((w) => negations.includes(w));

    return hasNegA !== hasNegB;
  }

  /**
   * Checks if two highly similar sentences contain competing values/choices for the same slots.
   */
  static areCompetingValues(a: string, b: string): boolean {
    if (this.hasContradictoryPolarity(a, b)) {
      return true;
    }

    const getValues = (text: string) => {
      const lower = text.toLowerCase();
      const stopwords = new Set([
        'i', 'you', 'he', 'she', 'they', 'we', 'my', 'your', 'their', 'our',
        'prefers', 'prefer', 'likes', 'like', 'prefers using', 'prefer using',
        'using', 'for', 'to', 'in', 'on', 'at', 'with', 'a', 'an', 'the',
        'is', 'are', 'was', 'were', 'am', 'be', 'been', 'have', 'has', 'had',
        'do', 'does', 'did', 'switched', 'transitioned', 'changed', 'of', 'and',
        'use', 'configured', 'setup', 'want', 'learn', 'work', 'develop',
        'developer', 'development', 'programming', 'code', 'coding', 'language',
        'database', 'db', 'framework', 'library', 'tool', 'stack'
      ]);

      return new Set(
        lower
          .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, '')
          .split(/\s+/)
          .filter((w) => w.length > 0 && !stopwords.has(w))
      );
    };

    const valsA = getValues(a);
    const valsB = getValues(b);

    const diffA = [...valsA].filter((x) => !valsB.has(x));
    const diffB = [...valsB].filter((x) => !valsA.has(x));

    // Both sides must contain unique differing content terms to represent competing value choices
    return diffA.length > 0 && diffB.length > 0;
  }

  /**
   * Scans retrieved active memories to find pairs of compatible memory type and subject
   * with high Jaccard overlap that have conflicting polarities or competing values.
   */
  static detectConflicts(memories: Memory[]): DetectedConflict[] {
    const activeMemories = memories.filter(
      (m) => (m.metadata.status || 'active') !== 'superseded'
    );

    const conflicts: DetectedConflict[] = [];
    const processed = new Set<string>();

    for (let i = 0; i < activeMemories.length; i++) {
      const current = activeMemories[i];
      if (processed.has(current.id)) continue;

      const cluster: Memory[] = [current];

      for (let j = i + 1; j < activeMemories.length; j++) {
        const candidate = activeMemories[j];
        if (processed.has(candidate.id)) continue;

        // Requirement 1: Compatible type
        if (current.type !== candidate.type) continue;

        // Requirement 2: High textual overlap (Jaccard similarity >= 0.70)
        const jaccard = getJaccardSimilarity(current.content, candidate.content);
        if (jaccard < 0.70) continue;

        // Requirement 3: Contradictory polarity or competing values
        if (this.areCompetingValues(current.content, candidate.content)) {
          cluster.push(candidate);
        }
      }

      if (cluster.length > 1) {
        // Sort to determine preferred primary memory:
        // Highest confidence, then highest importance, then newest (createdAt or timestamp)
        cluster.sort((a, b) => {
          const aMeta = normalizeMetadata(a.metadata, a.createdAt);
          const bMeta = normalizeMetadata(b.metadata, b.createdAt);

          if (bMeta.confidence !== aMeta.confidence) {
            return bMeta.confidence - aMeta.confidence;
          }
          if (bMeta.importance !== aMeta.importance) {
            return bMeta.importance - aMeta.importance;
          }
          const aTime = new Date(aMeta.timestamp || a.createdAt).getTime();
          const bTime = new Date(bMeta.timestamp || b.createdAt).getTime();
          return bTime - aTime; // Newest first
        });

        const primary = cluster[0];
        const conflictingIds = cluster.slice(1).map((m) => m.id);

        conflicts.push({
          primaryId: primary.id,
          conflictingIds,
          content: primary.content,
        });

        // Mark all as processed to prevent duplicate conflict entries
        cluster.forEach((m) => processed.add(m.id));
      }
    }

    return conflicts;
  }

  /**
   * Evaluates a memory against safety, quality, and conflict guidelines.
   */
  static govern(
    memory: Memory,
    options: {
      includeHistorical?: boolean;
      conflictingIds?: Set<string>;
    } = {}
  ): GovernanceDecision {
    const reasons: string[] = [];
    const metadata = normalizeMetadata(memory.metadata, memory.createdAt);
    const state = deriveLifecycleState(memory);

    // Calculate decay factor
    const lastAccessedStr = metadata.lastAccessedAt || metadata.timestamp;
    const lastAccessedDate = new Date(lastAccessedStr);
    const elapsedMs = Math.max(0, Date.now() - lastAccessedDate.getTime());
    const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
    const decayFactor = 1 / (1 + elapsedDays / 90);

    // 1. Superseded status
    if (metadata.status === 'superseded') {
      if (!options.includeHistorical) {
        return { decision: 'EXCLUDE', reasons: ['Memory is superseded'] };
      } else {
        reasons.push('Historical memory allowed via query option');
      }
    }

    // 2. Conservative Prompt Injection Screening
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
    const hasUnsafe = unsafeKeywords.some((keyword) => contentLower.includes(keyword));
    if (hasUnsafe || metadata.unsafe === true) {
      return {
        decision: 'EXCLUDE',
        reasons: ['Potential prompt injection or safety risk detected'],
      };
    }

    // 3. Confidence check (EXCLUDE < 0.3)
    if (metadata.confidence < 0.3) {
      return {
        decision: 'EXCLUDE',
        reasons: [`Confidence too low (${metadata.confidence.toFixed(2)} < 0.3)`],
      };
    }

    // 4. Importance check (EXCLUDE < 2)
    if (metadata.importance < 2) {
      return {
        decision: 'EXCLUDE',
        reasons: [`Importance too low (${metadata.importance} < 2)`],
      };
    }

    // 5. Conflict signal (exclude from context if it is the non-preferred conflicting node)
    if (options.conflictingIds?.has(memory.id)) {
      return {
        decision: 'EXCLUDE',
        reasons: ['Excluded due to active temporal conflict with a newer/higher-confidence memory'],
      };
    }

    // 6. Low confidence downranking (confidence < 0.5 but >= 0.3)
    if (metadata.confidence < 0.5) {
      reasons.push(`Low confidence (${metadata.confidence.toFixed(2)} < 0.5)`);
      return { decision: 'DOWNRANK', reasons };
    }

    // 7. Fading lifecycle state downranking (state === 'fading' or decayFactor < 0.5)
    if (state === 'fading' || decayFactor < 0.5) {
      reasons.push(`Memory is fading (decay factor: ${decayFactor.toFixed(2)})`);
      return { decision: 'DOWNRANK', reasons };
    }

    return {
      decision: 'ALLOW',
      reasons: reasons.length > 0 ? reasons : ['Meets all safety & quality criteria'],
    };
  }
}
