import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET as listGET } from '@/app/api/v1/voice/memories/route';
import { DELETE as deleteDELETE } from '@/app/api/v1/voice/memories/[id]/route';
import { POST as respondPOST } from '@/app/api/v1/voice/respond/route';
import { resetRateLimits } from '@/memory/security';
import { GeminiResponseGenerator } from '@/response/geminiGenerator';
import { NextRequest } from 'next/server';

const mockQuery = vi.fn();
vi.mock('@/db', () => ({
  getDbPool: vi.fn(() => ({
    query: mockQuery,
  })),
}));

const mockGenerate = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
vi.mock('@/memory/geminiEmbedding', () => {
  return {
    GeminiEmbeddingProvider: vi.fn().mockImplementation(function () {
      return {
        generateEmbedding: mockGenerate,
      };
    }),
  };
});

const mockTranscribe = vi.fn();
vi.mock('./whisperTranscription', () => {
  return {
    WhisperTranscriptionProvider: vi.fn().mockImplementation(function () {
      return {
        transcribe: mockTranscribe,
      };
    }),
  };
});

describe('Sprint 68: Voice Memory Management & Retrieval Transparency Tests', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: 'test',
      configurable: true,
      writable: true,
      enumerable: true,
    });
    process.env.MNEMOS_AUTH_ENABLED = 'false';
    process.env.WHISPER_PROVIDER = 'cloud';
    resetRateLimits();

    mockQuery.mockReset();
    mockTranscribe.mockReset();
    mockGenerate.mockReset();
    mockGenerate.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  afterEach(() => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: originalEnv,
      configurable: true,
      writable: true,
      enumerable: true,
    });
    vi.restoreAllMocks();
  });

  describe('GET /api/v1/voice/memories', () => {
    it('should block production environments with 403', async () => {
      Object.defineProperty(process.env, 'NODE_ENV', {
        value: 'production',
        configurable: true,
        writable: true,
        enumerable: true,
      });

      const request = new NextRequest('http://localhost/api/v1/voice/memories?userId=user-1');
      const response = await listGET(request);

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toContain('only available in development/testing');
    });

    it('should require userId parameter for user isolation', async () => {
      const request = new NextRequest('http://localhost/api/v1/voice/memories');
      const response = await listGET(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('userId is required');
    });

    it('should return list of voice-created memories only, fully sanitized', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'mem-v1',
            userId: 'user-1',
            type: 'FACT',
            content: 'Voice memory one',
            metadata: {
              source: 'voice',
              confidence: 0.95,
              importance: 7,
              status: 'active',
              createdAt: '2026-08-20T10:00:00Z',
            },
            embedding: [0.1, 0.2, 0.3], // should be stripped
            createdAt: new Date('2026-08-20T10:00:00Z'),
            updatedAt: new Date('2026-08-20T10:00:00Z'),
          },
        ],
      });

      const request = new NextRequest('http://localhost/api/v1/voice/memories?userId=user-1');
      const response = await listGET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('success');
      expect(data.memories).toHaveLength(1);

      const mem = data.memories[0];
      expect(mem.id).toBe('mem-v1');
      expect(mem.userId).toBe('user-1');
      expect(mem.content).toBe('Voice memory one');
      expect(mem.metadata.source).toBe('voice');
      expect(mem.metadata.confidence).toBe(0.95);
      
      // Ensure embedding is never exposed
      expect(mem.embedding).toBeUndefined();
    });
  });

  describe('DELETE /api/v1/voice/memories/[id]', () => {
    it('should block production environments with 403', async () => {
      Object.defineProperty(process.env, 'NODE_ENV', {
        value: 'production',
        configurable: true,
        writable: true,
        enumerable: true,
      });

      const request = new NextRequest('http://localhost/api/v1/voice/memories/mem-1', {
        method: 'DELETE',
      });
      const response = await deleteDELETE(request, { params: Promise.resolve({ id: 'mem-1' }) });

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toContain('only available in development/testing');
    });

    it('should delete memory successfully if it belongs to voice source', async () => {
      // 1. Mock GET query returning voice memory
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'mem-v1',
              user_id: 'user-1',
              type: 'FACT',
              content: 'Voice memory content',
              metadata: { source: 'voice' },
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        }) // select query in repo.get()
        .mockResolvedValueOnce({ rowCount: 1 }); // delete query in repo.delete()

      const request = new NextRequest('http://localhost/api/v1/voice/memories/mem-v1', {
        method: 'DELETE',
      });
      const response = await deleteDELETE(request, { params: Promise.resolve({ id: 'mem-v1' }) });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('success');
      expect(data.message).toContain('deleted successfully');
    });

    it('should reject deletion with 404 if memory source is not voice', async () => {
      // Mock repository returning non-voice memory
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'mem-user-1',
            user_id: 'user-1',
            type: 'FACT',
            content: 'User typed memory',
            metadata: { source: 'user_input' },
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      const request = new NextRequest('http://localhost/api/v1/voice/memories/mem-user-1', {
        method: 'DELETE',
      });
      const response = await deleteDELETE(request, { params: Promise.resolve({ id: 'mem-user-1' }) });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain('is not a voice memory');
    });

    it('should return 404 for missing memory ID', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // not found in repo.get()

      const request = new NextRequest('http://localhost/api/v1/voice/memories/mem-missing', {
        method: 'DELETE',
      });
      const response = await deleteDELETE(request, { params: Promise.resolve({ id: 'mem-missing' }) });

      expect(response.status).toBe(404);
    });
  });

  describe('Ask-by-Voice Retrieval Transparency', () => {
    it('should return sanitized usedMemories matching the spec in respond route response', async () => {
      mockTranscribe.mockResolvedValueOnce({
        text: 'What did I say yesterday?',
        metadata: { duration: 1.0 },
      });

      // Retrieval search mock
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // ingestion check
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'mem-v1',
              userId: 'user-1',
              type: 'FACT',
              content: 'User prefer vanilla Javascript stack over Typescript compiler defaults',
              metadata: {
                sourceType: 'voice',
                sourceTimestamp: '2026-08-20T10:00:00Z',
              },
              embedding: [0.1, 0.2, 0.3],
              similarity: 0.92,
            },
          ],
        });

      // Mock response generation
      vi.spyOn(GeminiResponseGenerator.prototype, 'generateResponse').mockResolvedValueOnce({
        text: 'You preference vanilla Javascript.',
      });

      const formData = new FormData();
      const blob = new Blob([Buffer.from('wav-data')], { type: 'audio/wav' });
      formData.append('file', blob);
      formData.append('userId', 'user-1');

      const request = new NextRequest('http://localhost/api/v1/voice/respond', {
        method: 'POST',
        body: formData,
      });

      const response = await respondPOST(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('success');
      expect(data.data.usedMemories).toHaveLength(1);

      const usedMem = data.data.usedMemories[0];
      // Assert exact fields of the contract
      expect(usedMem.id).toBe('mem-v1');
      expect(usedMem.content).toBe('User prefer vanilla Javascript stack over Typescript compiler defaults');
      expect(usedMem.similarity).toBe(0.92);
      expect(usedMem.sourceType).toBe('voice');
      expect(usedMem.timestamp).toBe('2026-08-20T10:00:00Z');

      // Expose absolutely no embeddings or sql
      expect(usedMem.embedding).toBeUndefined();
    });
  });
});
