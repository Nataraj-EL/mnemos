import { Conversation } from './types';
import { getDbPool } from '@/db';

export interface ConversationRepository {
  create(conv: Omit<Conversation, 'id' | 'createdAt'>): Promise<Conversation>;
  getById(id: string): Promise<Conversation | null>;
  listByUser(userId: string, limit?: number): Promise<Conversation[]>;
  delete(id: string): Promise<boolean>;
  updateSummary(id: string, summary: string | null): Promise<Conversation>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRowToConversation(row: any): Conversation {
  if (!row) return row;
  return {
    id: row.id,
    userId: row.userId,
    startedAt: row.startedAt ? new Date(row.startedAt) : undefined,
    endedAt: row.endedAt ? new Date(row.endedAt) : undefined,
    durationSeconds: row.durationSeconds !== null && row.durationSeconds !== undefined ? Number(row.durationSeconds) : undefined,
    transcript: row.transcript,
    summary: row.summary !== null && row.summary !== undefined ? String(row.summary) : undefined,
    createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
  };
}

export class PgConversationRepository implements ConversationRepository {
  async create(conv: Omit<Conversation, 'id' | 'createdAt'>): Promise<Conversation> {
    const pool = getDbPool();
    const query = `
      INSERT INTO conversations (user_id, started_at, ended_at, duration_seconds, transcript, summary, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      RETURNING id, user_id as "userId", started_at as "startedAt", ended_at as "endedAt", duration_seconds as "durationSeconds", transcript, summary, created_at as "createdAt";
    `;
    const values = [
      conv.userId,
      conv.startedAt || null,
      conv.endedAt || null,
      conv.durationSeconds !== undefined && conv.durationSeconds !== null ? conv.durationSeconds : null,
      conv.transcript,
      conv.summary || null,
    ];
    const result = await pool.query(query, values);
    return mapRowToConversation(result.rows[0]);
  }

  async getById(id: string): Promise<Conversation | null> {
    const pool = getDbPool();
    const query = `
      SELECT id, user_id as "userId", started_at as "startedAt", ended_at as "endedAt", duration_seconds as "durationSeconds", transcript, summary, created_at as "createdAt"
      FROM conversations
      WHERE id = $1;
    `;
    const result = await pool.query(query, [id]);
    if (result.rows.length === 0) {
      return null;
    }
    return mapRowToConversation(result.rows[0]);
  }

  async listByUser(userId: string, limit: number = 20): Promise<Conversation[]> {
    const pool = getDbPool();
    const query = `
      SELECT id, user_id as "userId", started_at as "startedAt", ended_at as "endedAt", duration_seconds as "durationSeconds", 
             SUBSTRING(transcript FROM 1 FOR 100) as transcript, summary, created_at as "createdAt"
      FROM conversations
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2;
    `;
    const result = await pool.query(query, [userId, limit]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return result.rows.map((row: any) => mapRowToConversation(row));
  }

  async delete(id: string): Promise<boolean> {
    const pool = getDbPool();
    const query = `
      DELETE FROM conversations
      WHERE id = $1;
    `;
    const result = await pool.query(query, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async updateSummary(id: string, summary: string | null): Promise<Conversation> {
    const pool = getDbPool();
    const query = `
      UPDATE conversations
      SET summary = $1
      WHERE id = $2
      RETURNING id, user_id as "userId", started_at as "startedAt", ended_at as "endedAt", duration_seconds as "durationSeconds", transcript, summary, created_at as "createdAt";
    `;
    const result = await pool.query(query, [summary, id]);
    if (result.rows.length === 0) {
      throw new Error(`Conversation not found for ID: ${id}`);
    }
    return mapRowToConversation(result.rows[0]);
  }
}
