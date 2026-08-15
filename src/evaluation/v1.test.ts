import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST as ingestPOST } from '@/app/api/v1/memory/ingest/route';
import { POST as searchPOST } from '@/app/api/v1/memory/search/route';
import { POST as contextPOST } from '@/app/api/v1/memory/context/route';
import { POST as respondPOST } from '@/app/api/v1/memory/respond/route';
import { GET as healthGET } from '@/app/api/v1/memory/health/route';
import * as db from '@/db';

vi.mock('@/memory/repository', () => {
  return {
    PgMemoryRepository: class {
      get = vi.fn();
      update = vi.fn();
    },
  };
});

vi.mock('@/memory/geminiEmbedding', () => {
  return {
    GeminiEmbeddingProvider: class {
      generateEmbedding = vi.fn().mockResolvedValue([0.1, 0.2]);
    },
  };
});

vi.mock('@/memory/geminiExtractor', () => {
  return {
    GeminiMemoryExtractor: class {
      reconcile = vi.fn().mockResolvedValue([]);
    },
  };
});

vi.mock('@/memory/ingestionService', () => {
  return {
    MemoryIngestionService: class {
      ingest = vi.fn().mockResolvedValue([
        { id: 'mem-1', userId: 'user-123', type: 'FACT', content: 'Saved Fact' },
      ]);
    },
  };
});

vi.mock('@/memory/retriever', () => {
  return {
    MemoryRetriever: class {
      retrieve = vi.fn().mockResolvedValue([
        {
          memory: {
            id: 'mem-2',
            userId: 'user-123',
            type: 'FACT',
            content: 'Search Fact',
            metadata: { status: 'active' },
          },
          similarity: 0.9,
        },
      ]);
    },
  };
});

vi.mock('@/context/assembler', () => {
  return {
    ContextAssembler: class {
      assemble = vi.fn().mockReturnValue({
        query: 'test',
        items: [
          {
            id: 'mem-2',
            type: 'FACT',
            content: 'Search Fact',
            similarity: 0.9,
            score: 0.95,
            reason: 'some reason',
            status: 'active',
          },
        ],
        context: '[FACT] [CURRENT] Search Fact',
        tokenCount: 10,
        governance: {
          allowedCount: 1,
          downrankedCount: 0,
          excludedCount: 0,
          conflictsDetectedCount: 0,
          lowConfidenceCount: 0,
          injectionBlockedCount: 0,
          details: {},
        },
      });
    },
  };
});

vi.mock('@/response/geminiGenerator', () => {
  return {
    GeminiResponseGenerator: class {
      generateResponse = vi.fn().mockResolvedValue({
        text: 'Grounded Answer',
        metadata: { model: 'gemini-3.5-flash' },
      });
    },
  };
});

vi.mock('@/response/service', () => {
  return {
    ResponseService: class {
      respond = vi.fn().mockResolvedValue({
        response: 'Grounded Answer',
        usedMemories: [{ id: 'mem-2', type: 'FACT', similarity: 0.9, score: 0.95 }],
        contextTokenCount: 10,
        governance: {
          allowedCount: 1,
          downrankedCount: 0,
          excludedCount: 0,
          conflictsDetectedCount: 0,
          lowConfidenceCount: 0,
          injectionBlockedCount: 0,
          details: {},
        },
      });
    },
  };
});

vi.mock('@/db', () => {
  return {
    testConnection: vi.fn().mockResolvedValue(true),
  };
});

describe('Sprint 10: Developer API v1 Route Integrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/v1/memory/ingest', () => {
    it('should validate parameter inputs and reject with 400', async () => {
      const req = new Request('http://localhost/api/v1/memory/ingest', {
        method: 'POST',
        body: JSON.stringify({ userId: '', content: '' }),
      });
      const res = await ingestPOST(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.status).toBe('error');
      expect(json.error).toContain('userId is required');
      expect(json.requestId).toBeDefined();
    });

    it('should return consistent successful JSend JSON schema and requestId', async () => {
      const req = new Request('http://localhost/api/v1/memory/ingest', {
        method: 'POST',
        body: JSON.stringify({ userId: 'user-123', content: 'Valid raw fact' }),
      });
      const res = await ingestPOST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe('success');
      expect(json.data.memories).toHaveLength(1);
      expect(json.data.memories[0].content).toBe('Saved Fact');
      expect(json.requestId).toBeDefined();
    });
  });

  describe('POST /api/v1/memory/search', () => {
    it('should enforce limits validations', async () => {
      const req = new Request('http://localhost/api/v1/memory/search', {
        method: 'POST',
        body: JSON.stringify({ userId: 'user-123', query: 'q', limit: 999 }),
      });
      const res = await searchPOST(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.status).toBe('error');
      expect(json.error).toContain('limit must be an integer between 1 and 100');
    });

    it('should retrieve candidate matches successfully', async () => {
      const req = new Request('http://localhost/api/v1/memory/search', {
        method: 'POST',
        body: JSON.stringify({ userId: 'user-123', query: 'find db' }),
      });
      const res = await searchPOST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe('success');
      expect(json.data.results).toHaveLength(1);
      expect(json.data.results[0].memory.content).toBe('Search Fact');
    });
  });

  describe('POST /api/v1/memory/context', () => {
    it('should enforce token budget constraints', async () => {
      const req = new Request('http://localhost/api/v1/memory/context', {
        method: 'POST',
        body: JSON.stringify({ userId: 'user-123', query: 'c', maxTokens: -5 }),
      });
      const res = await contextPOST(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.status).toBe('error');
      expect(json.error).toContain('maxTokens must be an integer');
    });

    it('should compile structured context items and governance logs', async () => {
      const req = new Request('http://localhost/api/v1/memory/context', {
        method: 'POST',
        body: JSON.stringify({ userId: 'user-123', query: 'facts', limit: 2 }),
      });
      const res = await contextPOST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe('success');
      expect(json.data.context).toBeDefined();
      expect(json.data.governance).toBeDefined();
    });
  });

  describe('POST /api/v1/memory/respond', () => {
    it('should generate grounded answers using generator pipeline', async () => {
      const req = new Request('http://localhost/api/v1/memory/respond', {
        method: 'POST',
        body: JSON.stringify({ userId: 'user-123', query: 'question' }),
      });
      const res = await respondPOST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe('success');
      expect(json.data.response).toBe('Grounded Answer');
    });
  });

  describe('GET /api/v1/memory/health', () => {
    it('should return 200 when database and keys are valid', async () => {
      process.env.GEMINI_API_KEY = 'valid-key';
      const res = await healthGET();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe('success');
      expect(json.data.database).toBe('healthy');
      expect(json.data.provider).toBe('healthy');
    });

    it('should report 503 and unhealthy state if database is disconnected', async () => {
      process.env.GEMINI_API_KEY = 'valid-key';
      vi.spyOn(db, 'testConnection').mockResolvedValueOnce(false);
      const res = await healthGET();
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.status).toBe('error');
      expect(json.data.database).toBe('unhealthy');
    });

    it('should report 503 if GEMINI_API_KEY is missing', async () => {
      const origKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      const res = await healthGET();
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.status).toBe('error');
      expect(json.data.provider).toBe('unhealthy');
      process.env.GEMINI_API_KEY = origKey;
    });
  });
});
