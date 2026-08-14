import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './route';

const mockRetrieve = vi.fn();

// Mock the retriever using a constructor-compatible function
vi.mock('@/memory/retriever', () => {
  return {
    MemoryRetriever: vi.fn().mockImplementation(function () {
      return {
        retrieve: mockRetrieve,
      };
    }),
  };
});

// Mock other dependencies
vi.mock('@/memory/geminiEmbedding', () => ({
  GeminiEmbeddingProvider: vi.fn(),
}));

describe('GET /api/memory/search API Route', () => {
  beforeEach(() => {
    mockRetrieve.mockReset();
  });

  it('should return 400 when parameters are missing', async () => {
    const request = new Request('http://localhost/api/memory/search?q=hello'); // missing userId
    const response = await GET(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Missing or invalid parameter: userId is required.');
  });

  it('should return 400 when query parameter is missing', async () => {
    const request = new Request('http://localhost/api/memory/search?userId=user-1'); // missing q
    const response = await GET(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Missing or invalid parameter: q (query) is required.');
  });

  it('should return 200 and search results on success', async () => {
    const mockResults = [
      {
        memory: { id: 'mem-1', userId: 'user-1', content: 'test matching content' },
        similarity: 0.92,
      },
    ];

    mockRetrieve.mockResolvedValueOnce(mockResults);

    const request = new Request('http://localhost/api/memory/search?userId=user-1&q=test');
    const response = await GET(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe('success');
    expect(data.results).toEqual(mockResults);
  });

  it('should return 503 if GEMINI_API_KEY is not defined', async () => {
    mockRetrieve.mockRejectedValueOnce(new Error('GEMINI_API_KEY environment variable is not defined.'));

    const request = new Request('http://localhost/api/memory/search?userId=user-1&q=test');
    const response = await GET(request);
    expect(response.status).toBe(503);

    const data = await response.json();
    expect(data.error).toBe('Embedding service is temporarily unavailable.');
  });

  it('should return 500 on unexpected errors', async () => {
    mockRetrieve.mockRejectedValueOnce(new Error('Unexpected SQL error'));

    const request = new Request('http://localhost/api/memory/search?userId=user-1&q=test');
    const response = await GET(request);
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.error).toBe('An error occurred during semantic memory search.');
  });
});
