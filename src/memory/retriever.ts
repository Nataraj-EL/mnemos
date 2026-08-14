import { Memory, MemoryType } from '@/core/types';
import { EmbeddingProvider } from './embedding';
import { getDbPool } from '@/db';

export interface RetrievalOptions {
  limit?: number;
  minSimilarity?: number;
  includeHistorical?: boolean;
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
    const minSimilarity = options?.minSimilarity ?? 0.0;
    const includeHistorical = options?.includeHistorical ?? false;

    // 1. Generate query embedding
    const queryEmbedding = await this.embeddingProvider.generateEmbedding(query);

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

    const result = await pool.query(sql, [
      queryEmbeddingStr,
      userId,
      minSimilarity,
      limit,
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return result.rows.map((row: any) => ({
      memory: mapRowToMemory(row),
      similarity: Number(row.similarity),
    }));
  }
}
