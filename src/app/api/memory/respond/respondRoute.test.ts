import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route';

const mockRespond = vi.fn();

// Mock dependencies
vi.mock('@/response/service', () => {
  return {
    ResponseService: vi.fn().mockImplementation(function () {
      return {
        respond: mockRespond,
      };
    }),
  };
});

vi.mock('@/memory/retriever', () => ({
  MemoryRetriever: vi.fn(),
}));

vi.mock('@/memory/geminiEmbedding', () => ({
  GeminiEmbeddingProvider: vi.fn(),
}));

vi.mock('@/context/assembler', () => ({
  ContextAssembler: vi.fn(),
}));

vi.mock('@/response/geminiGenerator', () => ({
  GeminiResponseGenerator: vi.fn(),
}));

describe('POST /api/memory/respond API Route', () => {
  beforeEach(() => {
    mockRespond.mockReset();
  });

  it('should return 400 when body or parameters are missing', async () => {
    const request = new Request('http://localhost/api/memory/respond', {
      method: 'POST',
      body: JSON.stringify({ query: 'hello' }), // missing userId
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Missing or invalid parameter: userId is required.');
  });

  it('should return 400 when limits or maxTokens parameters are out of bounds', async () => {
    const request = new Request('http://localhost/api/memory/respond', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-1', query: 'hello', limit: -5 }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('limit must be a positive integer');
  });

  it('should return 200 and contextual response on success', async () => {
    const mockResult = {
      response: 'Tea is preferred.',
      usedMemories: [{ id: 'mem-1', type: 'PREFERENCE', similarity: 0.9, score: 0.85 }],
      contextTokenCount: 8,
    };

    mockRespond.mockResolvedValueOnce(mockResult);

    const request = new Request('http://localhost/api/memory/respond', {
      method: 'POST',
      body: JSON.stringify({
        userId: 'user-1',
        query: 'What hot drink do I like?',
        limit: 5,
        maxTokens: 100,
      }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe('success');
    expect(data.response).toBe('Tea is preferred.');
    expect(data.usedMemories).toHaveLength(1);
    expect(data.contextTokenCount).toBe(8);
  });

  it('should return 503 if GEMINI_API_KEY is not defined', async () => {
    mockRespond.mockRejectedValueOnce(
      new Error('GEMINI_API_KEY environment variable is not defined.')
    );

    const request = new Request('http://localhost/api/memory/respond', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-1', query: 'hello' }),
    });
    const response = await POST(request);
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.error).toBe('Grounded response service is temporarily unavailable.');
  });
});
