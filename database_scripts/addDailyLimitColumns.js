import pkg from 'pg';
const { Pool } = pkg;
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import path from 'path';
import readline from 'readline';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from the project root directory
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Path to the RDS CA bundle
const RDS_CA_BUNDLE_PATH = '/home/ubuntu/rpc-ssl-proxy/rds-ca-bundle.pem';

async function confirmAction() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('This will add daily limit columns to ip_table. Continue? (yes/no): ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes');
    });
  });
}

async function addDailyLimitColumns() {
  try {
    if (!process.env.RDS_SECRET_NAME || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.DB_HOST) {
      console.error('Required environment variables are missing. Please check your .env file.');
      console.error('Required: RDS_SECRET_NAME, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, DB_HOST');
      return;
    }

    const confirmed = await confirmAction();
    if (!confirmed) {
      console.log('Operation cancelled by user');
      return;
    }

    console.log('🔐 Fetching database credentials from AWS Secrets Manager...');
    const secret_name = process.env.RDS_SECRET_NAME;

    const secretsClient = new SecretsManagerClient({ 
      region: "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      }
    });

    const command = new GetSecretValueCommand({
      SecretId: secret_name,
      VersionStage: "AWSCURRENT",
    });

    const data = await secretsClient.send(command);
    const secret = JSON.parse(data.SecretString);
    console.log('✅ Successfully retrieved database credentials');

    const dbConfig = {
      host: process.env.DB_HOST,
      user: secret.username,
      password: secret.password,
      database: secret.dbname || 'postgres',
      port: 5432,
      ssl: {
        rejectUnauthorized: true,
        ca: fs.readFileSync(RDS_CA_BUNDLE_PATH).toString()
      },
      connectionTimeoutMillis: 10000,
    };

    console.log(`🔌 Connecting to database at ${process.env.DB_HOST}:5432...`);
    const pool = new Pool(dbConfig);
    const client = await pool.connect();
    console.log('✅ Connected to database successfully');

    try {
      // Check if columns already exist
      const checkQuery = `
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'ip_table' 
        AND column_name IN ('requests_today', 'origins_today', 'last_day_reset_timestamp')
      `;
      const checkResult = await client.query(checkQuery);
      const existingColumns = checkResult.rows.map(r => r.column_name);

      // Add requests_today if it doesn't exist
      if (!existingColumns.includes('requests_today')) {
        console.log('Adding requests_today column...');
        await client.query(`
          ALTER TABLE ip_table 
          ADD COLUMN requests_today BIGINT NOT NULL DEFAULT 0
        `);
        console.log('✅ Added requests_today column');
      } else {
        console.log('ℹ️  requests_today column already exists');
      }

      // Add origins_today if it doesn't exist
      if (!existingColumns.includes('origins_today')) {
        console.log('Adding origins_today column...');
        await client.query(`
          ALTER TABLE ip_table 
          ADD COLUMN origins_today JSONB DEFAULT '{}'::jsonb
        `);
        console.log('✅ Added origins_today column');
      } else {
        console.log('ℹ️  origins_today column already exists');
      }

      // Add last_day_reset_timestamp if it doesn't exist
      if (!existingColumns.includes('last_day_reset_timestamp')) {
        console.log('Adding last_day_reset_timestamp column...');
        await client.query(`
          ALTER TABLE ip_table 
          ADD COLUMN last_day_reset_timestamp BIGINT
        `);
        console.log('✅ Added last_day_reset_timestamp column');
        
        // Initialize with start of current UTC day for existing rows
        const startOfTodayUTC = Math.floor(Date.now() / 86400000) * 86400; // seconds
        await client.query(`
          UPDATE ip_table 
          SET last_day_reset_timestamp = $1 
          WHERE last_day_reset_timestamp IS NULL
        `, [startOfTodayUTC]);
        console.log('✅ Initialized last_day_reset_timestamp for existing rows');
      } else {
        console.log('ℹ️  last_day_reset_timestamp column already exists');
      }

      console.log('');
      console.log('✅ Daily limit columns migration complete!');
      console.log('');
      console.log('New columns:');
      console.log('  - requests_today (BIGINT): Today\'s total request count');
      console.log('  - origins_today (JSONB): Today\'s per-origin request counts');
      console.log('  - last_day_reset_timestamp (BIGINT): When daily counters were last reset');
      console.log('');
      console.log('How it works:');
      console.log('  At midnight UTC, daily counters reset to 0.');
      console.log('  Daily limits provide a secondary cap that prevents users from');
      console.log('  gaming hourly limits by spreading requests across hour boundaries.');

    } finally {
      client.release();
      await pool.end();
    }
  } catch (error) {
    console.error('❌ Error adding daily limit columns:', error);
  }
}

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  addDailyLimitColumns();
}

export { addDailyLimitColumns };
