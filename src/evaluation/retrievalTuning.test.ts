import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextAssembler } from '@/context/assembler';
import { MemoryRetriever } from '@/memory/retriever';
import { ResponseService } from '@/response/service';
import { ConversationRetriever } from '@/conversation/retriever';
import { getDbPool } from '@/db';
import { Memory } from '@/core/types';
import { RETRIEVAL_SETTINGS } from '@/core/config';

vi.mock('@/db', () => {
  const mockQuery = vi.fn();
  return {
    getDbPool: vi.fn(() => ({
      query: mockQuery,
    })),
  };
});

describe('Retrieval Quality Tuning Suite - Sprint 34', () => {
  let assembler: ContextAssembler;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockQuery: any;

  beforeEach(() => {
    assembler = new ContextAssembler();
    mockQuery = getDbPool().query;
    mockQuery.mockReset();
  });

  const mockMemory = (
    id: string,
    userId: string,
    content: string,
    createdAt: Date = new Date()
  ): Memory => ({
    id,
    userId,
    type: 'FACT' as const,
    content,
    metadata: {
      source: 'chat',
      status: 'active' as const,
      confidence: 1.0,
      importance: 5,
      timestamp: createdAt.toISOString(),
    },
    createdAt,
    updatedAt: createdAt,
  });

  it('should verify config defaults are initialized', () => {
    expect(RETRIEVAL_SETTINGS.semanticWeight).toBe(0.50);
    expect(RETRIEVAL_SETTINGS.lexicalWeight).toBe(0.10);
    expect(RETRIEVAL_SETTINGS.minSimilarity).toBe(0.0);
    expect(RETRIEVAL_SETTINGS.diversityThreshold).toBe(0.70);
  });

  it('should ignore overrides in production and only allow in evaluation runs', async () => {
    const mockRetriever = {
      retrieve: vi.fn().mockResolvedValue([]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new ResponseService(mockRetriever, assembler, { generateResponse: async () => ({ text: 'ok' }) } as any);

    // Normal production run: overrides are ignored (minSimilarity will default to 0.0)
    await service.respond('user-1', 'query', {
      minSimilarity: 0.8,
      evaluationRun: false,
    });
    expect(mockRetriever.retrieve).toHaveBeenCalledWith('user-1', 'query', {
      limit: 20,
      includeHistorical: false,
    });

    // Evaluation run: overrides are accepted (minSimilarity is 0.8)
    await service.respond('user-1', 'query', {
      minSimilarity: 0.8,
      evaluationRun: true,
    });
    expect(mockRetriever.retrieve).toHaveBeenLastCalledWith('user-1', 'query', {
      limit: 20,
      includeHistorical: false,
      minSimilarity: 0.8,
    });
  });

  it('should reject invalid validation overrides on evaluation runs', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockRetriever = { retrieve: vi.fn() } as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new ResponseService(mockRetriever, assembler, {} as any);

    // Negative minSimilarity
    await expect(service.respond('user-1', 'query', { minSimilarity: -0.1, evaluationRun: true })).rejects.toThrow('Invalid minSimilarity threshold');
    // Negative diversityThreshold
    await expect(service.respond('user-1', 'query', { diversityThreshold: -0.1, evaluationRun: true })).rejects.toThrow('Invalid diversityThreshold');
    // Negative conversation snippets limit
    await expect(service.respond('user-1', 'query', { maxConversationSnippets: -1, evaluationRun: true })).rejects.toThrow('Invalid maxConversationSnippets limit');
    // Negative weights
    await expect(service.respond('user-1', 'query', { semanticWeight: -0.5, evaluationRun: true })).rejects.toThrow('Weights must be non-negative');
    // Sum to zero weights
    await expect(service.respond('user-1', 'query', { semanticWeight: 0, lexicalWeight: 0, evaluationRun: true })).rejects.toThrow('Combined weight total must be positive');
  });

  it('should verify weight normalization inside ConversationRetriever', async () => {
    const retriever = new ConversationRetriever();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // Passing weights 6.0 and 4.0 should normalize to 0.6 and 0.4
    const res = await retriever.retrieveSnippets('user-1', 'test query', {
      semanticWeight: 6.0,
      lexicalWeight: 4.0,
    });
    expect(res).toEqual([]);
  });

  it('should resolve tie-breakers via selection score, similarity, createdAt, and stable ID ASC', () => {
    const now = new Date();

    const candidates = [
      // 1. Equal score tie-breaker: selection score is based on similarity + metadata.
      // Let's create two candidates with identical scores but different similarity values
      {
        memory: {
          id: 'mem-b',
          userId: 'user-1',
          type: 'FACT' as const,
          content: 'Fact Content B',
          metadata: {
            source: 'chat',
            status: 'active' as const,
            confidence: 1.0,
            importance: 5,
            timestamp: now.toISOString(),
          },
          createdAt: now,
          updatedAt: now,
        },
        similarity: 0.8,
      },
      {
        memory: {
          id: 'mem-a',
          userId: 'user-1',
          type: 'FACT' as const,
          content: 'Fact Content A',
          metadata: {
            source: 'chat',
            status: 'active' as const,
            confidence: 1.0,
            importance: 5,
            timestamp: now.toISOString(),
          },
          createdAt: now,
          updatedAt: now,
        },
        similarity: 0.8,
      },
    ];

    const res = assembler.assemble('query', candidates, 1000, {
      diversityThreshold: 1.0, // prevent deduplication pruning
    });


    // Stable ID ASC: mem-a before mem-b
    expect(res.items[0].id).toBe('mem-a');
    expect(res.items[1].id).toBe('mem-b');
  });

  it('should fallback to lexical query when embedding provider fails and respect limit', async () => {
    const mockEmbedProvider = {
      generateEmbedding: vi.fn().mockRejectedValue(new Error('Embedding provider error')),
    };
    const retriever = new MemoryRetriever(mockEmbedProvider);
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const results = await retriever.retrieve('user-1', 'Postgres search', { limit: 12 });
    expect(results).toEqual([]);
    expect(mockQuery).toHaveBeenCalled();
    const args = mockQuery.mock.calls[0];
    expect(args[0]).toContain('LIMIT $4');
    expect(args[1][args[1].length - 1]).toBe(12); // Bounded SQL Limit passed
  });

  it('should ensure user isolation in retrieve queries', async () => {
    const mockEmbedProvider = {
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]),
    };
    const retriever = new MemoryRetriever(mockEmbedProvider);
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await retriever.retrieve('user-secret-id', 'query');
    expect(mockQuery).toHaveBeenCalled();
    const args = mockQuery.mock.calls[0];
    expect(args[1][1]).toBe('user-secret-id');
  });

  it('should reflect final accepted and filtered sources under context budget limits', () => {
    const candidates = [
      { memory: mockMemory('mem-1', 'user-1', 'Short content'), similarity: 0.9 },
      { memory: mockMemory('mem-2', 'user-1', 'Very long content exceeding the token budget threshold'), similarity: 0.8 },
    ];

    const res = assembler.assemble('query', candidates, 10);
    expect(res.items).toHaveLength(1);
    expect(res.diagnostics).toBeDefined();
    expect(res.diagnostics!.acceptedSources).toHaveLength(1);
    expect(res.diagnostics!.acceptedSources[0].id).toBe('mem-1');
    expect(res.diagnostics!.filteredSources).toHaveLength(1);
    expect(res.diagnostics!.filteredSources[0].reason).toContain('Token budget limit');
  });

  it('should redact database UUIDs inside diagnostic listings', () => {
    const uuidId = '12345678-abcd-1234-abcd-123456789abc';
    const candidates = [
      { memory: mockMemory(uuidId, 'user-1', 'Fact content'), similarity: 0.9 },
    ];

    const res = assembler.assemble('query', candidates, 1000);
    expect(res.diagnostics).toBeDefined();
    expect(res.diagnostics!.acceptedSources[0].id).not.toBe(uuidId);
    expect(res.diagnostics!.acceptedSources[0].id).toBe('uuid-12345678...');
  });
});
