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

describe('ConversationRetriever and ResponseService Grounding Integration', () => {
  let mockQuery: any;

  beforeEach(() => {
    mockQuery = getDbPool().query;
    mockQuery.mockReset();
  });

  describe('ConversationRetriever Unit Tests', () => {
    it('should successfully search conversations and extract matching sentences as snippets', async () => {
      const retriever = new ConversationRetriever();

      const mockRows = [
        {
          id: 'conv-1',
          transcript: 'Hello. I really like pizza. Nataraj opinion on architecture is that it should be simple. Goodbye.',
          createdAt: new Date('2026-08-10T12:00:00.000Z'),
        },
      ];

      mockQuery.mockResolvedValueOnce({
        rows: mockRows,
      });

      const snippets = await retriever.retrieveSnippets('user-1', 'Nataraj architecture opinion');

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const sqlCall = mockQuery.mock.calls[0][0];
      const paramsCall = mockQuery.mock.calls[0][1];
      expect(sqlCall).toContain('user_id = $1');
      expect(paramsCall[0]).toBe('user-1');

      expect(snippets).toHaveLength(1);
      expect(snippets[0].conversationId).toBe('conv-1');
      expect(snippets[0].text).toBe('Nataraj opinion on architecture is that it should be simple');
    });

    it('should support strict user isolation boundaries', async () => {
      const retriever = new ConversationRetriever();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await retriever.retrieveSnippets('user-different', 'test query');

      expect(mockQuery.mock.calls[0][1][0]).toBe('user-different');
    });

    it('should handle missing or empty search arguments safely', async () => {
      const retriever = new ConversationRetriever();
      await expect(retriever.retrieveSnippets('', 'query')).rejects.toThrow('User ID is required.');
      await expect(retriever.retrieveSnippets('user-1', '')).rejects.toThrow('Query is required.');
    });
  });

  describe('Combined Context Response Integration Tests', () => {
    it('should format memories with [MEMORY] and conversations with [PAST CONVERSATION] headers', async () => {
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
          text: 'Based on your preferences and previous conversations, here is the answer.',
        }),
      } as any;

      const mockConversationRetriever = {
        retrieveSnippets: vi.fn().mockResolvedValue([
          {
            conversationId: 'conv-2',
            createdAt: new Date('2026-08-12T14:30:00.000Z'),
            text: 'We discussed building microservices.',
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

      expect(mockConversationRetriever.retrieveSnippets).toHaveBeenCalledWith('user-1', 'architecture preferences');
      
      expect(mockGenerator.generateResponse).toHaveBeenCalledTimes(1);
      const passedContext = mockGenerator.generateResponse.mock.calls[0][1];
      
      expect(passedContext).toContain('[MEMORY] [FACT] [CURRENT] User prefers simple systems.');
      expect(passedContext).toContain('[PAST CONVERSATION] [Date: 2026-08-12] We discussed building microservices.');
      
      expect(result.usedConversations).toHaveLength(1);
      expect(result.usedConversations![0].id).toBe('conv-2');
      expect(result.usedConversations![0].text).toBe('We discussed building microservices.');
      expect(result.usedConversations![0].createdAt).toBe('2026-08-12T14:30:00.000Z');
    });

    it('should preserve backward compatible memory-only context format if no conversations are returned', async () => {
      const mockMemoryRetriever = {
        retrieve: vi.fn().mockResolvedValue([]),
      } as any;

      const mockAssembler = {
        assemble: vi.fn().mockReturnValue({
          items: [],
          context: 'raw memory content',
          tokenCount: 5,
        }),
      } as any;

      const mockGenerator = {
        generateResponse: vi.fn().mockResolvedValue({ text: 'Answer' }),
      } as any;

      const mockConversationRetriever = {
        retrieveSnippets: vi.fn().mockResolvedValue([]),
      } as any;

      const responseService = new ResponseService(
        mockMemoryRetriever,
        mockAssembler,
        mockGenerator,
        undefined,
        mockConversationRetriever
      );

      await responseService.respond('user-1', 'query');

      const passedContext = mockGenerator.generateResponse.mock.calls[0][1];
      expect(passedContext).toBe('raw memory content');
    });

    it('should handle no-context grounding safely when both memory and conversation return nothing', async () => {
      const mockMemoryRetriever = {
        retrieve: vi.fn().mockResolvedValue([]),
      } as any;

      const mockAssembler = {
        assemble: vi.fn().mockReturnValue({
          items: [],
          context: '',
          tokenCount: 0,
        }),
      } as any;

      const mockGenerator = {
        generateResponse: vi.fn().mockResolvedValue({ text: 'No-context response' }),
      } as any;

      const mockConversationRetriever = {
        retrieveSnippets: vi.fn().mockResolvedValue([]),
      } as any;

      const responseService = new ResponseService(
        mockMemoryRetriever,
        mockAssembler,
        mockGenerator,
        undefined,
        mockConversationRetriever
      );

      const result = await responseService.respond('user-1', 'query');
      expect(mockGenerator.generateResponse).toHaveBeenCalledWith('query', '');
      expect(result.response).toBe('No-context response');
    });
  });
});
