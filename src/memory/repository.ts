import { Memory, MemoryType } from '@/core/types';
import { getDbPool } from '@/db';

export interface MemoryRepository {
  create(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>): Promise<Memory>;
  get(id: string): Promise<Memory | null>;
  update(id: string, updates: Partial<Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Memory>;
  delete(id: string): Promise<boolean>;
  list(filter: { userId?: string; type?: MemoryType }): Promise<Memory[]>;
}

export class PgMemoryRepository implements MemoryRepository {
  async create(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>): Promise<Memory> {
    const pool = getDbPool();
    const query = `
      INSERT INTO memories (user_id, type, content, metadata, created_at, updated_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING id, user_id as "userId", type, content, metadata, created_at as "createdAt", updated_at as "updatedAt";
    `;
    const values = [
      memory.userId,
      memory.type,
      memory.content,
      JSON.stringify(memory.metadata || {}),
    ];
    const result = await pool.query(query, values);
    return result.rows[0];
  }

  async get(id: string): Promise<Memory | null> {
    const pool = getDbPool();
    const query = `
      SELECT id, user_id as "userId", type, content, metadata, created_at as "createdAt", updated_at as "updatedAt"
      FROM memories
      WHERE id = $1;
    `;
    const result = await pool.query(query, [id]);
    if (result.rows.length === 0) {
      return null;
    }
    return result.rows[0];
  }

  async update(id: string, updates: Partial<Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Memory> {
    const pool = getDbPool();
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.userId !== undefined) {
      setClauses.push(`user_id = $${paramIndex++}`);
      values.push(updates.userId);
    }
    if (updates.type !== undefined) {
      setClauses.push(`type = $${paramIndex++}`);
      values.push(updates.type);
    }
    if (updates.content !== undefined) {
      setClauses.push(`content = $${paramIndex++}`);
      values.push(updates.content);
    }
    if (updates.metadata !== undefined) {
      setClauses.push(`metadata = $${paramIndex++}`);
      values.push(JSON.stringify(updates.metadata));
    }

    if (setClauses.length === 0) {
      const current = await this.get(id);
      if (!current) {
        throw new Error(`Memory with ID ${id} not found.`);
      }
      return current;
    }

    setClauses.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id); // for the WHERE clause

    const query = `
      UPDATE memories
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id, user_id as "userId", type, content, metadata, created_at as "createdAt", updated_at as "updatedAt";
    `;

    const result = await pool.query(query, values);
    if (result.rows.length === 0) {
      throw new Error(`Memory with ID ${id} not found.`);
    }
    return result.rows[0];
  }

  async delete(id: string): Promise<boolean> {
    const pool = getDbPool();
    const query = `
      DELETE FROM memories
      WHERE id = $1;
    `;
    const result = await pool.query(query, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async list(filter: { userId?: string; type?: MemoryType }): Promise<Memory[]> {
    const pool = getDbPool();
    const clauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filter.userId) {
      clauses.push(`user_id = $${paramIndex++}`);
      values.push(filter.userId);
    }
    if (filter.type) {
      clauses.push(`type = $${paramIndex++}`);
      values.push(filter.type);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const query = `
      SELECT id, user_id as "userId", type, content, metadata, created_at as "createdAt", updated_at as "updatedAt"
      FROM memories
      ${whereClause}
      ORDER BY created_at DESC;
    `;

    const result = await pool.query(query, values);
    return result.rows;
  }
}
