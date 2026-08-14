import { Pool } from '@neondatabase/serverless';

let pool: Pool | null = null;

/**
 * Returns the singleton database pool instance.
 */
export function getDbPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set.');
    }
    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

/**
 * Verifies that the database is reachable by executing a simple query.
 */
export async function testConnection(): Promise<boolean> {
  try {
    const db = getDbPool();
    const result = await db.query('SELECT 1 as connected;');
    return result.rows?.[0]?.connected === 1;
  } catch (error) {
    console.error('Database connection test failed:', error);
    return false;
  }
}

/**
 * Closes the connection pool. Useful for testing or clean shutdowns.
 */
export async function closeDbPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
