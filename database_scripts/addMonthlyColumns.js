import { getPool } from '../utils/postgresClient.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from the project root directory
dotenv.config({ path: path.join(__dirname, '..', '.env') });

/**
 * Migration script to add monthly request tracking to ip_table
 * 
 * This script adds two new columns:
 * - requests_this_month: Counter for requests in the current month
 * - last_month_reset_timestamp: UTC epoch timestamp of last monthly reset
 * 
 * SAFE: This migration is non-destructive and doesn't lose any data
 */

async function addMonthlyColumns() {
  try {
    if (!process.env.RDS_SECRET_NAME || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.DB_HOST) {
      console.error('❌ Required environment variables are missing. Please check your .env file.');
      console.error('Required: RDS_SECRET_NAME, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, DB_HOST');
      process.exit(1);
    }

    console.log('🔄 Starting migration to add monthly columns...');
    
    const pool = await getPool();
    const client = await pool.connect();

    console.log('✅ Connected to database successfully');

    try {
      // Check if columns already exist
      const checkQuery = `
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'ip_table' 
        AND column_name IN ('requests_this_month', 'last_month_reset_timestamp')
      `;
      
      const existingColumns = await client.query(checkQuery);
      
      if (existingColumns.rows.length > 0) {
        console.log('⚠️  Monthly columns already exist. Skipping migration.');
        console.log('Existing columns:', existingColumns.rows.map(r => r.column_name));
        return;
      }

      // Add the new columns
      console.log('📝 Adding requests_this_month column...');
      await client.query(`
        ALTER TABLE ip_table 
        ADD COLUMN requests_this_month BIGINT NOT NULL DEFAULT 0
      `);
      
      console.log('📝 Adding last_month_reset_timestamp column...');
      await client.query(`
        ALTER TABLE ip_table 
        ADD COLUMN last_month_reset_timestamp BIGINT
      `);

      // Initialize all existing rows to the start of the current month (UTC)
      console.log('🕐 Initializing timestamps to start of current month (UTC)...');
      await client.query(`
        UPDATE ip_table 
        SET last_month_reset_timestamp = EXTRACT(EPOCH FROM DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC'))
      `);

      // Get the timestamp we set for verification
      const result = await client.query(`
        SELECT DISTINCT last_month_reset_timestamp 
        FROM ip_table 
        LIMIT 1
      `);
      
      if (result.rows.length > 0) {
        const monthStart = result.rows[0].last_month_reset_timestamp;
        const monthDate = new Date(monthStart * 1000);
        console.log(`✅ Initialized to: ${monthDate.toISOString()}`);
      }

      // Get count of rows updated
      const countResult = await client.query('SELECT COUNT(*) as count FROM ip_table');
      const rowCount = countResult.rows[0].count;

      console.log('\n✅ Migration completed successfully!');
      console.log('📊 Summary:');
      console.log(`  - Added column: requests_this_month (BIGINT, default 0)`);
      console.log(`  - Added column: last_month_reset_timestamp (BIGINT)`);
      console.log(`  - Initialized ${rowCount} existing rows to current month`);
      console.log('\n✨ Monthly request tracking is now enabled!');
      
    } finally {
      client.release();
      await pool.end();
    }
  } catch (error) {
    console.error('❌ Error during migration:', error);
    console.error('Error details:', error.message);
    process.exit(1);
  }
}

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  addMonthlyColumns();
}

export { addMonthlyColumns };

