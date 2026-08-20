import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryIngestionService, isMeaninglessTranscript } from '@/memory/ingestionService';
import { POST as respondPOST } from '@/app/api/v1/voice/respond/route';
import { POST as transcribePOST } from '@/app/api/v1/voice/transcribe/route';
import { resetRateLimits } from '@/memory/security';
import { GeminiResponseGenerator } from '@/response/geminiGenerator';
import { NextRequest } from 'next/server';
import { MemoryRepository } from '@/memory/repository';
import { MemoryExtractor } from '@/memory/extractor';
import { EmbeddingProvider } from '@/memory/embedding';

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

describe('Sprint 69: Voice Memory Quality, Deduplication & Reinforcement Tests', () => {
  const originalEnv = process.env.NODE_ENV;
  const mockRepo = {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    get: vi.fn(),
  };
  const mockExtractor = {
    reconcile: vi.fn(),
  };
  const mockEmbeddingProvider = {
    generateEmbedding: vi.fn(),
  };

  let service: MemoryIngestionService;

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

    mockRepo.list.mockReset();
    mockRepo.create.mockReset();
    mockRepo.update.mockReset();
    mockRepo.get.mockReset();
    mockExtractor.reconcile.mockReset();
    mockEmbeddingProvider.generateEmbedding.mockReset();

    service = new MemoryIngestionService(
      mockRepo as unknown as MemoryRepository,
      mockExtractor as unknown as MemoryExtractor,
      mockEmbeddingProvider as unknown as EmbeddingProvider
    );
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

  describe('isMeaninglessTranscript', () => {
    it('should reject short filler or noise transcripts', () => {
      expect(isMeaninglessTranscript('ok')).toBe(true);
      expect(isMeaninglessTranscript('ok.')).toBe(true);
      expect(isMeaninglessTranscript('hello')).toBe(true);
      expect(isMeaninglessTranscript('uh')).toBe(true);
      expect(isMeaninglessTranscript('thank you')).toBe(true);
    });

    it('should accept meaningful short transcripts', () => {
      expect(isMeaninglessTranscript('Use Neon.')).toBe(false);
      expect(isMeaninglessTranscript('No COBOL')).toBe(false);
    });

    it('should respect custom environment limits', () => {
      process.env.VOICE_MIN_LENGTH = '10';
      expect(isMeaninglessTranscript('Short')).toBe(true);
      delete process.env.VOICE_MIN_LENGTH;
    });
  });

  describe('ingestVoice quality and duplicate checks', () => {
    it('should discard meaningless content immediately', async () => {
      const result = await service.ingestVoice('user-1', 'ok');
      expect(result.outcome).toBe('discarded');
      expect(result.memories).toHaveLength(0);
      expect(mockRepo.list).not.toHaveBeenCalled();
    });

    it('should create new memory when no similar memory exists (similarity < 0.88)', async () => {
      mockRepo.list.mockResolvedValueOnce([]);
      mockExtractor.reconcile.mockResolvedValueOnce([
        { action: 'CREATE', type: 'PREFERENCE', content: 'User prefers dark mode', confidence: 0.9, importance: 8 }
      ]);
      mockEmbeddingProvider.generateEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);

      // Mock database pgvector query return: similarity 0.85 (below 0.88 duplicate threshold)
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'mem-existing-1',
            userId: 'user-1',
            type: 'PREFERENCE',
            content: 'User prefers light mode',
            metadata: { status: 'active', confidence: 0.8 },
            similarity: 0.85
          }
        ]
      });

      mockRepo.create.mockResolvedValueOnce({
        id: 'mem-new-1',
        userId: 'user-1',
        type: 'PREFERENCE',
        content: 'User prefers dark mode',
        metadata: { source: 'voice', status: 'active' }
      });

      const result = await service.ingestVoice('user-1', 'I prefer dark mode');
      expect(result.outcome).toBe('created');
      expect(result.affectedMemoryId).toBe('mem-new-1');
      expect(mockRepo.create).toHaveBeenCalled();
    });

    it('should reinforce existing active memory at boundary similarity (similarity = 0.88)', async () => {
      mockRepo.list.mockResolvedValueOnce([]);
      mockExtractor.reconcile.mockResolvedValueOnce([
        { action: 'CREATE', type: 'PREFERENCE', content: 'User prefers dark mode', confidence: 0.8, importance: 8 }
      ]);
      mockEmbeddingProvider.generateEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);

      // Mock pgvector boundary check: similarity exactly 0.88
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'mem-existing-1',
            userId: 'user-1',
            type: 'PREFERENCE',
            content: 'User prefers dark theme',
            metadata: { status: 'active', confidence: 0.8, accessCount: 1, reinforcementCount: 1 },
            similarity: 0.88
          }
        ]
      });

      mockRepo.update.mockResolvedValueOnce({
        id: 'mem-existing-1',
        userId: 'user-1',
        type: 'PREFERENCE',
        content: 'User prefers dark theme',
        metadata: { status: 'active', confidence: 0.85 }
      });

      const result = await service.ingestVoice('user-1', 'I prefer dark mode');
      expect(result.outcome).toBe('reinforced');
      expect(result.affectedMemoryId).toBe('mem-existing-1');
      expect(mockRepo.update).toHaveBeenCalled();
    });

    it('should clamp reinforced confidence to max 1.0', async () => {
      mockRepo.list.mockResolvedValueOnce([]);
      mockExtractor.reconcile.mockResolvedValueOnce([
        { action: 'CREATE', type: 'PREFERENCE', content: 'User prefers dark mode', confidence: 0.8, importance: 8 }
      ]);
      mockEmbeddingProvider.generateEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);

      // Already at max confidence 0.99
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'mem-existing-1',
            userId: 'user-1',
            type: 'PREFERENCE',
            content: 'User prefers dark theme',
            metadata: { status: 'active', confidence: 0.99, accessCount: 1, reinforcementCount: 1 },
            similarity: 0.92
          }
        ]
      });

      await service.ingestVoice('user-1', 'I prefer dark mode');
      // Assert that confidence update clamped to 1.0
      expect(mockRepo.update).toHaveBeenCalledWith('mem-existing-1', {
        metadata: expect.objectContaining({
          confidence: 1.0
        })
      });
    });

    it('should preserve temporal conflict metadata on contradiction update', async () => {
      mockRepo.list.mockResolvedValueOnce([]);
      const existingMemory = {
        id: 'mem-old-1',
        userId: 'user-1',
        type: 'PREFERENCE',
        content: 'User prefers Light mode',
        metadata: { status: 'active' }
      };
      mockExtractor.reconcile.mockResolvedValueOnce([
        { action: 'UPDATE', id: 'mem-old-1', type: 'PREFERENCE', content: 'User prefers Dark mode', confidence: 0.9 }
      ]);
      mockRepo.get.mockResolvedValueOnce(existingMemory);

      mockRepo.create.mockResolvedValueOnce({
        id: 'mem-new-2',
        userId: 'user-1',
        type: 'PREFERENCE',
        content: 'User prefers Dark mode',
        metadata: { status: 'active', supersedes: 'mem-old-1' }
      });

      const result = await service.ingestVoice('user-1', 'I prefer Dark mode now');
      expect(result.outcome).toBe('updated');
      expect(result.affectedMemoryId).toBe('mem-new-2');
      expect(mockRepo.update).toHaveBeenCalledWith('mem-old-1', {
        metadata: expect.objectContaining({
          status: 'superseded',
          supersededBy: 'mem-new-2'
        })
      });
    });
  });

  describe('API endpoint validation', () => {
    it('should return discarded outcome successfully with HTTP 200 in transcribe route', async () => {
      mockTranscribe.mockResolvedValueOnce({
        text: 'hello'
      });

      const formData = new FormData();
      const blob = new Blob([Buffer.from('wav-data')], { type: 'audio/wav' });
      formData.append('file', blob);
      formData.append('userId', 'user-1');

      const request = new NextRequest('http://localhost/api/v1/voice/transcribe', {
        method: 'POST',
        body: formData,
      });

      const response = await transcribePOST(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('success');
      expect(data.data.outcome).toBe('discarded');
      expect(data.data.saved).toBe(false);
    });

    it('should return deduplicated grounded memories in respond route', async () => {
      mockTranscribe.mockResolvedValueOnce({
        text: 'What do I like?'
      });

      // Mock database pgvector query return for ingestion check
      mockQuery.mockResolvedValueOnce({
        rows: []
      });

      // Mock response service respond
      vi.spyOn(GeminiResponseGenerator.prototype, 'generateResponse').mockResolvedValueOnce({
        text: 'You like coding.'
      });

      // Mock database retrieval returning duplicate voice memories:
      // "User prefers VS Code" and "User prefers VSCode editor"
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'mem-ret-1',
            userId: 'user-1',
            type: 'PREFERENCE',
            content: 'User prefers VS Code',
            metadata: { source: 'voice', sourceType: 'voice' },
            embedding: [0.1, 0.2, 0.3],
            similarity: 0.95
          },
          {
            id: 'mem-ret-2',
            userId: 'user-1',
            type: 'PREFERENCE',
            content: 'User prefers VS Code editor',
            metadata: { source: 'voice', sourceType: 'voice' },
            embedding: [0.1, 0.2, 0.3],
            similarity: 0.92
          }
        ]
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
      // Assert duplicate is removed and highest similarity is kept
      expect(data.data.usedMemories).toHaveLength(1);
      expect(data.data.usedMemories[0].id).toBe('mem-ret-1');
    });
  });
});
