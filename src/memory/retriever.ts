import { Memory, MemoryType } from '@/core/types';
import { EmbeddingProvider } from './embedding';
import { getDbPool } from '@/db';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { PerformanceTracker } from '@/response/tracker';

export interface RetrievalOptions {
  limit?: number;
  minSimilarity?: number;
  includeHistorical?: boolean;
  tracker?: PerformanceTracker;
  signal?: AbortSignal;
  queryTimeout?: number;
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

    try {
      // 1. Generate query embedding
      options?.tracker?.start('prep');
      let queryEmbedding: number[];
      try {
        if (options?.signal) {
          queryEmbedding = await (this.embeddingProvider as any).generateEmbedding(query, { signal: options.signal });
        } else {
          queryEmbedding = await this.embeddingProvider.generateEmbedding(query);
        }
      } finally {
        options?.tracker?.stop('prep');
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
        } as any);
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
      return result.rows.map((row: any) => ({
        memory: mapRowToMemory(row),
        similarity: Number(row.similarity),
      }));
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
        } as any);
      } else {
        result = await pool.query(sql, params);
      }

      if (options?.signal?.aborted) {
        throw new Error('Retrieval aborted');
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return result.rows.map((row: any) => ({
        memory: mapRowToMemory(row),
        similarity: 0.5,
      }));
    }
  }
}
