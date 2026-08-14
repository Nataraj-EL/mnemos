import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route';

const mockRetrieve = vi.fn();
const mockAssemble = vi.fn();

// Mock dependencies
vi.mock('@/memory/retriever', () => {
  return {
    MemoryRetriever: vi.fn().mockImplementation(function () {
      return {
        retrieve: mockRetrieve,
      };
    }),
  };
});

vi.mock('@/memory/geminiEmbedding', () => ({
  GeminiEmbeddingProvider: vi.fn(),
}));

vi.mock('@/context/assembler', () => {
  return {
    ContextAssembler: vi.fn().mockImplementation(function () {
      return {
        assemble: mockAssemble,
      };
    }),
  };
});

describe('POST /api/memory/context API Route', () => {
  beforeEach(() => {
    mockRetrieve.mockReset();
    mockAssemble.mockReset();
  });

  it('should return 400 when body or parameters are missing', async () => {
    const request = new Request('http://localhost/api/memory/context', {
      method: 'POST',
      body: JSON.stringify({ query: 'hello' }), // missing userId
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Missing or invalid parameter: userId is required.');
  });

  it('should return 400 when limits or maxTokens parameters are out of bounds', async () => {
    const request = new Request('http://localhost/api/memory/context', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-1', query: 'hello', limit: -5 }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('limit must be a positive integer');
  });

  it('should return 200 and compiled context result on success', async () => {
    mockRetrieve.mockResolvedValueOnce([
      {
        memory: { id: 'mem-1', content: 'test content', type: 'FACT', metadata: {} },
        similarity: 0.9,
      },
    ]);
    mockAssemble.mockReturnValueOnce({
      query: 'hello',
      items: [
        {
          id: 'mem-1',
          type: 'FACT',
          content: 'test content',
          similarity: 0.9,
          importance: 5,
          score: 0.8,
          reason: 'test',
        },
      ],
      context: '[FACT] test content',
      tokenCount: 5,
    });

    const request = new Request('http://localhost/api/memory/context', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-1', query: 'hello', limit: 5, maxTokens: 100 }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.context).toBe('[FACT] test content');
    expect(data.tokenCount).toBe(5);
    expect(mockRetrieve).toHaveBeenCalledWith('user-1', 'hello', { limit: 10, includeHistorical: false }); // limit * 2
  });

  it('should return 503 if GEMINI_API_KEY is not defined', async () => {
    mockRetrieve.mockRejectedValueOnce(
      new Error('GEMINI_API_KEY environment variable is not defined.')
    );

    const request = new Request('http://localhost/api/memory/context', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-1', query: 'hello' }),
    });
    const response = await POST(request);
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.error).toBe('Context assembly service is temporarily unavailable.');
  });
});
