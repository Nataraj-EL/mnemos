/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationRetriever } from '@/conversation/retriever';
import { ResponseService } from './service';
import { getDbPool } from '@/db';

// Mock the db module
vi.mock('@/db', () => {
  const mockQuery = vi.fn();
  return {
    getDbPool: vi.fn(() => ({
      query: mockQuery,
    })),
  };
});

// Mock the embedding provider
const mockGenerateEmbedding = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
vi.mock('@/memory/geminiEmbedding', () => {
  return {
    GeminiEmbeddingProvider: class {
      async generateEmbedding(text: string) {
        return mockGenerateEmbedding(text);
      }
    },
  };
});

describe('ConversationRetriever and ResponseService Semantic Integration', () => {
  let mockQuery: any;

  beforeEach(() => {
    mockQuery = getDbPool().query;
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  describe('ConversationRetriever Semantic Tests', () => {
    it('should successfully search conversations semantically and extract matching sentences', async () => {
      const retriever = new ConversationRetriever();

      const mockRows = [
        {
          id: 'conv-1',
          transcript: 'Hello. I really like pizza. Nataraj opinion on architecture is that it should be simple. Goodbye.',
          createdAt: new Date('2026-08-10T12:00:00.000Z'),
          similarity: 0.85,
        },
      ];

      mockQuery.mockResolvedValueOnce({
        rows: mockRows,
      });

      const snippets = await retriever.retrieveSnippets('user-1', 'Nataraj architecture opinion');

      expect(mockGenerateEmbedding).toHaveBeenCalledWith('Nataraj architecture opinion');
      expect(mockQuery).toHaveBeenCalledTimes(1);

      const sqlCall = mockQuery.mock.calls[0][0];
      const paramsCall = mockQuery.mock.calls[0][1];
      expect(sqlCall).toContain('1 - (embedding <=> $1::vector)');
      expect(paramsCall[1]).toBe('user-1');

      expect(snippets).toHaveLength(1);
      expect(snippets[0].conversationId).toBe('conv-1');
      expect(snippets[0].text).toBe('Nataraj opinion on architecture is that it should be simple');
      expect(snippets[0].similarity).toBe(0.85);
    });

    it('should enforce user-isolation when searching similarity in repository', async () => {
      const retriever = new ConversationRetriever();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await retriever.retrieveSnippets('user-different', 'test query');

      expect(mockQuery.mock.calls[0][1][1]).toBe('user-different');
    });

    it('should fallback to keyword search if embedding generation throws an error', async () => {
      mockGenerateEmbedding.mockRejectedValueOnce(new Error('Embedding service failed'));

      const retriever = new ConversationRetriever();

      const mockRows = [
        {
          id: 'conv-keyword-1',
          transcript: 'Keyword match. Nataraj opinion on architecture is that it should be simple.',
          createdAt: new Date('2026-08-10T12:00:00.000Z'),
        },
      ];

      mockQuery.mockResolvedValueOnce({
        rows: mockRows,
      });

      const snippets = await retriever.retrieveSnippets('user-1', 'Nataraj architecture opinion');

      expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      
      const sqlCall = mockQuery.mock.calls[0][0];
      expect(sqlCall).toContain('transcript ILIKE');
      expect(snippets).toHaveLength(1);
      expect(snippets[0].conversationId).toBe('conv-keyword-1');
    });

    it('should fallback to keyword search if semantic search returns no rows above similarity threshold', async () => {
      // 1. Semantic query yields low similarity matches
      const mockSemanticRows = [
        {
          id: 'conv-low-similarity',
          transcript: 'Irrelevant discussion here.',
          createdAt: new Date(),
          similarity: 0.15, // Below threshold
        },
      ];

      // 2. Keyword fallback query yields matches
      const mockKeywordRows = [
        {
          id: 'conv-keyword-match',
          transcript: 'Nataraj architecture opinion is here.',
          createdAt: new Date(),
        },
      ];

      mockQuery
        .mockResolvedValueOnce({ rows: mockSemanticRows }) // For semantic search
        .mockResolvedValueOnce({ rows: mockKeywordRows });  // For keyword fallback

      const retriever = new ConversationRetriever();
      const snippets = await retriever.retrieveSnippets('user-1', 'Nataraj architecture', { minSimilarity: 0.3 });

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(snippets).toHaveLength(1);
      expect(snippets[0].conversationId).toBe('conv-keyword-match');
    });

    it('should return empty results if both semantic and keyword fallback find nothing', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // Semantic returns nothing
        .mockResolvedValueOnce({ rows: [] }); // Keyword returns nothing

      const retriever = new ConversationRetriever();
      const snippets = await retriever.retrieveSnippets('user-1', 'query text');

      expect(snippets).toEqual([]);
    });

    it('should support returning default first sentences if semantically matched conversation has no literal keyword overlap', async () => {
      const mockRows = [
        {
          id: 'conv-semantic-no-literal',
          transcript: 'First sentence text. Second sentence text.',
          createdAt: new Date(),
          similarity: 0.75,
        },
      ];

      mockQuery.mockResolvedValueOnce({ rows: mockRows });

      const retriever = new ConversationRetriever();
      // Literal keywords don't match anything in transcript
      const snippets = await retriever.retrieveSnippets('user-1', 'completely unrelated keyword matching none');

      expect(snippets).toHaveLength(2);
      expect(snippets[0].text).toBe('First sentence text');
      expect(snippets[1].text).toBe('Second sentence text');
    });
  });

  describe('ResponseService Grounded Combined Context Tests', () => {
    it('should correctly build context and map similarity values', async () => {
      const mockMemoryRetriever = {
        retrieve: vi.fn().mockResolvedValue([
          {
            memory: {
              id: 'mem-1',
              userId: 'user-1',
              type: 'FACT',
              content: 'User prefers simple systems.',
              metadata: { status: 'active' },
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            similarity: 0.95,
          },
        ]),
      } as any;

      const mockAssembler = {
        assemble: vi.fn().mockReturnValue({
          items: [
            {
              id: 'mem-1',
              type: 'FACT',
              status: 'active',
              content: 'User prefers simple systems.',
              similarity: 0.95,
              score: 0.95,
            },
          ],
          context: '[FACT] [CURRENT] User prefers simple systems.',
          tokenCount: 10,
        }),
      } as any;

      const mockGenerator = {
        generateResponse: vi.fn().mockResolvedValue({
          text: 'Based on preferences and previous conversations, here is the answer.',
        }),
      } as any;

      const mockConversationRetriever = {
        retrieveSnippets: vi.fn().mockResolvedValue([
          {
            conversationId: 'conv-2',
            createdAt: new Date('2026-08-12T14:30:00.000Z'),
            text: 'We discussed building microservices.',
            similarity: 0.88,
          },
        ]),
      } as any;

      const responseService = new ResponseService(
        mockMemoryRetriever,
        mockAssembler,
        mockGenerator,
        undefined,
        mockConversationRetriever
      );

      const result = await responseService.respond('user-1', 'architecture preferences');

      expect(result.usedConversations).toHaveLength(1);
      expect(result.usedConversations![0].id).toBe('conv-2');
      expect(result.usedConversations![0].text).toBe('We discussed building microservices.');
      expect(result.usedConversations![0].similarity).toBe(0.88);

      const passedContext = mockGenerator.generateResponse.mock.calls[0][1];
      expect(passedContext).toContain('[MEMORY] [FACT] [CURRENT] User prefers simple systems.');
      expect(passedContext).toContain('[PAST CONVERSATION] [Date: 2026-08-12] We discussed building microservices.');
    });
  });
});
