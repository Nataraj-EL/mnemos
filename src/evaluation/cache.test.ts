import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RetrievalCache } from '@/response/cache';
import { PgMemoryRepository } from '@/memory/repository';

vi.mock('@/db', () => {
  const mockQuery = vi.fn().mockImplementation((queryText) => {
    // If it's a delete query or update query, simulate success
    if (queryText.includes('DELETE') || queryText.includes('UPDATE')) {
      return { rows: [{ id: 'mock-id', user_id: 'user-1', userId: 'user-1', metadata: '{}' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    getDbPool: vi.fn(() => ({
      query: mockQuery,
    })),
  };
});

describe('Retrieval Cache & single-flight Coalescing - Sprint 38', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Force singleton to recreate with mock environment variables
    (RetrievalCache as unknown as { instance?: RetrievalCache }).instance = undefined;
    vi.stubEnv('RETRIEVAL_CACHE_MAX_SIZE', '3');
    vi.stubEnv('RETRIEVAL_CACHE_TTL_MS', '1000');
    RetrievalCache.getInstance().clear();
  });

  it('should enforce environment safe configuration limits and fallbacks', () => {
    // Stub negative environment variables
    vi.stubEnv('RETRIEVAL_CACHE_MAX_SIZE', '-5');
    vi.stubEnv('RETRIEVAL_CACHE_TTL_MS', '0');

    // Force singleton recreation to test constructor parsing
    (RetrievalCache as unknown as { instance?: RetrievalCache }).instance = undefined;
    const cache = RetrievalCache.getInstance();
    
    expect(cache.getMaxSize()).toBe(100); // fallback
    expect(cache.getTtlMs()).toBe(30000); // fallback
  });

  it('should execute true LRU recency eviction when cache size is exceeded', () => {
    const cache = RetrievalCache.getInstance();
    
    // Fill cache up to limit of 3
    cache.setRetrieval('user-1', 'query A', [{ val: 'A' }]);
    cache.setRetrieval('user-1', 'query B', [{ val: 'B' }]);
    cache.setRetrieval('user-1', 'query C', [{ val: 'C' }]);

    // Access "query A" to make it the most recently used (LRU)
    cache.getRetrieval('user-1', 'query A');

    // Add another item "query D", which should evict "query B" (since query A was hit, making B the oldest)
    cache.setRetrieval('user-1', 'query D', [{ val: 'D' }]);

    expect(cache.getRetrieval('user-1', 'query A')).not.toBeNull();
    expect(cache.getRetrieval('user-1', 'query B')).toBeNull(); // Evicted!
    expect(cache.getRetrieval('user-1', 'query C')).not.toBeNull();
    expect(cache.getRetrieval('user-1', 'query D')).not.toBeNull();
  });

  it('should isolate cached results by userId and never share entries across users', () => {
    const cache = RetrievalCache.getInstance();

    cache.setRetrieval('user-A', 'same query', [{ val: 'User A memories' }]);
    
    expect(cache.getRetrieval('user-B', 'same query')).toBeNull();
    expect(cache.getRetrieval('user-A', 'same query')).not.toBeNull();
  });

  it('should isolate cached results by config settings to prevent stale options match', () => {
    const cache = RetrievalCache.getInstance();

    const config1 = { limit: 5, minSimilarity: 0.2 };
    const config2 = { limit: 10, minSimilarity: 0.2 };

    cache.setRetrieval('user-1', 'query text', [{ val: '5 items' }], config1);

    expect(cache.getRetrieval('user-1', 'query text', config2)).toBeNull();
    expect(cache.getRetrieval('user-1', 'query text', config1)).not.toBeNull();
  });

  it('should coalesce identical concurrent retrieval requests into a single flight execution', async () => {
    const cache = RetrievalCache.getInstance();
    let invocationCount = 0;

    const factory = async () => {
      invocationCount++;
      return [{ val: 'Coalesced result' }];
    };

    // Run parallel calls
    const [p1, p2, p3] = await Promise.all([
      cache.getOrCreateSingleFlight('flight-key', factory),
      cache.getOrCreateSingleFlight('flight-key', factory),
      cache.getOrCreateSingleFlight('flight-key', factory)
    ]);

    expect(invocationCount).toBe(1);
    expect(p1).toEqual([{ val: 'Coalesced result' }]);
    expect(p2).toEqual([{ val: 'Coalesced result' }]);
    expect(p3).toEqual([{ val: 'Coalesced result' }]);
  });

  it('should clean up the in-flight map when single-flight promise rejects', async () => {
    const cache = RetrievalCache.getInstance();
    let callCount = 0;

    const factory = async () => {
      callCount++;
      throw new Error('Database connection timeout error');
    };

    await expect(cache.getOrCreateSingleFlight('fail-key', factory)).rejects.toThrow();
    
    // In-flight should be deleted, so running again triggers another invocation
    await expect(cache.getOrCreateSingleFlight('fail-key', factory)).rejects.toThrow();
    expect(callCount).toBe(2);
  });

  it('should invalidate cache selectively for mutating memory operations, keeping reinforcement updates isolated', async () => {
    const cache = RetrievalCache.getInstance();
    cache.setRetrieval('user-1', 'query', [{ val: 'Memory A' }]);

    const repo = new PgMemoryRepository();
    // Stub repo.get to return a memory with status 'active'
    vi.spyOn(repo, 'get').mockResolvedValue({
      id: 'mem-1',
      userId: 'user-1',
      type: 'FACT',
      content: 'Memory content',
      metadata: {
        status: 'active',
        source: 'user',
        confidence: 0.9,
        importance: 0.5,
        timestamp: new Date().toISOString()
      },
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // Simulate query reinforcement (metadata accessCount update only)
    await repo.update('mem-1', {
      metadata: {
        source: 'user',
        confidence: 0.9,
        importance: 0.5,
        timestamp: new Date().toISOString(),
        accessCount: 5,
        lastAccessedAt: new Date().toISOString()
      }
    });

    // Cache should STILL be hit (no invalidation since it was a reinforcement update)
    expect(cache.getRetrieval('user-1', 'query')).not.toBeNull();

    // Now simulate an actual data update (e.g. content changes)
    await repo.update('mem-1', {
      content: 'Updated content text'
    });

    // Cache should be INVALIDATED!
    expect(cache.getRetrieval('user-1', 'query')).toBeNull();
  });

  it('should invalidate user retrieval cache on new memory or conversation creates', async () => {
    const cache = RetrievalCache.getInstance();
    cache.setRetrieval('user-1', 'query', [{ val: 'cached items' }]);

    const memoryRepo = new PgMemoryRepository();
    await memoryRepo.create({
      userId: 'user-1',
      type: 'FACT',
      content: 'Some new memo content',
      metadata: {
        source: 'user',
        confidence: 0.9,
        importance: 0.5,
        timestamp: new Date().toISOString()
      }
    });

    expect(cache.getRetrieval('user-1', 'query')).toBeNull();
  });
});
