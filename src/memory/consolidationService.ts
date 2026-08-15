import { Memory } from '@/core/types';
import { PgMemoryRepository } from './repository';
import { getJaccardSimilarity } from '@/context/assembler';
import { normalizeMetadata } from '@/core/types';

export class MemoryConsolidationService {
  constructor(private repository: PgMemoryRepository) {}

  /**
   * Identifies highly similar active memories for a given user, consolidates them,
   * updates the primary record's metadata, and marks duplicates as superseded.
   */
  async consolidate(userId: string): Promise<{
    consolidatedCount: number;
    actions: { primaryId: string; supersededIds: string[] }[];
  }> {
    if (!userId || !userId.trim()) {
      throw new Error('User ID is required for consolidation.');
    }

    // 1. Fetch all memories for the user
    const memories = await this.repository.list({ userId });

    // Filter to active memories only
    const activeMemories = memories.filter((m) => {
      const status = m.metadata.status || 'active';
      return status === 'active';
    });

    const visited = new Set<string>();
    const actions: { primaryId: string; supersededIds: string[] }[] = [];
    let consolidatedCount = 0;

    for (let i = 0; i < activeMemories.length; i++) {
      const current = activeMemories[i];
      if (visited.has(current.id)) continue;

      const duplicates: Memory[] = [];

      for (let j = i + 1; j < activeMemories.length; j++) {
        const candidate = activeMemories[j];
        if (visited.has(candidate.id)) continue;

        // Requirement: same memory type
        if (current.type !== candidate.type) continue;

        // Requirement: Jaccard similarity >= 0.70
        const jaccard = getJaccardSimilarity(current.content, candidate.content);
        if (jaccard < 0.70) continue;

        // Safety Guard: check for contradictory negations to prevent merging conflicting statements
        if (this.hasContradictoryPolarity(current.content, candidate.content)) {
          console.warn(
            `Safety Guard: Bypassed consolidation of potentially conflicting statements: "${current.content}" and "${candidate.content}"`
          );
          continue;
        }

        duplicates.push(candidate);
      }

      if (duplicates.length > 0) {
        // We found duplicates! Including the current memory, this is our cluster
        const cluster = [current, ...duplicates];

        // Mark all cluster IDs as visited
        cluster.forEach((m) => visited.add(m.id));

        // Select the primary memory: highest confidence, then highest importance, then oldest (createdAt ascending)
        cluster.sort((a, b) => {
          const aMeta = normalizeMetadata(a.metadata, a.createdAt);
          const bMeta = normalizeMetadata(b.metadata, b.createdAt);

          if (bMeta.confidence !== aMeta.confidence) {
            return bMeta.confidence - aMeta.confidence; // desc
          }
          if (bMeta.importance !== aMeta.importance) {
            return bMeta.importance - aMeta.importance; // desc
          }
          return a.createdAt.getTime() - b.createdAt.getTime(); // oldest first (asc)
        });

        const primary = cluster[0];
        const supersededMemories = cluster.slice(1);
        const supersededIds = supersededMemories.map((m) => m.id);

        // Consolidation logic:
        const now = new Date();
        const nowStr = now.toISOString();

        const primaryMeta = normalizeMetadata(primary.metadata, primary.createdAt);
        let mergedAccessCount = primaryMeta.accessCount ?? 0;
        let mergedReinforcementCount = primaryMeta.reinforcementCount ?? 0;
        let newestLastAccessed = new Date(primaryMeta.lastAccessedAt || primaryMeta.timestamp);
        const consolidatedFrom = primaryMeta.consolidatedFrom || [];

        // Sum counts and determine newest lastAccessedAt
        for (const duplicate of supersededMemories) {
          const dupMeta = normalizeMetadata(duplicate.metadata, duplicate.createdAt);
          mergedAccessCount += dupMeta.accessCount ?? 0;
          mergedReinforcementCount += dupMeta.reinforcementCount ?? 0;
          consolidatedFrom.push(duplicate.id);

          const dupLastAccessed = new Date(dupMeta.lastAccessedAt || dupMeta.timestamp);
          if (dupLastAccessed > newestLastAccessed) {
            newestLastAccessed = dupLastAccessed;
          }
        }

        // CAP confidence: boost primary confidence by +0.05 per consolidated duplicate, cap at 1.0
        const confidenceBoost = supersededMemories.length * 0.05;
        const newConfidence = Math.min(1.0, primaryMeta.confidence + confidenceBoost);

        // Update the primary memory
        await this.repository.update(primary.id, {
          metadata: {
            ...primaryMeta,
            accessCount: mergedAccessCount,
            reinforcementCount: mergedReinforcementCount,
            lastAccessedAt: newestLastAccessed.toISOString(),
            confidence: parseFloat(newConfidence.toFixed(4)),
            consolidatedFrom,
            lifecycleUpdatedAt: nowStr,
          },
        });

        // Update each duplicate as superseded, linking to primary (keep embedding intact)
        for (const duplicate of supersededMemories) {
          const dupMeta = normalizeMetadata(duplicate.metadata, duplicate.createdAt);
          await this.repository.update(duplicate.id, {
            metadata: {
              ...dupMeta,
              status: 'superseded',
              validUntil: nowStr,
              supersededBy: primary.id,
              lifecycleUpdatedAt: nowStr,
            },
          });
        }

        actions.push({
          primaryId: primary.id,
          supersededIds,
        });

        consolidatedCount += supersededMemories.length;
      }
    }

    return {
      consolidatedCount,
      actions,
    };
  }

  /**
   * Helper to check if two sentences have opposing polarity words (e.g. no, not, never, don't).
   */
  private hasContradictoryPolarity(a: string, b: string): boolean {
    const negations = ['not', 'no', 'never', "don't", 'dont', 'cannot', 'cant', "can't", 'stop', 'avoid'];
    const wordsA = a.toLowerCase().split(/\s+/);
    const wordsB = b.toLowerCase().split(/\s+/);

    const hasNegA = wordsA.some((w) => negations.includes(w));
    const hasNegB = wordsB.some((w) => negations.includes(w));

    return hasNegA !== hasNegB; // returns true if one contains negation and the other does not
  }
}
