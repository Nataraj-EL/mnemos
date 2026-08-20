import { Memory } from '@/core/types';
import { MemoryRepository } from './repository';
import { MemoryExtractor } from './extractor';
import { EmbeddingProvider } from './embedding';

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
}
