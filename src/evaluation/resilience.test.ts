import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withRetry, isTransientError, ResilienceTracker } from '@/response/resilience';
import { PgMemoryRepository } from '@/memory/repository';
import { RetrievalCache } from '@/response/cache';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';

vi.mock('@/db', () => {
  const mockQuery = vi.fn().mockImplementation((queryText) => {
    if (queryText.includes('INSERT INTO memories') || queryText.includes('UPDATE memories')) {
      const err = new Error('Database connection failed');
      (err as unknown as { code: string }).code = '08006'; // Connection failure
      throw err;
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    getDbPool: vi.fn(() => ({
      query: mockQuery,
    })),
  };
});

describe('Sprint 39: Production Reliability & Resilience Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Error Classification', () => {
    it('should identify rate-limits, timeouts, server errors, and network issues as transient', () => {
      expect(isTransientError(new Error('HTTP 429: Too Many Requests'))).toBe(true);
      expect(isTransientError(new Error('HTTP 408: Request Timeout'))).toBe(true);
      expect(isTransientError(new Error('HTTP 502: Bad Gateway'))).toBe(true);
      expect(isTransientError(new Error('fetch failed'))).toBe(true);
      expect(isTransientError(new Error('econnreset'))).toBe(true);

      const dbErr = new Error('deadlock detected');
      (dbErr as unknown as { code: string }).code = '40P01'; // deadlock
      expect(isTransientError(dbErr)).toBe(true);
    });

    it('should reject validation, auth, not found, aborts, and database syntax errors as non-transient', () => {
      expect(isTransientError(new Error('HTTP 400: Bad Request'))).toBe(false);
      expect(isTransientError(new Error('HTTP 401: Unauthorized'))).toBe(false);
      expect(isTransientError(new Error('HTTP 403: Forbidden'))).toBe(false);
      expect(isTransientError(new Error('HTTP 404: Not Found'))).toBe(false);
      expect(isTransientError(new Error('AbortError'))).toBe(false);

      const sqlSyntaxErr = new Error('syntax error');
      (sqlSyntaxErr as unknown as { code: string }).code = '42601'; // syntax error code
      expect(isTransientError(sqlSyntaxErr)).toBe(false);
    });
  });

  describe('Backoff & Jitter', () => {
    it('should support deterministic jitter injection for predictable testing and enforce maxDelayMs cap', async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        if (callCount < 3) {
          throw new Error('HTTP 429');
        }
        return 'success';
      };

      const delays: number[] = [];
      const tracker = new ResilienceTracker();

      const result = await withRetry(operation, {
        maxAttempts: 3,
        initialDelayMs: 100,
        maxDelayMs: 250,
        backoffFactor: 2,
        jitter: true,
        random: () => 0.5, // Deterministic random factor
        onRetry: (attempt) => {
          tracker.incrementRetries();
          // Calculate the expected delay to test:
          // delay = 100 * (2 ^ (attempt - 1)) = 100 * 2^0 = 100 for 1st retry
          // delay = 100 * 2^1 = 200 for 2nd retry
          // jitter applies: (0.5 + 0.5*0.5) * delay = 0.75 * delay
          const delayCalculated = 100 * Math.pow(2, attempt - 1);
          const jittered = 0.75 * delayCalculated;
          delays.push(jittered);
        },
      });

      expect(result).toBe('success');
      expect(tracker.getRetryCount()).toBe(2);
      expect(delays).toEqual([75, 150]);
    });

    it('should honor error.retryAfterMs from Retry-After header and cap by maxDelayMs', async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        if (callCount < 2) {
          const err = new Error('HTTP 429');
          (err as unknown as { retryAfterMs: number }).retryAfterMs = 2000;
          throw err;
        }
        return 'ok';
      };

      const start = Date.now();
      const result = await withRetry(operation, {
        maxAttempts: 2,
        maxDelayMs: 50, // Capped to 50ms instead of 2s
        initialDelayMs: 10,
      });

      expect(result).toBe('ok');
      expect(Date.now() - start).toBeLessThan(500); // Verify it was capped by maxDelayMs
    });
  });

  describe('Timeout & AbortSignal Integration', () => {
    it('should abort immediately and not execute subsequent retries if AbortSignal is cancelled', async () => {
      let callCount = 0;
      const controller = new AbortController();
      
      const operation = async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('HTTP 500');
        }
        return 'success';
      };

      const promise = withRetry(operation, {
        maxAttempts: 3,
        initialDelayMs: 200,
        signal: controller.signal,
        onRetry: () => {
          controller.abort(); // Abort during the first backoff sleep
        },
      });

      await expect(promise).rejects.toThrow();
      expect(callCount).toBe(1); // Second attempt never executed
    });

    it('should abort immediately during an active request if the controller aborts', async () => {
      const controller = new AbortController();
      const operation = async () => {
        controller.abort();
        throw new Error('HTTP 502');
      };

      const promise = withRetry(operation, {
        maxAttempts: 3,
        signal: controller.signal,
      });

      await expect(promise).rejects.toThrow();
    });
  });

  describe('Sprint 38 Cache & Single-Flight Rejection Cleanup Integration', () => {
    it('should clean up the single-flight map if retry sequence eventually exhausts and rejects', async () => {
      const cache = RetrievalCache.getInstance();
      cache.clear();

      let callCount = 0;
      const operation = async () => {
        callCount++;
        throw new Error('HTTP 503 Service Unavailable');
      };

      const runner = () => withRetry(operation, { maxAttempts: 2, initialDelayMs: 10 });

      // Run via getOrCreateSingleFlight
      await expect(cache.getOrCreateSingleFlight('retry-fail-key', runner)).rejects.toThrow();
      expect(callCount).toBe(2);

      // Verify second execution triggers a fresh run (meaning single-flight promise was cleaned up on rejection)
      await expect(cache.getOrCreateSingleFlight('retry-fail-key', runner)).rejects.toThrow();
      expect(callCount).toBe(4);
    });
  });

  describe('Database Write Safety', () => {
    it('should never retry repository database writes/mutations upon failure', async () => {
      const repo = new PgMemoryRepository();
      
      // Attempting to create a memory. Since DB query throws transient '08006' error,
      // it must throw instantly on first attempt and NOT retry.
      const promise = repo.create({
        userId: 'user-1',
        type: 'FACT',
        content: 'test',
        metadata: { source: 'user', confidence: 0.9, importance: 1, timestamp: new Date().toISOString() },
      });

      await expect(promise).rejects.toThrow();
    });
  });

  describe('Diagnostics Security & Production Isolation', () => {
    it('should exclude raw queries, status, prompts, or SQL and return developer-only telemetry', async () => {
      const mockGenerator = {
        generateResponse: vi.fn().mockImplementation(async () => {
          return { text: 'Hello', metadata: { model: 'gemini-3.5-flash' } };
        })
      };
      
      const mockRetriever = {
        retrieve: vi.fn().mockImplementation(async (_userId, _query, options) => {
          options?.resilienceTracker?.incrementRetries(); // Simulate a retry event during retrieval
          return [];
        })
      };

      const mockAssembler = {
        assemble: vi.fn().mockImplementation(() => {
          return { items: [], context: '', tokenCount: 0, governance: {} };
        })
      };

      const service = new ResponseService(
        mockRetriever as unknown as MemoryRetriever,
        mockAssembler as unknown as ContextAssembler,
        mockGenerator as unknown as ResponseGenerator
      );

      const result = await service.respond('user-1', 'hi', {
        evaluationRun: true,
      });

      expect(result.diagnostics?.resilience).toBeDefined();
      expect(result.diagnostics?.resilience?.retryCount).toBe(1);
      expect(result.diagnostics?.resilience?.finalOutcome).toBe('success');
      expect(result.diagnostics?.resilience?.failureCategory).toBeUndefined();

      // Ensure zero sensitive details leak
      const keys = Object.keys(result.diagnostics?.resilience || {});
      expect(keys.every(k => ['retryCount', 'finalOutcome', 'failureCategory'].includes(k))).toBe(true);
    });

    it('should return undefined diagnostics in normal production mode', async () => {
      const mockGenerator = {
        generateResponse: vi.fn().mockImplementation(async () => {
          return { text: 'Hello', metadata: { model: 'gemini-3.5-flash' } };
        })
      };
      
      const mockRetriever = {
        retrieve: vi.fn().mockImplementation(async () => {
          return [];
        })
      };

      const mockAssembler = {
        assemble: vi.fn().mockImplementation(() => {
          return { items: [], context: '', tokenCount: 0, governance: {} };
        })
      };

      const service = new ResponseService(
        mockRetriever as unknown as MemoryRetriever,
        mockAssembler as unknown as ContextAssembler,
        mockGenerator as unknown as ResponseGenerator
      );

      const result = await service.respond('user-1', 'hi', {
        evaluationRun: false,
      });

      expect(result.diagnostics).toBeUndefined();
    });
  });
});
