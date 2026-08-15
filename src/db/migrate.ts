import { getDbPool, closeDbPool } from './index';
import fs from 'fs';
import path from 'path';

// Load environment variables if running directly (Next.js automatically loads them, but runner might need dotenv)
// We will rely on process.env which is already populated when we run with environment vars or npx dotenv-cli
async function runMigration() {
  console.log('Starting Database Migrations...');
  const pool = getDbPool();
  try {
    // 1. Sprint 3 base migration
    const s3Path = path.join(__dirname, 'migration_sprint3.sql');
    if (fs.existsSync(s3Path)) {
      console.log('Executing Sprint 3 Migration...');
      const sql3 = fs.readFileSync(s3Path, 'utf8');
      await pool.query(sql3);
    }

    // 2. Sprint 13 conversations migration
    const s13Path = path.join(__dirname, 'migration_sprint13.sql');
    if (fs.existsSync(s13Path)) {
      console.log('Executing Sprint 13 Migration...');
      const sql13 = fs.readFileSync(s13Path, 'utf8');
      await pool.query(sql13);
    }

    console.log('Database migrations completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await closeDbPool();
  }
}

// Execute migration
runMigration();
