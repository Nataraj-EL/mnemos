import { getDbPool, closeDbPool } from './index';
import fs from 'fs';
import path from 'path';

// Load environment variables if running directly (Next.js automatically loads them, but runner might need dotenv)
// We will rely on process.env which is already populated when we run with environment vars or npx dotenv-cli
async function runMigration() {
  console.log('Starting Sprint 3 Database Migration...');
  try {
    const sqlPath = path.join(__dirname, 'migration_sprint3.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    const pool = getDbPool();
    console.log('Executing migration SQL on database...');
    await pool.query(sql);
    console.log('Database migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await closeDbPool();
  }
}

// Execute migration
runMigration();
