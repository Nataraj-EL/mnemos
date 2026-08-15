import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';
import { POST as legacySummarizeRoute } from '../summarize/route';
import { POST as legacyExtractRoute } from '../extract-memories/route';
import { resetRateLimits } from '@/memory/security';
import { ConversationIntelligenceService } from '@/conversation/intelligenceService';

const mockGetById = vi.fn();
const mockUpdateSummary = vi.fn();
const mockSummarize = vi.fn();
const mockExtract = vi.fn();

vi.mock('@/conversation/repository', () => {
  return {
    PgConversationRepository: vi.fn().mockImplementation(function () {
      return {
        getById: mockGetById,
        updateSummary: mockUpdateSummary,
      };
    }),
  };
});

vi.mock('@/conversation/summarizer', () => {
  return {
    GeminiConversationSummarizer: vi.fn().mockImplementation(function () {
      return {
        summarize: mockSummarize,
      };
    }),
  };
});

vi.mock('@/conversation/extractionService', () => {
  return {
    ConversationMemoryExtractionService: vi.fn().mockImplementation(function () {
      return {
        extract: mockExtract,
      };
    }),
  };
});

describe('POST /api/v1/conversations/:id/intelligence Route Handler', () => {
  beforeEach(() => {
    process.env.MNEMOS_AUTH_ENABLED = 'false';
    resetRateLimits();
    mockGetById.mockReset();
    mockUpdateSummary.mockReset();
    mockSummarize.mockReset();
    mockExtract.mockReset();
    ConversationIntelligenceService.resetLocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should successfully run summarize operation', async () => {
    const mockConv = {
      id: 'conv-123',
      userId: 'user-1',
      transcript: 'This is the transcript to summarize.',
      createdAt: new Date(),
    };
    mockGetById.mockResolvedValueOnce(mockConv);
    mockSummarize.mockResolvedValueOnce('Concise summary output.');
    mockUpdateSummary.mockResolvedValueOnce(mockConv);

    const request = new Request('http://localhost/api/v1/conversations/conv-123/intelligence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1', operation: 'summarize' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe('success');
    expect(data.data.operation).toBe('summarize');
    expect(data.data.summary).toBe('Concise summary output.');
    expect(mockUpdateSummary).toHaveBeenCalledWith('conv-123', 'Concise summary output.');
  });

  it('should successfully run extract-memories operation', async () => {
    const mockConv = {
      id: 'conv-123',
      userId: 'user-1',
      transcript: 'Transcript to extract.',
      createdAt: new Date(),
    };
    mockGetById.mockResolvedValueOnce(mockConv);
    
    const mockMemories = [
      { id: 'mem-1', userId: 'user-1', content: 'Extracted fact 1' },
      { id: 'mem-2', userId: 'user-1', content: 'Extracted fact 2' },
    ];
    mockExtract.mockResolvedValueOnce(mockMemories);

    const request = new Request('http://localhost/api/v1/conversations/conv-123/intelligence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1', operation: 'extract-memories' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe('success');
    expect(data.data.operation).toBe('extract-memories');
    expect(data.data.extractedCount).toBe(2);
    expect(data.data.memoryIds).toEqual(['mem-1', 'mem-2']);
  });

  it('should return 400 for invalid operations', async () => {
    const request = new Request('http://localhost/api/v1/conversations/conv-123/intelligence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1', operation: 'invalid-op' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(400);
  });

  it('should return 403 on isolation breach (ownership check before lock)', async () => {
    const mockConv = {
      id: 'conv-123',
      userId: 'user-1',
      transcript: 'Secrets.',
      createdAt: new Date(),
    };
    mockGetById.mockResolvedValueOnce(mockConv);

    const request = new Request('http://localhost/api/v1/conversations/conv-123/intelligence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-2', operation: 'summarize' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(403);
  });

  it('should return 409 for the same operation running concurrently', async () => {
    const mockConv = {
      id: 'conv-123',
      userId: 'user-1',
      transcript: 'Transcript payload.',
      createdAt: new Date(),
    };
    mockGetById.mockResolvedValue(mockConv);
    
    let resolveSummarize!: (val: string) => void;
    const summarizePromise = new Promise<string>((resolve) => {
      resolveSummarize = resolve;
    });
    mockSummarize.mockImplementationOnce(() => summarizePromise);

    const req1 = new Request('http://localhost/api/v1/conversations/conv-123/intelligence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1', operation: 'summarize' }),
    });
    const req2 = new Request('http://localhost/api/v1/conversations/conv-123/intelligence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1', operation: 'summarize' }),
    });

    const p1 = POST(req1, { params: Promise.resolve({ id: 'conv-123' }) });
    const p2 = POST(req2, { params: Promise.resolve({ id: 'conv-123' }) });

    // Wait a tick for the execution to reach mockSummarize
    await new Promise((resolve) => process.nextTick(resolve));

    resolveSummarize('Summary text.');

    const res1 = await p1;
    const res2 = await p2;

    const statuses = [res1.status, res2.status];
    expect(statuses).toContain(200);
    expect(statuses).toContain(409);
  });

  it('should allow different operations to run concurrently on the same conversation', async () => {
    const mockConv = {
      id: 'conv-123',
      userId: 'user-1',
      transcript: 'Transcript details.',
      createdAt: new Date(),
    };
    mockGetById.mockResolvedValue(mockConv);
    mockSummarize.mockResolvedValueOnce('Summary output');
    mockExtract.mockResolvedValueOnce([]);

    const req1 = new Request('http://localhost/api/v1/conversations/conv-123/intelligence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1', operation: 'summarize' }),
    });
    const req2 = new Request('http://localhost/api/v1/conversations/conv-123/intelligence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1', operation: 'extract-memories' }),
    });

    const [res1, res2] = await Promise.all([
      POST(req1, { params: Promise.resolve({ id: 'conv-123' }) }),
      POST(req2, { params: Promise.resolve({ id: 'conv-123' }) }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });

  it('should release the concurrency lock on success', async () => {
    const mockConv = {
      id: 'conv-123',
      userId: 'user-1',
      transcript: 'Transcript to analyze.',
      createdAt: new Date(),
    };
    mockGetById.mockResolvedValue(mockConv);
    mockSummarize.mockResolvedValue('Summary text.');

    const runRequest = async () => {
      const request = new Request('http://localhost/api/v1/conversations/conv-123/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', operation: 'summarize' }),
      });
      return POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    };

    const res1 = await runRequest();
    expect(res1.status).toBe(200);

    const res2 = await runRequest();
    expect(res2.status).toBe(200);
  });

  it('should release the concurrency lock on failure', async () => {
    const mockConv = {
      id: 'conv-123',
      userId: 'user-1',
      transcript: 'Transcript to analyze.',
      createdAt: new Date(),
    };
    mockGetById.mockResolvedValue(mockConv);
    mockSummarize.mockRejectedValue(new Error('Gemini API fail'));

    const runRequest = async () => {
      const request = new Request('http://localhost/api/v1/conversations/conv-123/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', operation: 'summarize' }),
      });
      return POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    };

    const res1 = await runRequest();
    expect(res1.status).toBe(500);

    const res2 = await runRequest();
    expect(res2.status).toBe(500);
  });

  it('should require authentication when enabled', async () => {
    process.env.MNEMOS_AUTH_ENABLED = 'true';
    process.env.MNEMOS_API_KEY = 'secret-key';

    const request = new Request('http://localhost/api/v1/conversations/conv-123/intelligence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1', operation: 'summarize' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(401);
  });

  it('should preserve backward compatibility of legacy endpoints', async () => {
    const mockConv = {
      id: 'conv-123',
      userId: 'user-1',
      transcript: 'Transcript content.',
      createdAt: new Date(),
    };
    mockGetById.mockResolvedValue(mockConv);
    mockSummarize.mockResolvedValueOnce('Summary output.');
    mockUpdateSummary.mockResolvedValueOnce(mockConv);

    const req1 = new Request('http://localhost/api/v1/conversations/conv-123/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1' }),
    });
    const res1 = await legacySummarizeRoute(req1, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(res1.status).toBe(200);

    mockExtract.mockResolvedValueOnce([]);
    const req2 = new Request('http://localhost/api/v1/conversations/conv-123/extract-memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1' }),
    });
    const res2 = await legacyExtractRoute(req2, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(res2.status).toBe(200);
  });
});
