import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationMemoryExtractionService } from './extractionService';
import { PgConversationRepository } from './repository';
import { MemoryIngestionService } from '@/memory/ingestionService';
import { MemoryRepository } from '@/memory/repository';
import { MemoryExtractor } from '@/memory/extractor';
import { EmbeddingProvider } from '@/memory/embedding';

const mockGetById = vi.fn();
const mockIngest = vi.fn();

vi.mock('./repository', () => {
  return {
    PgConversationRepository: vi.fn().mockImplementation(function () {
      return {
        getById: mockGetById,
      };
    }),
  };
});

vi.mock('@/memory/ingestionService', () => {
  return {
    MemoryIngestionService: vi.fn().mockImplementation(function () {
      return {
        ingest: mockIngest,
      };
    }),
  };
});

describe('ConversationMemoryExtractionService', () => {
  let service: ConversationMemoryExtractionService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockConvRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockIngestionService: any;

  beforeEach(() => {
    mockGetById.mockReset();
    mockIngest.mockReset();

    mockConvRepo = new PgConversationRepository();
    mockIngestionService = new MemoryIngestionService(
      null as unknown as MemoryRepository,
      null as unknown as MemoryExtractor,
      null as unknown as EmbeddingProvider
    );

    service = new ConversationMemoryExtractionService(mockConvRepo, mockIngestionService);
  });

  it('should successfully extract memories from a conversation', async () => {
    const mockConv = {
      id: 'conv-1',
      userId: 'user-1',
      transcript: 'I like coffee and hot weather.',
      createdAt: new Date(),
    };
    mockGetById.mockResolvedValueOnce(mockConv);

    const mockMemories = [
      { id: 'mem-1', userId: 'user-1', type: 'PREFERENCE', content: 'Likes coffee', metadata: {} },
    ];
    mockIngest.mockResolvedValueOnce(mockMemories);

    const result = await service.extract('conv-1', 'user-1');
    expect(mockGetById).toHaveBeenCalledWith('conv-1');
    expect(mockIngest).toHaveBeenCalledWith(
      'user-1',
      mockConv.transcript,
      {
        conversationId: 'conv-1',
        sourceType: 'conversation',
        sourceTimestamp: expect.any(String),
      }
    );
    expect(result).toEqual(mockMemories);
  });

  it('should reject extraction if conversation does not exist', async () => {
    mockGetById.mockResolvedValueOnce(null);

    await expect(service.extract('non-existent', 'user-1')).rejects.toThrow(
      'Conversation not found.'
    );
  });

  it('should block cross-user access', async () => {
    const mockConv = {
      id: 'conv-1',
      userId: 'user-1', // owned by user-1
      transcript: 'Some details',
      createdAt: new Date(),
    };
    mockGetById.mockResolvedValueOnce(mockConv);

    // Request by user-2
    await expect(service.extract('conv-1', 'user-2')).rejects.toThrow(
      'Forbidden: Access denied to this conversation.'
    );
  });

  it('should reject empty or whitespace-only transcripts', async () => {
    const mockConv = {
      id: 'conv-1',
      userId: 'user-1',
      transcript: '    ',
      createdAt: new Date(),
    };
    mockGetById.mockResolvedValueOnce(mockConv);

    await expect(service.extract('conv-1', 'user-1')).rejects.toThrow(
      'Empty transcript: No memories can be extracted from this conversation.'
    );
  });

  it('should propagate provider failures from ingestion service cleanly', async () => {
    const mockConv = {
      id: 'conv-1',
      userId: 'user-1',
      transcript: 'I live in Munich',
      createdAt: new Date(),
    };
    mockGetById.mockResolvedValueOnce(mockConv);

    const providerError = new Error('Gemini API quota exceeded');
    mockIngest.mockRejectedValueOnce(providerError);

    await expect(service.extract('conv-1', 'user-1')).rejects.toThrow(
      'Gemini API quota exceeded'
    );
  });
});
