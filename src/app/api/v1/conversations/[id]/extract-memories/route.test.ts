import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';
import { resetRateLimits } from '@/memory/security';

const mockExtract = vi.fn();

vi.mock('@/conversation/extractionService', () => {
  return {
    ConversationMemoryExtractionService: vi.fn().mockImplementation(function () {
      return {
        extract: mockExtract,
      };
    }),
  };
});

describe('POST /api/v1/conversations/:id/extract-memories API Route', () => {
  beforeEach(() => {
    process.env.MNEMOS_AUTH_ENABLED = 'false';
    resetRateLimits();
    mockExtract.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should successfully extract memories and return memory IDs', async () => {
    const mockMemories = [
      { id: 'mem-1', userId: 'user-1', type: 'FACT', content: 'Likes apples', metadata: {} },
      { id: 'mem-2', userId: 'user-1', type: 'PREFERENCE', content: 'Prefers tea', metadata: {} },
    ];
    mockExtract.mockResolvedValueOnce(mockMemories);

    const request = new Request('http://localhost/api/v1/conversations/conv-123/extract-memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe('success');
    expect(data.data.conversationId).toBe('conv-123');
    expect(data.data.extractedCount).toBe(2);
    expect(data.data.memoryIds).toEqual(['mem-1', 'mem-2']);
    expect(data.requestId).toBeDefined();
  });

  it('should return empty list if no memories are extracted', async () => {
    mockExtract.mockResolvedValueOnce([]);

    const request = new Request('http://localhost/api/v1/conversations/conv-123/extract-memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.data.extractedCount).toBe(0);
    expect(data.data.memoryIds).toEqual([]);
  });

  it('should reject when userId is missing', async () => {
    const request = new Request('http://localhost/api/v1/conversations/conv-123/extract-memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.status).toBe('error');
    expect(data.error).toContain('userId is required');
  });

  it('should require authentication when enabled', async () => {
    process.env.MNEMOS_AUTH_ENABLED = 'true';
    process.env.MNEMOS_API_KEY = 'super-secret';

    const request = new Request('http://localhost/api/v1/conversations/conv-123/extract-memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(401);
  });

  it('should return 403 Forbidden on cross-user conversation access', async () => {
    mockExtract.mockRejectedValueOnce(new Error('Forbidden: Access denied to this conversation.'));

    const request = new Request('http://localhost/api/v1/conversations/conv-123/extract-memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-2' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(403);

    const data = await response.json();
    expect(data.error).toContain('Access denied');
  });

  it('should return 404 Not Found when conversation does not exist', async () => {
    mockExtract.mockRejectedValueOnce(new Error('Conversation not found.'));

    const request = new Request('http://localhost/api/v1/conversations/non-existent/extract-memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'non-existent' }) });
    expect(response.status).toBe(404);
  });

  it('should return 422 Unprocessable Entity when transcript is empty', async () => {
    mockExtract.mockRejectedValueOnce(new Error('Empty transcript: No memories can be extracted from this conversation.'));

    const request = new Request('http://localhost/api/v1/conversations/conv-123/extract-memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(422);
  });

  it('should return 500 on unexpected service failure', async () => {
    mockExtract.mockRejectedValueOnce(new Error('Gemini API quota exceeded'));

    const request = new Request('http://localhost/api/v1/conversations/conv-123/extract-memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'conv-123' }) });
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.error).toContain('An error occurred during conversation memory extraction.');
  });
});
