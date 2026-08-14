import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route';

const mockIngest = vi.fn();

// Mock the ingestion service using a constructor-compatible format
vi.mock('@/memory/ingestionService', () => {
  return {
    MemoryIngestionService: vi.fn().mockImplementation(function () {
      return {
        ingest: mockIngest,
      };
    }),
  };
});

// Mock dependencies of route to avoid side effects
vi.mock('@/memory/repository', () => ({
  PgMemoryRepository: vi.fn(),
}));
vi.mock('@/memory/geminiExtractor', () => ({
  GeminiMemoryExtractor: vi.fn(),
}));

describe('POST /api/memory/ingest API Route', () => {
  beforeEach(() => {
    mockIngest.mockReset();
  });

  it('should return 400 when request body is empty or invalid', async () => {
    const request = new Request('http://localhost/api/memory/ingest', {
      method: 'POST',
      body: '',
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid request body. Expected JSON.');
  });

  it('should return 400 when parameters are missing', async () => {
    const request = new Request('http://localhost/api/memory/ingest', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-1' }), // missing content
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Missing or invalid parameter: content is required.');
  });

  it('should return 200 and processed memories on successful ingestion', async () => {
    const mockMemories = [
      { id: '1', userId: 'user-1', content: 'Extracted fact', metadata: {} },
    ];
    mockIngest.mockResolvedValueOnce(mockMemories);

    const request = new Request('http://localhost/api/memory/ingest', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-1', content: 'This is raw text' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('success');
    expect(data.processedCount).toBe(1);
    expect(data.memories).toEqual(mockMemories);
  });

  it('should return 503 when GEMINI_API_KEY is not configured', async () => {
    mockIngest.mockRejectedValueOnce(new Error('GEMINI_API_KEY environment variable is not defined.'));

    const request = new Request('http://localhost/api/memory/ingest', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-1', content: 'This is raw text' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.error).toBe('Memory extraction service is temporarily unavailable.');
  });

  it('should return 500 on database or unexpected ingestion service errors', async () => {
    mockIngest.mockRejectedValueOnce(new Error('Database broke down'));

    const request = new Request('http://localhost/api/memory/ingest', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-1', content: 'This is raw text' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe('An error occurred during memory ingestion.');
  });
});
