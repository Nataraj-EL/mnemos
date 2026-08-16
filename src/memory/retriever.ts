import { Memory, MemoryType } from '@/core/types';
import { EmbeddingProvider } from './embedding';
import { getDbPool } from '@/db';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { PerformanceTracker } from '@/response/tracker';
import { RetrievalCache } from '@/response/cache';

export interface RetrievalOptions {
  limit?: number;
  minSimilarity?: number;
  includeHistorical?: boolean;
  tracker?: PerformanceTracker;
  signal?: AbortSignal;
  queryTimeout?: number;
  evaluationRun?: boolean;
  bypassCache?: boolean;
  cacheHitTracker?: { hit: boolean };
}

export interface RetrievalResult {
  memory: Memory;
  similarity: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseEmbedding(val: any): number[] | undefined {
  if (typeof val === 'string') {
    return val
      .replace(/[\[\]]/g, '')
      .split(',')
      .map(Number);
  }
  if (Array.isArray(val)) {
    return val.map(Number);
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRowToMemory(row: any): Memory {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type as MemoryType,
    content: row.content,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
    embedding: parseEmbedding(row.embedding),
    createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
    updatedAt: row.updatedAt ? new Date(row.updatedAt) : new Date(),
  };
}

export class MemoryRetriever {
  constructor(private embeddingProvider: EmbeddingProvider) {}

  /**
   * Performs semantic search using pgvector on the Neon database.
   * Matches memories for a specific user, that are active, have vectors, and cross the similarity threshold.
   * Falls back to lexical word match if the embedding provider fails.
   */
  async retrieve(
    userId: string,
    query: string,
    options?: RetrievalOptions
  ): Promise<RetrievalResult[]> {
    if (!userId || !userId.trim()) {
      throw new Error('User ID is required.');
    }
    if (!query || !query.trim()) {
      throw new Error('Query text is required.');
    }

    const limit = options?.limit ?? 5;
    const minSimilarity = options?.minSimilarity ?? RETRIEVAL_SETTINGS.minSimilarity;
    const includeHistorical = options?.includeHistorical ?? false;

    const bypass = options?.evaluationRun === true || options?.bypassCache === true;
    if (bypass) {
      if (options?.cacheHitTracker) {
        options.cacheHitTracker.hit = false;
      }
      const execution = await this.executeRetrieval(userId, query, limit, minSimilarity, includeHistorical, options);
      return execution.results;
    }

    const cache = RetrievalCache.getInstance();
    const config = { limit, minSimilarity, includeHistorical };
    const cached = cache.getRetrieval<RetrievalResult>(userId, query, config);

    if (cached !== null && cached.length > 0) {
      if (options?.cacheHitTracker) {
        options.cacheHitTracker.hit = true;
      }
      return cached;
    }

    if (options?.cacheHitTracker) {
      options.cacheHitTracker.hit = false;
    }

    // Coalesce the retrieval execution promise
    const key = `${userId}:${cache.normalizeQuery(query)}:${cache.hashConfig(config)}`;
    const execution = await cache.getOrCreateSingleFlight(key, async () => {
      const doubleCheck = cache.getRetrieval<RetrievalResult>(userId, query, config);
      if (doubleCheck !== null && doubleCheck.length > 0) {
        return { results: doubleCheck, isFallback: false };
      }
      return this.executeRetrieval(userId, query, limit, minSimilarity, includeHistorical, options);
    });

    // Cache successful, non-empty, non-fallback retrieval results
    if (execution.results && execution.results.length > 0 && !execution.isFallback) {
      cache.setRetrieval(userId, query, execution.results, config);
    }

    return execution.results;
  }

  private async executeRetrieval(
    userId: string,
    query: string,
    limit: number,
    minSimilarity: number,
    includeHistorical: boolean,
    options?: RetrievalOptions
  ): Promise<{ results: RetrievalResult[]; isFallback: boolean }> {
    const bypass = options?.evaluationRun === true || options?.bypassCache === true;
    const cache = RetrievalCache.getInstance();

    try {
      // 1. Generate query embedding
      let queryEmbedding: number[] | null = null;
      if (!bypass) {
        queryEmbedding = cache.getEmbedding(userId, query);
      }

      if (!queryEmbedding) {
        const embedFactory = async () => {
          if (!bypass) {
            const innerCheck = cache.getEmbedding(userId, query);
            if (innerCheck) return innerCheck;
          }

          options?.tracker?.start('prep');
          try {
            let vector: number[];
            if (options?.signal) {
              const provider = this.embeddingProvider as unknown as {
                generateEmbedding(text: string, opts?: { signal?: AbortSignal }): Promise<number[]>;
              };
              vector = await provider.generateEmbedding(query, { signal: options.signal });
            } else {
              vector = await this.embeddingProvider.generateEmbedding(query);
            }
            if (!bypass && vector && vector.length > 0) {
              cache.setEmbedding(userId, query, vector);
            }
            return vector;
          } finally {
            options?.tracker?.stop('prep');
          }
        };

        if (bypass) {
          queryEmbedding = await embedFactory();
        } else {
          const embedKey = `embed:${userId}:${cache.normalizeQuery(query)}`;
          queryEmbedding = await cache.getOrCreateSingleFlight(embedKey, embedFactory);
        }
      }

      if (options?.signal?.aborted) {
        throw new Error('Retrieval aborted');
      }

      // 2. Query Neon PostgreSQL database
      const pool = getDbPool();
      const queryEmbeddingStr = `[${queryEmbedding.join(',')}]`;

      let sql = `
        SELECT id, user_id as "userId", type, content, metadata, embedding, created_at as "createdAt", updated_at as "updatedAt",
               (1 - (embedding <=> $1::vector)) as similarity
        FROM memories
        WHERE user_id = $2
      `;

      // Exclude superseded unless includeHistorical is explicitly set
      if (!includeHistorical) {
        sql += ` AND (metadata->>'status' IS NULL OR metadata->>'status' != 'superseded')`;
      }

      sql += `
          AND embedding IS NOT NULL
          AND (1 - (embedding <=> $1::vector)) >= $3
        ORDER BY embedding <=> $1::vector ASC
        LIMIT $4;
      `;

      let result;
      if (options?.queryTimeout !== undefined) {
        result = await pool.query({
          text: sql,
          values: [queryEmbeddingStr, userId, minSimilarity, limit],
          query_timeout: options.queryTimeout,
        } as unknown as Parameters<typeof pool.query>[0]);
      } else {
        result = await pool.query(sql, [
          queryEmbeddingStr,
          userId,
          minSimilarity,
          limit,
        ]);
      }

      if (options?.signal?.aborted) {
        throw new Error('Retrieval aborted');
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = result.rows.map((row: any) => ({
        memory: mapRowToMemory(row),
        similarity: Number(row.similarity),
      }));

      return { results: rows, isFallback: false };
    } catch (embedErr) {
      if (options?.signal?.aborted || (embedErr instanceof Error && embedErr.message.includes('aborted'))) {
        throw embedErr;
      }
      console.warn('Embedding provider failed, falling back to lexical search:', embedErr);

      // 3. Fallback: query PostgreSQL lexically
      const pool = getDbPool();
      const words = query.split(/\s+/).filter(w => w.length > 2).map(w => `%${w}%`);

      let sql = `
        SELECT id, user_id as "userId", type, content, metadata, embedding, created_at as "createdAt", updated_at as "updatedAt",
               0.5 as similarity
        FROM memories
        WHERE user_id = $1
      `;

      if (!includeHistorical) {
        sql += ` AND (metadata->>'status' IS NULL OR metadata->>'status' != 'superseded')`;
      }

      if (words.length > 0) {
        sql += ` AND (${words.map((_, idx) => `content ILIKE $${idx + 2}`).join(' OR ')})`;
      }

      sql += `
        ORDER BY created_at DESC
        LIMIT $${words.length + 2};
      `;

      const params = [userId, ...words, limit];
      let result;
      if (options?.queryTimeout !== undefined) {
        result = await pool.query({
          text: sql,
          values: params,
          query_timeout: options.queryTimeout,
        } as unknown as Parameters<typeof pool.query>[0]);
      } else {
        result = await pool.query(sql, params);
      }

      if (options?.signal?.aborted) {
        throw new Error('Retrieval aborted');
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = result.rows.map((row: any) => ({
        memory: mapRowToMemory(row),
        similarity: 0.5,
      }));

      return { results: rows, isFallback: true };
    }
  }
}
