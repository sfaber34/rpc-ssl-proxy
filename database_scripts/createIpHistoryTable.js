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
    rl.question('This will create or reset the ip_history_table. Are you sure? (yes/no): ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes');
    });
  });
}

async function createIpHistoryTable() {
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
      connectionTimeoutMillis: 10000, // 10 second timeout
    };

    console.log(`🔌 Connecting to database at ${process.env.DB_HOST}:5432...`);
    const pool = new Pool(dbConfig);
    const client = await pool.connect();
    console.log('✅ Connected to database successfully');

    try {
      // Drop the table if it exists and create a new one
      await client.query('DROP TABLE IF EXISTS ip_history_table');
      
      await client.query(`
        CREATE TABLE ip_history_table (
          id SERIAL PRIMARY KEY,
          hour_timestamp BIGINT NOT NULL,
          ip VARCHAR(45) NOT NULL,
          request_count INTEGER NOT NULL DEFAULT 0,
          origins JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Critical indexes for time-series queries
      await client.query(`
        CREATE INDEX idx_history_timestamp ON ip_history_table(hour_timestamp)
      `);
      
      await client.query(`
        CREATE INDEX idx_history_ip_timestamp ON ip_history_table(ip, hour_timestamp)
      `);
      
      await client.query(`
        CREATE INDEX idx_history_timestamp_ip ON ip_history_table(hour_timestamp, ip)
      `);

      // Unique constraint to prevent duplicate hour/ip combinations
      await client.query(`
        CREATE UNIQUE INDEX idx_history_unique_hour_ip ON ip_history_table(hour_timestamp, ip)
      `);
      
      console.log('✅ IP history table created successfully');
      console.log('Table schema:');
      console.log('  - id (SERIAL, PRIMARY KEY)');
      console.log('  - hour_timestamp (BIGINT) - UTC epoch for start of hour');
      console.log('  - ip (VARCHAR(45))');
      console.log('  - request_count (INTEGER)');
      console.log('  - origins (JSONB)');
      console.log('  - created_at (TIMESTAMP)');
      console.log('Indexes created:');
      console.log('  - idx_history_timestamp on hour_timestamp');
      console.log('  - idx_history_ip_timestamp on (ip, hour_timestamp)');
      console.log('  - idx_history_timestamp_ip on (hour_timestamp, ip)');
      console.log('  - idx_history_unique_hour_ip UNIQUE on (hour_timestamp, ip)');
      console.log('\n📊 Data retention: 30 days (automatic cleanup)');
    } finally {
      client.release();
      await pool.end();
    }
  } catch (error) {
    console.error('❌ Error creating ip_history_table:', error);
  }
}

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  createIpHistoryTable();
}

export { createIpHistoryTable };

