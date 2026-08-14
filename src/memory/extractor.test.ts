import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiMemoryExtractor } from './geminiExtractor';

describe('GeminiMemoryExtractor', () => {
  let extractor: GeminiMemoryExtractor;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'mock-key';
    extractor = new GeminiMemoryExtractor();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('should successfully parse valid actions from Gemini API', async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  actions: [
                    {
                      action: 'CREATE',
                      type: 'FACT',
                      content: 'User likes coffee',
                      confidence: 0.95,
                      importance: 6,
                    },
                  ],
                }),
              },
            ],
          },
        },
      ],
    };

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as unknown as Response);

    const result = await extractor.reconcile('raw text', []);
    expect(result).toEqual([
      {
        action: 'CREATE',
        id: undefined,
        type: 'FACT',
        content: 'User likes coffee',
        confidence: 0.95,
        importance: 6,
      },
    ]);
  });

  it('should throw an error if GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    const localExtractor = new GeminiMemoryExtractor();
    await expect(localExtractor.reconcile('raw text', [])).rejects.toThrow(
      'GEMINI_API_KEY environment variable is not defined.'
    );
  });

  it('should handle malformed JSON response gracefully', async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: 'invalid-json',
              },
            ],
          },
        },
      ],
    };

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as unknown as Response);

    await expect(extractor.reconcile('raw text', [])).rejects.toThrow();
  });

  it('should handle missing actions key in response JSON', async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({ wrongKey: [] }),
              },
            ],
          },
        },
      ],
    };

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as unknown as Response);

    await expect(extractor.reconcile('raw text', [])).rejects.toThrow(
      'Malformed response: "actions" array is missing.'
    );
  });

  it('should throw error when Gemini API response is not OK', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'API error details',
    } as unknown as Response);

    await expect(extractor.reconcile('raw text', [])).rejects.toThrow(
      'Gemini API error (HTTP 400): API error details'
    );
  });
});
