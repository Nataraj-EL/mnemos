import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST as ingestPOST } from '@/app/api/v1/memory/ingest/route';
import { resetRateLimits } from '@/memory/security';

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
      ingest = vi.fn().mockImplementation((userId: string, content: string) => {
        if (content.includes('throw_db_error')) {
          throw new Error('pg-connection pool closed unexpectedly: password error.');
        }
        return Promise.resolve([{ id: 'mem-1', userId, type: 'FACT', content }]);
      });
    },
  };
});

vi.mock('@/memory/retriever', () => {
  return {
    MemoryRetriever: class {
      retrieve = vi.fn().mockResolvedValue([
        {
          memory: { id: 'mem-2', userId: 'user-123', type: 'FACT', content: 'Safe Fact' },
          similarity: 0.9,
        },
      ]);
    },
  };
});

describe('Sprint 11: Production Hardening, Security & Performance', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  describe('API Key Authentication Policies', () => {
    it('should reject requests with 401 if authentication is enabled and token is missing', async () => {
      process.env.MNEMOS_AUTH_ENABLED = 'true';
      process.env.MNEMOS_API_KEY = 'secret-production-key';

      const req = new Request('http://localhost/api/v1/memory/ingest', {
        method: 'POST',
        body: JSON.stringify({ userId: 'user-123', content: 'Valid raw statement.' }),
      });
      const res = await ingestPOST(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.status).toBe('error');
      expect(json.error).toContain('API key is missing');
    });

    it('should reject requests with 401 if API token is invalid', async () => {
      process.env.MNEMOS_AUTH_ENABLED = 'true';
      process.env.MNEMOS_API_KEY = 'secret-production-key';

      const req = new Request('http://localhost/api/v1/memory/ingest', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer bad-token',
        },
        body: JSON.stringify({ userId: 'user-123', content: 'Valid raw statement.' }),
      });
      const res = await ingestPOST(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toContain('API key is invalid');
    });

    it('should allow requests with 200 if API token is valid (Bearer token)', async () => {
      process.env.MNEMOS_AUTH_ENABLED = 'true';
      process.env.MNEMOS_API_KEY = 'secret-production-key';

      const req = new Request('http://localhost/api/v1/memory/ingest', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-production-key',
        },
        body: JSON.stringify({ userId: 'user-123', content: 'Valid statement.' }),
      });
      const res = await ingestPOST(req);
      expect(res.status).toBe(200);
    });

    it('should allow requests with 200 if API token is valid (X-API-Key header)', async () => {
      process.env.MNEMOS_AUTH_ENABLED = 'true';
      process.env.MNEMOS_API_KEY = 'secret-production-key';

      const req = new Request('http://localhost/api/v1/memory/ingest', {
        method: 'POST',
        headers: {
          'X-API-Key': 'secret-production-key',
        },
        body: JSON.stringify({ userId: 'user-123', content: 'Valid statement.' }),
      });
      const res = await ingestPOST(req);
      expect(res.status).toBe(200);
    });

    it('should bypass authentication check if auth is disabled (local dev mode)', async () => {
      process.env.MNEMOS_AUTH_ENABLED = 'false';

      const req = new Request('http://localhost/api/v1/memory/ingest', {
        method: 'POST',
        body: JSON.stringify({ userId: 'user-123', content: 'Valid statement.' }),
      });
      const res = await ingestPOST(req);
      expect(res.status).toBe(200);
    });
  });

  describe('Rate Limiter Throttling Checks', () => {
    it('should throttle and return 429 once request bounds are exceeded', async () => {
      process.env.MNEMOS_AUTH_ENABLED = 'false';
      process.env.RATE_LIMIT_MAX_REQUESTS = '2';
      process.env.RATE_LIMIT_WINDOW_SECONDS = '60';

      const sendReq = () =>
        new Request('http://localhost/api/v1/memory/ingest', {
          method: 'POST',
          body: JSON.stringify({ userId: 'user-123', content: 'valid' }),
        });

      // Request 1
      const res1 = await ingestPOST(sendReq());
      expect(res1.status).toBe(200);

      // Request 2
      const res2 = await ingestPOST(sendReq());
      expect(res2.status).toBe(200);

      // Request 3 -> triggers throttle limit
      const res3 = await ingestPOST(sendReq());
      expect(res3.status).toBe(429);
      const json = await res3.json();
      expect(json.status).toBe('error');
      expect(json.error).toContain('Rate limit exceeded');
    });
  });

  describe('Input Validation & Safety Constraints', () => {
    it('should reject with 400 if userId length exceeds 128 characters', async () => {
      const longUserId = 'a'.repeat(129);
      const req = new Request('http://localhost/api/v1/memory/ingest', {
        method: 'POST',
        body: JSON.stringify({ userId: longUserId, content: 'Fact' }),
      });
      const res = await ingestPOST(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('userId cannot exceed 128 characters');
    });

    it('should reject with 400 if content length exceeds 10,000 characters', async () => {
      const longContent = 'a'.repeat(10001);
      const req = new Request('http://localhost/api/v1/memory/ingest', {
        method: 'POST',
        body: JSON.stringify({ userId: 'user-123', content: longContent }),
      });
      const res = await ingestPOST(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('content cannot exceed 10,000 characters');
    });

    it('should reject with 413 if content-length header exceeds 100 KB limit', async () => {
      const req = new Request('http://localhost/api/v1/memory/ingest', {
        method: 'POST',
        headers: {
          'content-length': String(101 * 1024),
        },
        body: JSON.stringify({ userId: 'user-123', content: 'Small' }),
      });
      const res = await ingestPOST(req);
      expect(res.status).toBe(413);
      const json = await res.json();
      expect(json.error).toContain('Request body size limit of 100 KB exceeded');
    });
  });

  describe('Database Error Redaction & Hardening', () => {
    it('should hide raw SQL database credentials and stack traces', async () => {
      const req = new Request('http://localhost/api/v1/memory/ingest', {
        method: 'POST',
        body: JSON.stringify({ userId: 'user-123', content: 'throw_db_error' }),
      });
      const res = await ingestPOST(req);
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.status).toBe('error');
      // Verify redaction: DB details are hidden
      expect(json.error).toBe('An error occurred during memory ingestion.');
      expect(json.error).not.toContain('pg-connection pool');
      expect(json.error).not.toContain('password error');
    });
  });
});
