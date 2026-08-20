import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST as transcribePOST } from '@/app/api/v1/voice/transcribe/route';
import { POST as respondPOST } from '@/app/api/v1/voice/respond/route';
import { resetRateLimits } from '@/memory/security';
import { GeminiResponseGenerator } from '@/response/geminiGenerator';

const mockQuery = vi.fn();
vi.mock('@/db', () => ({
  getDbPool: vi.fn(() => ({
    query: mockQuery,
  })),
}));

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

const mockReconcile = vi.fn();
vi.mock('@/memory/geminiExtractor', () => {
  return {
    GeminiMemoryExtractor: vi.fn().mockImplementation(function () {
      return {
        reconcile: mockReconcile,
      };
    }),
  };
});

describe('Sprint 67: Persistent Voice Memory Integration Tests', () => {
  beforeEach(() => {
    process.env.MNEMOS_AUTH_ENABLED = 'false';
    process.env.WHISPER_PROVIDER = 'cloud';
    resetRateLimits();

    mockQuery.mockReset();
    mockTranscribe.mockReset();
    mockReconcile.mockReset();
    mockGenerate.mockReset();
    mockGenerate.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should save a successful voice transcription to persistent memory with correct metadata and pgvector embedding', async () => {
    // 1. Mock Transcription Success
    mockTranscribe.mockResolvedValueOnce({
      text: 'My favorite editor is VS Code.',
      metadata: { duration: 2.5 },
    });

    // 2. Mock Ingestion / Extraction reconciliation: creates a new memory
    mockReconcile.mockResolvedValueOnce([
      {
        action: 'CREATE',
        type: 'PREFERENCE',
        content: 'User prefers VS Code as their editor',
        confidence: 0.95,
        importance: 6,
      },
    ]);

    // 3. Mock PostgreSQL queries (List active candidates, Create memory, Update memory with embedding)
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // List active memories returns empty
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'mem-123',
            userId: 'user-777',
            type: 'PREFERENCE',
            content: 'User prefers VS Code as their editor',
            metadata: {
              source: 'voice',
              type: 'conversation',
              confidence: 0.95,
              importance: 6,
              status: 'active',
              createdAt: new Date().toISOString(),
            },
          },
        ],
      }) // Create response
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'mem-123',
            userId: 'user-777',
            type: 'PREFERENCE',
            content: 'User prefers VS Code as their editor',
            metadata: {
              source: 'voice',
              type: 'conversation',
              confidence: 0.95,
              importance: 6,
              status: 'active',
              createdAt: new Date().toISOString(),
            },
            embedding: [0.1, 0.2, 0.3],
          },
        ],
      }); // Update response

    // 4. Fire transcribe request
    const formData = new FormData();
    const blob = new Blob([Buffer.from('wav-data')], { type: 'audio/wav' });
    formData.append('file', blob);
    formData.append('userId', 'user-777');

    const request = new Request('http://localhost/api/v1/voice/transcribe', {
      method: 'POST',
      body: formData,
    });

    const response = await transcribePOST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe('success');
    expect(data.data.text).toBe('My favorite editor is VS Code.');
    expect(data.data.saved).toBe(true);
    expect(data.data.memories).toHaveLength(1);

    const memory = data.data.memories[0];
    expect(memory.id).toBe('mem-123');
    expect(memory.metadata.source).toBe('voice');
    expect(memory.metadata.type).toBe('conversation');
    expect(memory.metadata.createdAt).toBeDefined();

    // Verify embedding was requested
    expect(mockGenerate).toHaveBeenCalledWith('User prefers VS Code as their editor');
  });

  it('should not persist anything when voice transcription is empty', async () => {
    mockTranscribe.mockResolvedValueOnce({
      text: '   ',
      metadata: { duration: 0.5 },
    });

    const formData = new FormData();
    const blob = new Blob([Buffer.from('wav-data')], { type: 'audio/wav' });
    formData.append('file', blob);
    formData.append('userId', 'user-777');

    const request = new Request('http://localhost/api/v1/voice/transcribe', {
      method: 'POST',
      body: formData,
    });

    const response = await transcribePOST(request);
    expect(response.status).toBe(422); // Unprocessable Entity

    // DB and Extractor shouldn't be touched
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('should query persistent memories during Ask-by-Voice, retrieving voice-created memories', async () => {
    // 1. Mock Transcription for query
    mockTranscribe.mockResolvedValueOnce({
      text: 'What editor do I use?',
      metadata: { duration: 1.5 },
    });

    // 2. Mock Ingestion check for query (a query should not extract any new facts/preferences)
    mockReconcile.mockResolvedValueOnce([]); // No actions extracted

    // 3. Mock pgvector retrieval search (returns previously stored voice memory)
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // List active memories returns empty during ingest check
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'mem-123',
            userId: 'user-777',
            type: 'PREFERENCE',
            content: 'User prefers VS Code as their editor',
            metadata: {
              source: 'voice',
              sourceType: 'voice',
              type: 'conversation',
              confidence: 0.95,
              importance: 6,
              status: 'active',
              createdAt: new Date().toISOString(),
            },
            embedding: [0.1, 0.2, 0.3],
            similarity: 0.88,
          },
        ],
      }); // Retrieval query response

    vi.spyOn(GeminiResponseGenerator.prototype, 'generateResponse').mockResolvedValueOnce({
      text: 'Based on your saved memories, you use VS Code.',
    });

    const formData = new FormData();
    const blob = new Blob([Buffer.from('wav-data')], { type: 'audio/wav' });
    formData.append('file', blob);
    formData.append('userId', 'user-777');

    const request = new Request('http://localhost/api/v1/voice/respond', {
      method: 'POST',
      body: formData,
    });

    const response = await respondPOST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe('success');
    expect(data.data.transcript).toBe('What editor do I use?');
    expect(data.data.response).toContain('VS Code');
    expect(data.data.usedMemories).toHaveLength(1);
    expect(data.data.usedMemories[0].id).toBe('mem-123');
    expect(data.data.usedMemories[0].sourceType).toBe('voice');
  });

  it('should safely handle duplicate voice submissions without duplicate active memories', async () => {
    // 1. Mock Transcription Success
    mockTranscribe.mockResolvedValueOnce({
      text: 'My favorite editor is VS Code.',
      metadata: { duration: 2.5 },
    });

    // 2. Mock Ingestion / Extraction reconciliation: returns NONE since it is a duplicate
    mockReconcile.mockResolvedValueOnce([
      {
        action: 'NONE',
        id: 'mem-123',
      },
    ]);

    // 3. Mock DB list queries and fetching memory detail
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'mem-123',
            userId: 'user-777',
            type: 'PREFERENCE',
            content: 'User prefers VS Code as their editor',
            metadata: {
              source: 'voice',
              type: 'conversation',
              confidence: 0.95,
              importance: 6,
              status: 'active',
            },
          },
        ],
      }) // List returns existing active candidate
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'mem-123',
            userId: 'user-777',
            type: 'PREFERENCE',
            content: 'User prefers VS Code as their editor',
            metadata: {
              source: 'voice',
              type: 'conversation',
              confidence: 0.95,
              importance: 6,
              status: 'active',
            },
          },
        ],
      }); // Get by ID on NONE action

    const formData = new FormData();
    const blob = new Blob([Buffer.from('wav-data')], { type: 'audio/wav' });
    formData.append('file', blob);
    formData.append('userId', 'user-777');

    const request = new Request('http://localhost/api/v1/voice/transcribe', {
      method: 'POST',
      body: formData,
    });

    const response = await transcribePOST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe('success');
    expect(data.data.saved).toBe(true); // Still marked as saved (it exists in DB)
    expect(data.data.memories).toHaveLength(1);
    expect(data.data.memories[0].id).toBe('mem-123');

    // Verify no repository create or update was called (meaning no duplicates)
    expect(mockQuery).toHaveBeenCalledTimes(2); // List + Get (no INSERT or UPDATE)
  });
});
