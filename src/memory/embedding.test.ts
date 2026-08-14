import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiEmbeddingProvider } from './geminiEmbedding';

describe('GeminiEmbeddingProvider', () => {
  let provider: GeminiEmbeddingProvider;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'mock-key';
    process.env.EMBEDDING_MODEL = 'gemini-embedding-2';
    process.env.EMBEDDING_DIMENSION = '768';
    provider = new GeminiEmbeddingProvider();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('should successfully generate an embedding vector', async () => {
    const mockVector = new Array(768).fill(0.1);
    const mockResponse = {
      embedding: {
        values: mockVector,
      },
    };

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as unknown as Response);

    const result = await provider.generateEmbedding('hello world');
    expect(result).toEqual(mockVector);
    expect(result.length).toBe(768);
  });

  it('should throw an error if GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    const localProvider = new GeminiEmbeddingProvider();
    await expect(localProvider.generateEmbedding('text')).rejects.toThrow(
      'GEMINI_API_KEY environment variable is not defined.'
    );
  });

  it('should handle malformed JSON response', async () => {
    const mockResponse = {};

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as unknown as Response);

    await expect(provider.generateEmbedding('text')).rejects.toThrow();
  });

  it('should handle HTTP failure status codes', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Bad request error',
    } as unknown as Response);

    await expect(provider.generateEmbedding('text')).rejects.toThrow(
      'Gemini Embedding API error (HTTP 400): Bad request error'
    );
  });
});
