import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';
import { resetRateLimits } from '@/memory/security';

const mockGetById = vi.fn();
const mockUpdateSummary = vi.fn();
const mockSummarize = vi.fn();

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

describe('POST /api/v1/conversations/:id/summarize API Route', () => {
  beforeEach(() => {
    process.env.MNEMOS_AUTH_ENABLED = 'false';
    resetRateLimits();
    mockGetById.mockReset();
    mockUpdateSummary.mockReset();
    mockSummarize.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should successfully summarize and return summary', async () => {
    const mockConv = {
      id: 'conv-123',
      userId: 'user-1',
      transcript: 'This is the transcript to summarize.',
      createdAt: new Date(),
    };
    mockGetById.mockResolvedValueOnce(mockConv);
    mockSummarize.mockResolvedValueOnce('Concise conversation summary.');
    mockUpdateSummary.mockResolvedValueOnce({
      ...mockConv,
      summary: 'Concise conversation summary.',
    });

    const request = new Request('http://localhost/api/v1/conversations/conv-123/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe('success');
    expect(data.data.conversationId).toBe('conv-123');
    expect(data.data.summary).toBe('Concise conversation summary.');
    expect(mockUpdateSummary).toHaveBeenCalledWith('conv-123', 'Concise conversation summary.');
  });

  it('should support summary regeneration and overwrite old summaries idempotently', async () => {
    const mockConv = {
      id: 'conv-123',
      userId: 'user-1',
      transcript: 'Transcript payload.',
      summary: 'Old summary.',
      createdAt: new Date(),
    };
    mockGetById.mockResolvedValueOnce(mockConv);
    mockSummarize.mockResolvedValueOnce('New summary details.');
    mockUpdateSummary.mockResolvedValueOnce({
      ...mockConv,
      summary: 'New summary details.',
    });

    const request = new Request('http://localhost/api/v1/conversations/conv-123/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.data.summary).toBe('New summary details.');
    expect(mockUpdateSummary).toHaveBeenCalledWith('conv-123', 'New summary details.');
  });

  it('should not report success if database persistence fails', async () => {
    const mockConv = {
      id: 'conv-123',
      userId: 'user-1',
      transcript: 'Transcript to save.',
      createdAt: new Date(),
    };
    mockGetById.mockResolvedValueOnce(mockConv);
    mockSummarize.mockResolvedValueOnce('Generated summary text.');
    mockUpdateSummary.mockRejectedValueOnce(new Error('Postgres connection pool error'));

    const request = new Request('http://localhost/api/v1/conversations/conv-123/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.status).toBe('error');
    expect(data.error).toContain('An error occurred during conversation summarization.');
  });

  it('should return 403 Forbidden on cross-user conversation access', async () => {
    const mockConv = {
      id: 'conv-123',
      userId: 'user-1',
      transcript: 'Secrets.',
      createdAt: new Date(),
    };
    mockGetById.mockResolvedValueOnce(mockConv);

    const request = new Request('http://localhost/api/v1/conversations/conv-123/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-2' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(403);
  });

  it('should return 404 when conversation not found', async () => {
    mockGetById.mockResolvedValueOnce(null);

    const request = new Request('http://localhost/api/v1/conversations/non-existent/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'non-existent' }) });
    expect(response.status).toBe(404);
  });

  it('should return 422 when transcript is empty', async () => {
    const mockConv = {
      id: 'conv-123',
      userId: 'user-1',
      transcript: '   ',
      createdAt: new Date(),
    };
    mockGetById.mockResolvedValueOnce(mockConv);

    const request = new Request('http://localhost/api/v1/conversations/conv-123/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(422);
  });

  it('should require authentication when enabled', async () => {
    process.env.MNEMOS_AUTH_ENABLED = 'true';
    process.env.MNEMOS_API_KEY = 'secret-key';

    const request = new Request('http://localhost/api/v1/conversations/conv-123/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(401);
  });
});
