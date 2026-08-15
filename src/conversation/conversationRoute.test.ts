import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST, GET as listRoute } from '@/app/api/v1/conversations/route';
import { GET as getByIdRoute } from '@/app/api/v1/conversations/[id]/route';
import { resetRateLimits } from '@/memory/security';

const mockCreate = vi.fn();
const mockGetById = vi.fn();
const mockListByUser = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/conversation/repository', () => {
  return {
    PgConversationRepository: vi.fn().mockImplementation(function () {
      return {
        create: mockCreate,
        getById: mockGetById,
        listByUser: mockListByUser,
        delete: mockDelete,
      };
    }),
  };
});

describe('Conversations API Routes', () => {
  beforeEach(() => {
    process.env.MNEMOS_AUTH_ENABLED = 'false';
    resetRateLimits();
    mockCreate.mockReset();
    mockGetById.mockReset();
    mockListByUser.mockReset();
    mockDelete.mockReset();
  });

  describe('POST /api/v1/conversations', () => {
    it('should successfully save a new conversation', async () => {
      const mockResult = {
        id: 'uuid-1',
        userId: 'user-1',
        transcript: 'Testing conversation save flow',
        createdAt: new Date(),
      };
      mockCreate.mockResolvedValueOnce(mockResult);

      const request = new Request('http://localhost/api/v1/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          transcript: 'Testing conversation save flow',
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('success');
      expect(data.data.conversation.id).toBe('uuid-1');
    });

    it('should reject requests with empty transcript', async () => {
      const request = new Request('http://localhost/api/v1/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          transcript: '   ',
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.status).toBe('error');
      expect(data.error).toContain('transcript is required');
    });

    it('should reject requests with invalid startedAt', async () => {
      const request = new Request('http://localhost/api/v1/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          transcript: 'Hello',
          startedAt: 'invalid-date',
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('startedAt must be a valid timestamp');
    });

    it('should reject requests with invalid durationSeconds', async () => {
      const request = new Request('http://localhost/api/v1/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          transcript: 'Hello',
          durationSeconds: -50,
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('durationSeconds must be a non-negative integer');
    });

    it('should require authentication when enabled', async () => {
      process.env.MNEMOS_AUTH_ENABLED = 'true';
      process.env.MNEMOS_API_KEY = 'valid-key';

      const request = new Request('http://localhost/api/v1/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          transcript: 'Hello',
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/conversations', () => {
    it('should list conversations for a user', async () => {
      mockListByUser.mockResolvedValueOnce([
        { id: 'uuid-1', userId: 'user-1', transcript: 'Hello preview', createdAt: new Date() }
      ]);

      const request = new Request('http://localhost/api/v1/conversations?userId=user-1', {
        method: 'GET',
      });

      const response = await listRoute(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('success');
      expect(data.data.conversations).toHaveLength(1);
    });

    it('should reject when userId is missing', async () => {
      const request = new Request('http://localhost/api/v1/conversations', {
        method: 'GET',
      });

      const response = await listRoute(request);
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('userId is required');
    });

    it('should enforce limit limit boundaries (max 50)', async () => {
      const request = new Request('http://localhost/api/v1/conversations?userId=user-1&limit=60', {
        method: 'GET',
      });

      const response = await listRoute(request);
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('limit must be an integer between 1 and 50');
    });
  });

  describe('GET /api/v1/conversations/:id', () => {
    it('should return a full conversation on match', async () => {
      const mockResult = {
        id: 'uuid-1',
        userId: 'user-1',
        transcript: 'Full detailed transcript here',
        createdAt: new Date(),
      };
      mockGetById.mockResolvedValueOnce(mockResult);

      const request = new Request('http://localhost/api/v1/conversations/uuid-1?userId=user-1', {
        method: 'GET',
      });

      const response = await getByIdRoute(request, { params: Promise.resolve({ id: 'uuid-1' }) });
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('success');
      expect(data.data.conversation.transcript).toBe('Full detailed transcript here');
    });

    it('should block user isolation breaches (cross-user access)', async () => {
      const mockResult = {
        id: 'uuid-1',
        userId: 'user-1',
        transcript: 'Secret conversation details',
        createdAt: new Date(),
      };
      mockGetById.mockResolvedValueOnce(mockResult);

      const request = new Request('http://localhost/api/v1/conversations/uuid-1?userId=user-2', {
        method: 'GET',
      });

      const response = await getByIdRoute(request, { params: Promise.resolve({ id: 'uuid-1' }) });
      expect(response.status).toBe(403);

      const data = await response.json();
      expect(data.status).toBe('error');
      expect(data.error).toContain('Forbidden: Access denied');
    });

    it('should return 404 when not found', async () => {
      mockGetById.mockResolvedValueOnce(null);

      const request = new Request('http://localhost/api/v1/conversations/non-existent?userId=user-1', {
        method: 'GET',
      });

      const response = await getByIdRoute(request, { params: Promise.resolve({ id: 'non-existent' }) });
      expect(response.status).toBe(404);
    });
  });
});
