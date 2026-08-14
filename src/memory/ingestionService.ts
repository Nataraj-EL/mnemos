import { Memory } from '@/core/types';
import { MemoryRepository } from './repository';
import { MemoryExtractor } from './extractor';

export class MemoryIngestionService {
  constructor(
    private repository: MemoryRepository,
    private extractor: MemoryExtractor
  ) {}

  /**
   * Ingests raw conversation content, extracts structured memories, reconciles them with existing
   * user candidate memories, and persists changes.
   */
  async ingest(userId: string, content: string): Promise<Memory[]> {
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

        const newMemory = await this.repository.create({
          userId,
          type: act.type,
          content: act.content,
          metadata: {
            source: 'user_input',
            confidence: act.confidence ?? 0.8,
            importance: act.importance ?? 5,
            timestamp: new Date().toISOString(),
            status: 'active',
          },
        });
        processedMemories.push(newMemory);
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

        const updated = await this.repository.update(act.id, {
          type: act.type ?? existingMemory.type,
          content: act.content ?? existingMemory.content,
          metadata: {
            ...existingMemory.metadata,
            confidence: act.confidence ?? existingMemory.metadata.confidence,
            importance: act.importance ?? existingMemory.metadata.importance,
            timestamp: new Date().toISOString(),
            status: 'active',
          },
        });
        processedMemories.push(updated);
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

        // Prefer soft-supersede rather than hard-deleting the row
        const superseded = await this.repository.update(act.id, {
          metadata: {
            ...existingMemory.metadata,
            status: 'superseded',
            timestamp: new Date().toISOString(),
            supersededAt: new Date().toISOString(),
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
