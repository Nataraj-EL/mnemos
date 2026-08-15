import { ConversationRepository } from './repository';
import { ConversationMemoryExtractionService } from './extractionService';
import { ConversationSummarizer } from './summarizer';

export class ConversationIntelligenceService {
  private static activeLocks = new Set<string>();

  static resetLocks() {
    ConversationIntelligenceService.activeLocks.clear();
  }

  constructor(
    private conversationRepo: ConversationRepository,
    private extractionService: ConversationMemoryExtractionService,
    private summarizer: ConversationSummarizer
  ) {}

  private async checkOwnershipAndGet(conversationId: string, userId: string) {
    if (!conversationId || !conversationId.trim()) {
      throw new Error('Conversation ID is required.');
    }
    if (!userId || !userId.trim()) {
      throw new Error('User ID is required.');
    }

    const conversation = await this.conversationRepo.getById(conversationId);
    if (!conversation) {
      const err = new Error('Conversation not found.') as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }

    if (conversation.userId !== userId) {
      const err = new Error('Forbidden: Access denied to this conversation.') as Error & { statusCode?: number };
      err.statusCode = 403;
      throw err;
    }

    return conversation;
  }

  async summarize(conversationId: string, userId: string): Promise<string> {
    const conversation = await this.checkOwnershipAndGet(conversationId, userId);

    const lockKey = `${conversationId}:summarize`;
    if (ConversationIntelligenceService.activeLocks.has(lockKey)) {
      const err = new Error('Operation in progress: A summarization operation is already active for this conversation.');
      (err as { statusCode?: number } & Error).statusCode = 409;
      throw err;
    }
    ConversationIntelligenceService.activeLocks.add(lockKey);

    try {
      const transcript = conversation.transcript ? conversation.transcript.trim() : '';
      if (!transcript) {
        const err = new Error('Empty transcript: Cannot generate summary.');
        (err as { statusCode?: number } & Error).statusCode = 422;
        throw err;
      }

      const summaryText = await this.summarizer.summarize(transcript);
      await this.conversationRepo.updateSummary(conversationId, summaryText);
      return summaryText;
    } finally {
      ConversationIntelligenceService.activeLocks.delete(lockKey);
    }
  }

  async extractMemories(conversationId: string, userId: string): Promise<{ count: number; ids: string[] }> {
    await this.checkOwnershipAndGet(conversationId, userId);

    const lockKey = `${conversationId}:extract-memories`;
    if (ConversationIntelligenceService.activeLocks.has(lockKey)) {
      const err = new Error('Operation in progress: A memory extraction operation is already active for this conversation.');
      (err as { statusCode?: number } & Error).statusCode = 409;
      throw err;
    }
    ConversationIntelligenceService.activeLocks.add(lockKey);

    try {
      const memories = await this.extractionService.extract(conversationId, userId);
      const ids = memories.map(m => m.id);
      return {
        count: memories.length,
        ids
      };
    } finally {
      ConversationIntelligenceService.activeLocks.delete(lockKey);
    }
  }
}
