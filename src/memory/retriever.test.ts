import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRetriever } from './retriever';
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

describe('MemoryRetriever', () => {
  let retriever: MemoryRetriever;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockEmbeddingProvider: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockQuery: any;

  beforeEach(() => {
    mockEmbeddingProvider = {
      generateEmbedding: vi.fn(),
    };
    retriever = new MemoryRetriever(mockEmbeddingProvider);
    mockQuery = getDbPool().query;
    mockQuery.mockReset();
  });

  it('should successfully retrieve and order records by cosine similarity', async () => {
    mockEmbeddingProvider.generateEmbedding.mockResolvedValueOnce([0.1, 0.2]);

    const mockRows = [
      {
        id: 'mem-1',
        userId: 'user-1',
        type: 'FACT',
        content: 'Highly similar memory',
        metadata: { source: 'chat', status: 'active', confidence: 0.9, importance: 8 },
        embedding: '[0.11, 0.19]',
        createdAt: new Date(),
        updatedAt: new Date(),
        similarity: 0.98,
      },
      {
        id: 'mem-2',
        userId: 'user-1',
        type: 'FACT',
        content: 'Less similar memory',
        metadata: { source: 'chat', status: 'active', confidence: 0.9, importance: 4 },
        embedding: '[0.2, 0.3]',
        createdAt: new Date(),
        updatedAt: new Date(),
        similarity: 0.85,
      },
    ];

    mockQuery.mockResolvedValueOnce({
      rows: mockRows,
    });

    const results = await retriever.retrieve('user-1', 'search query', {
      limit: 5,
      minSimilarity: 0.5,
    });

    expect(mockEmbeddingProvider.generateEmbedding).toHaveBeenCalledWith('search query');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    expect(results[0].memory.id).toBe('mem-1');
    expect(results[0].similarity).toBe(0.98);
    expect(results[1].memory.id).toBe('mem-2');
    expect(results[1].similarity).toBe(0.85);
  });

  it('should throw an error on invalid or empty query parameters', async () => {
    await expect(retriever.retrieve('', 'query')).rejects.toThrow('User ID is required.');
    await expect(retriever.retrieve('user-1', '')).rejects.toThrow('Query text is required.');
  });

  it('should propagate embedding provider errors', async () => {
    mockEmbeddingProvider.generateEmbedding.mockRejectedValueOnce(new Error('Embedding API failed'));

    await expect(retriever.retrieve('user-1', 'query')).rejects.toThrow('Embedding API failed');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('should return empty array if database returns no rows', async () => {
    mockEmbeddingProvider.generateEmbedding.mockResolvedValueOnce([0.1, 0.2]);
    mockQuery.mockResolvedValueOnce({
      rows: [],
    });

    const results = await retriever.retrieve('user-1', 'query');
    expect(results).toEqual([]);
  });
});
