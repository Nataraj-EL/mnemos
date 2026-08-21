import { Memory } from '@/core/types';
import { MemoryRepository } from './repository';
import { MemoryExtractor } from './extractor';
import { EmbeddingProvider } from './embedding';
import { getDbPool } from '@/db';

export class MemoryIngestionService {
  constructor(
    private repository: MemoryRepository,
    private extractor: MemoryExtractor,
    private embeddingProvider: EmbeddingProvider
  ) {}

  /**
   * Ingests raw conversation content, extracts structured memories, reconciles them with existing
   * user candidate memories, generates embeddings for active candidates, and persists changes.
   */
  async ingest(
    userId: string,
    content: string,
    provenance?: { conversationId: string; sourceType: string; sourceTimestamp: string }
  ): Promise<Memory[]> {
    if (!userId || !userId.trim()) {
      throw new Error('User ID is required.');
    }
    if (!content || !content.trim()) {
      throw new Error('Content is required.');
    }

    // 1. Fetch bounded set of candidate memories (e.g. 50 most recent memories)
    const existing = await this.repository.list({ userId });
    
    // Filter out superseded memories to keep LLM context clean
    const activeCandidates = existing
      .filter((m) => m.metadata.status !== 'superseded')
      .slice(0, 50);

    // 2. Call extractor to reconcile against candidates
    const actions = await this.extractor.reconcile(content, activeCandidates);

    const processedMemories: Memory[] = [];

    // 3. Process each reconciled action
    for (const act of actions) {
      if (act.action === 'CREATE') {
        if (!act.type || !act.content) {
          console.warn('Skipping CREATE action due to missing type or content:', act);
          continue;
        }

        // Persist base memory first
        const newMemory = await this.repository.create({
          userId,
          type: act.type,
          content: act.content,
          metadata: {
            source: provenance?.sourceType || 'user_input',
            confidence: act.confidence ?? 0.8,
            importance: act.importance ?? 5,
            timestamp: new Date().toISOString(),
            status: 'active',
            accessCount: 0,
            lastAccessedAt: new Date().toISOString(),
            reinforcementCount: 0,
            lifecycleUpdatedAt: new Date().toISOString(),
            ...(provenance ? {
              conversationId: provenance.conversationId,
              sourceType: provenance.sourceType,
              sourceTimestamp: provenance.sourceTimestamp,
              ...(provenance.sourceType === 'voice' ? {
                type: 'conversation',
                createdAt: new Date().toISOString(),
              } : {}),
            } : {}),
          },
        });

        let finalMemory = newMemory;
        try {
          // Attempt to generate and save embedding
          const vector = await this.embeddingProvider.generateEmbedding(act.content);
          finalMemory = await this.repository.update(newMemory.id, {
            embedding: vector,
          });
        } catch (embedError) {
          console.error(
            `Resilient Ingestion: Failed to generate/persist embedding for memory ${newMemory.id}:`,
            embedError
          );
          // We return the memory record successfully stored without breaking execution
        }

        processedMemories.push(finalMemory);
      } 
      else if (act.action === 'UPDATE') {
        if (!act.id) {
          console.warn('Skipping UPDATE action due to missing memory ID.');
          continue;
        }

        // Verify ID exists and belongs to the supplied user ID (Security Guard)
        const existingMemory = await this.repository.get(act.id);
        if (!existingMemory || existingMemory.userId !== userId) {
          console.warn(`Security Warning: Cross-user update blocked or memory not found for ID: ${act.id}`);
          continue;
        }

        const newContent = act.content ?? existingMemory.content;
        const newType = act.type ?? existingMemory.type;
        const nowStr = new Date().toISOString();

        // 1. Create the NEW memory as active, referencing the old memory ID
        const newMemory = await this.repository.create({
          userId,
          type: newType,
          content: newContent,
          metadata: {
            source: provenance?.sourceType || 'user_input',
            confidence: act.confidence ?? 0.8,
            importance: act.importance ?? 5,
            timestamp: nowStr,
            status: 'active',
            validFrom: nowStr,
            supersedes: existingMemory.id,
            accessCount: 0,
            lastAccessedAt: nowStr,
            reinforcementCount: 0,
            lifecycleUpdatedAt: nowStr,
            ...(provenance ? {
              conversationId: provenance.conversationId,
              sourceType: provenance.sourceType,
              sourceTimestamp: provenance.sourceTimestamp,
              ...(provenance.sourceType === 'voice' ? {
                type: 'conversation',
                createdAt: nowStr,
              } : {}),
            } : (existingMemory.metadata.conversationId ? {
              conversationId: existingMemory.metadata.conversationId as string,
              sourceType: existingMemory.metadata.sourceType as string,
              sourceTimestamp: existingMemory.metadata.sourceTimestamp as string,
              ...(existingMemory.metadata.sourceType === 'voice' ? {
                type: 'conversation',
                createdAt: (existingMemory.metadata.createdAt as string) || nowStr,
              } : {}),
            } : {})),
          },
        });

        // 2. Mark the OLD memory as superseded, linking to the new memory (keep embedding intact)
        await this.repository.update(existingMemory.id, {
          metadata: {
            ...existingMemory.metadata,
            status: 'superseded',
            validUntil: nowStr,
            supersededBy: newMemory.id,
            timestamp: nowStr,
          },
        });

        let finalMemory = newMemory;
        try {
          // Attempt to generate and save updated embedding for the new memory
          const vector = await this.embeddingProvider.generateEmbedding(newContent);
          finalMemory = await this.repository.update(newMemory.id, {
            embedding: vector,
          });
        } catch (embedError) {
          console.error(
            `Resilient Ingestion: Failed to generate/persist embedding for NEW temporal memory ${newMemory.id}:`,
            embedError
          );
        }

        processedMemories.push(finalMemory);
      } 
      else if (act.action === 'DELETE') {
        if (!act.id) {
          console.warn('Skipping DELETE action due to missing memory ID.');
          continue;
        }

        // Verify ID exists and belongs to the supplied user ID (Security Guard)
        const existingMemory = await this.repository.get(act.id);
        if (!existingMemory || existingMemory.userId !== userId) {
          console.warn(`Security Warning: Cross-user delete blocked or memory not found for ID: ${act.id}`);
          continue;
        }

        const nowStr = new Date().toISOString();
        // Soft-supersede: mark status, clear embedding, and record validUntil
        const superseded = await this.repository.update(act.id, {
          embedding: null,
          metadata: {
            ...existingMemory.metadata,
            status: 'superseded',
            validUntil: nowStr,
            timestamp: nowStr,
            supersededAt: nowStr,
            lifecycleUpdatedAt: nowStr,
          },
        });
        processedMemories.push(superseded);
      } 
      else if (act.action === 'NONE') {
        if (act.id) {
          const existingMemory = await this.repository.get(act.id);
          if (existingMemory && existingMemory.userId === userId) {
            processedMemories.push(existingMemory);
          }
        }
      }
    }

    return processedMemories;
  }

  async ingestVoice(
    userId: string,
    content: string,
    provenance?: { conversationId: string; sourceType: string; sourceTimestamp: string }
  ): Promise<{
    memories: Memory[];
    outcome: 'created' | 'reinforced' | 'discarded' | 'updated';
    affectedMemoryId?: string;
  }> {
    if (!userId || !userId.trim()) {
      throw new Error('User ID is required.');
    }

    const cleanContent = content.trim();
    if (isMeaninglessTranscript(cleanContent)) {
      return {
        memories: [],
        outcome: 'discarded',
      };
    }

    // 1. Fetch active candidates
    const existing = await this.repository.list({ userId });
    const activeCandidates = existing
      .filter((m) => m.metadata.status !== 'superseded')
      .slice(0, 50);

    // 2. Extractor reconcile
    const actions = await this.extractor.reconcile(cleanContent, activeCandidates);

    if (actions.length === 0) {
      return {
        memories: [],
        outcome: 'discarded',
      };
    }

    const processedMemories: Memory[] = [];
    let outcome: 'created' | 'reinforced' | 'discarded' | 'updated' = 'discarded';
    let affectedMemoryId: string | undefined = undefined;

    for (const act of actions) {
      if (act.action === 'CREATE') {
        if (!act.type || !act.content) continue;

        let newEmbed: number[] | null = null;
        try {
          newEmbed = await this.embeddingProvider.generateEmbedding(act.content);
        } catch (err) {
          console.error('Failed to generate embedding for quality duplicate check:', err);
        }

        let duplicateMemory: Memory | null = null;
        let highestSim = 0;

        if (newEmbed) {
          try {
            const pool = getDbPool();
            const query = `
              SELECT id, user_id as "userId", type, content, metadata, created_at as "createdAt", updated_at as "updatedAt",
                     (1 - (embedding <=> $1::vector)) as similarity
              FROM memories
              WHERE user_id = $2 AND metadata->>'status' = 'active'
              ORDER BY similarity DESC
              LIMIT 1;
            `;
            const result = await pool.query(query, [`[${newEmbed.join(',')}]`, userId]);
            if (result.rows.length > 0) {
              highestSim = Number(result.rows[0].similarity);
              const row = result.rows[0];
              duplicateMemory = {
                id: row.id,
                userId: row.userId,
                type: row.type,
                content: row.content,
                metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
              };
            }
          } catch (dbErr) {
            console.error('Failed pgvector duplicate query, falling back to local memory scan:', dbErr);
            for (const cand of activeCandidates) {
              if (cand.embedding) {
                let dotProduct = 0;
                let normA = 0;
                let normB = 0;
                for (let i = 0; i < newEmbed.length; i++) {
                  dotProduct += newEmbed[i] * cand.embedding[i];
                  normA += newEmbed[i] * newEmbed[i];
                  normB += cand.embedding[i] * cand.embedding[i];
                }
                const sim = normA === 0 || normB === 0 ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
                if (sim > highestSim) {
                  highestSim = sim;
                  duplicateMemory = cand;
                }
              }
            }
          }
        }

        const duplicateThreshold = Number(process.env.VOICE_DUPLICATE_THRESHOLD) || VOICE_DUPLICATE_THRESHOLD;
        if (duplicateMemory && highestSim >= duplicateThreshold) {
          const metadata = duplicateMemory.metadata;
          const currentConfidence = metadata.confidence ?? 0.8;
          const currentAccessCount = metadata.accessCount ?? 0;
          const currentReinforcementCount = metadata.reinforcementCount ?? 0;

          const updatedMetadata = {
            ...metadata,
            accessCount: currentAccessCount + 1,
            reinforcementCount: currentReinforcementCount + 1,
            confidence: parseFloat(Math.min(1.0, currentConfidence + 0.05).toFixed(4)),
            lifecycleUpdatedAt: new Date().toISOString(),
          };

          const reinforced = await this.repository.update(duplicateMemory.id, {
            metadata: updatedMetadata,
          });

          processedMemories.push(reinforced);
          outcome = 'reinforced';
          affectedMemoryId = duplicateMemory.id;
        } else {
          const newMemory = await this.repository.create({
            userId,
            type: act.type,
            content: act.content,
            metadata: {
              source: 'voice',
              confidence: act.confidence ?? 0.8,
              importance: act.importance ?? 5,
              timestamp: new Date().toISOString(),
              status: 'active',
              accessCount: 0,
              lastAccessedAt: new Date().toISOString(),
              reinforcementCount: 0,
              lifecycleUpdatedAt: new Date().toISOString(),
              ...(provenance ? {
                conversationId: provenance.conversationId,
                sourceType: provenance.sourceType,
                sourceTimestamp: provenance.sourceTimestamp,
                type: 'conversation',
                createdAt: new Date().toISOString(),
              } : {
                sourceType: 'voice',
                sourceTimestamp: new Date().toISOString(),
                type: 'conversation',
                createdAt: new Date().toISOString(),
              }),
            },
          });

          let finalMemory = newMemory;
          if (newEmbed) {
            try {
              finalMemory = await this.repository.update(newMemory.id, {
                embedding: newEmbed,
              });
            } catch (embedError) {
              console.error('Failed to update embedding for new memory:', embedError);
            }
          }

          processedMemories.push(finalMemory);
          outcome = 'created';
          affectedMemoryId = newMemory.id;
        }
      } 
      else if (act.action === 'UPDATE') {
        if (!act.id) continue;

        const existingMemory = await this.repository.get(act.id);
        if (!existingMemory || existingMemory.userId !== userId) continue;

        const newContent = act.content ?? existingMemory.content;
        const newType = act.type ?? existingMemory.type;
        const nowStr = new Date().toISOString();

        if (newContent === existingMemory.content) {
          const metadata = existingMemory.metadata;
          const currentConfidence = metadata.confidence ?? 0.8;
          const updatedMetadata = {
            ...metadata,
            accessCount: (metadata.accessCount ?? 0) + 1,
            reinforcementCount: (metadata.reinforcementCount ?? 0) + 1,
            confidence: parseFloat(Math.min(1.0, currentConfidence + 0.05).toFixed(4)),
            lifecycleUpdatedAt: nowStr,
          };
          const reinforced = await this.repository.update(existingMemory.id, {
            metadata: updatedMetadata,
          });
          processedMemories.push(reinforced);
          outcome = 'reinforced';
          affectedMemoryId = existingMemory.id;
        } else {
          const newMemory = await this.repository.create({
            userId,
            type: newType,
            content: newContent,
            metadata: {
              source: 'voice',
              confidence: act.confidence ?? 0.8,
              importance: act.importance ?? 5,
              timestamp: nowStr,
              status: 'active',
              validFrom: nowStr,
              supersedes: existingMemory.id,
              accessCount: 0,
              lastAccessedAt: nowStr,
              reinforcementCount: 0,
              lifecycleUpdatedAt: nowStr,
              ...(provenance ? {
                conversationId: provenance.conversationId,
                sourceType: provenance.sourceType,
                sourceTimestamp: provenance.sourceTimestamp,
                type: 'conversation',
                createdAt: nowStr,
              } : {
                sourceType: 'voice',
                sourceTimestamp: nowStr,
                type: 'conversation',
                createdAt: nowStr,
              }),
            },
          });

          await this.repository.update(existingMemory.id, {
            metadata: {
              ...existingMemory.metadata,
              status: 'superseded',
              validUntil: nowStr,
              supersededBy: newMemory.id,
              timestamp: nowStr,
            },
          });

          let finalMemory = newMemory;
          try {
            const vector = await this.embeddingProvider.generateEmbedding(newContent);
            finalMemory = await this.repository.update(newMemory.id, {
              embedding: vector,
            });
          } catch (embedError) {
            console.error('Failed to update embedding for updated memory:', embedError);
          }

          processedMemories.push(finalMemory);
          outcome = 'updated';
          affectedMemoryId = newMemory.id;
        }
      } 
      else if (act.action === 'DELETE') {
        if (!act.id) continue;

        const existingMemory = await this.repository.get(act.id);
        if (!existingMemory || existingMemory.userId !== userId) continue;

        const nowStr = new Date().toISOString();
        const superseded = await this.repository.update(act.id, {
          embedding: null,
          metadata: {
            ...existingMemory.metadata,
            status: 'superseded',
            validUntil: nowStr,
            timestamp: nowStr,
            supersededAt: nowStr,
            lifecycleUpdatedAt: nowStr,
          },
        });
        processedMemories.push(superseded);
        outcome = 'updated';
        affectedMemoryId = act.id;
      } 
      else if (act.action === 'NONE') {
        if (act.id) {
          const existingMemory = await this.repository.get(act.id);
          if (existingMemory && existingMemory.userId === userId) {
            const metadata = existingMemory.metadata;
            const currentConfidence = metadata.confidence ?? 0.8;
            const updatedMetadata = {
              ...metadata,
              accessCount: (metadata.accessCount ?? 0) + 1,
              reinforcementCount: (metadata.reinforcementCount ?? 0) + 1,
              confidence: parseFloat(Math.min(1.0, currentConfidence + 0.05).toFixed(4)),
              lifecycleUpdatedAt: new Date().toISOString(),
            };
            const reinforced = await this.repository.update(existingMemory.id, {
              metadata: updatedMetadata,
            });
            processedMemories.push(reinforced);
            outcome = 'reinforced';
            affectedMemoryId = existingMemory.id;
          }
        }
      }
    }

    return {
      memories: processedMemories,
      outcome: processedMemories.length > 0 ? outcome : 'discarded',
      affectedMemoryId,
    };
  }
}

// Configurable constants for quality control (Sprint 69)
const VOICE_DUPLICATE_THRESHOLD = 0.88;
const VOICE_MIN_LENGTH = 3;
const VOICE_FILLER_PHRASES = [
  'hello', 'okay', 'ok', 'hi', 'test', 'yes', 'no', 'testing',
  'uh', 'um', 'ah', 'oh', 'thanks', 'thank you', 'bye', 'goodbye',
  'hey', 'yo', 'placeholder', 'accidental noise', 'noise', 'you'
];

export function isMeaninglessTranscript(text: string): boolean {
  const clean = text.trim().toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, "");
  const minLength = Number(process.env.VOICE_MIN_LENGTH) || VOICE_MIN_LENGTH;
  if (clean.length < minLength) return true;
  if (VOICE_FILLER_PHRASES.includes(clean)) return true;
  if (!/[a-z0-9]/i.test(clean)) return true;
  return false;
}

