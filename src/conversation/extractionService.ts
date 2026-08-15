import { ConversationRepository } from './repository';
import { MemoryIngestionService } from '@/memory/ingestionService';
import { Memory } from '@/core/types';

export class ConversationMemoryExtractionService {
  constructor(
    private conversationRepo: ConversationRepository,
    private memoryIngestionService: MemoryIngestionService
  ) {}

  async extract(conversationId: string, userId: string): Promise<Memory[]> {
    if (!conversationId || !conversationId.trim()) {
      throw new Error('Conversation ID is required.');
    }
    if (!userId || !userId.trim()) {
      throw new Error('User ID is required.');
    }

    const conversation = await this.conversationRepo.getById(conversationId);
    if (!conversation) {
      throw new Error('Conversation not found.');
    }

    if (conversation.userId !== userId) {
      throw new Error('Forbidden: Access denied to this conversation.');
    }

    const transcript = conversation.transcript ? conversation.transcript.trim() : '';
    if (!transcript) {
      throw new Error('Empty transcript: No memories can be extracted from this conversation.');
    }

    return this.memoryIngestionService.ingest(userId, transcript, {
      conversationId: conversation.id,
      sourceType: 'conversation',
      sourceTimestamp: conversation.createdAt.toISOString(),
    });
  }
}
