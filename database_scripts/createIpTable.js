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
    rl.question('This will create or reset the ip_table. Are you sure? (yes/no): ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes');
    });
  });
}

async function createIpTable() {
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
      await client.query('DROP TABLE IF EXISTS ip_table');
      
      await client.query(`
        CREATE TABLE ip_table (
          ip VARCHAR(45) PRIMARY KEY,
          requests_total BIGINT NOT NULL DEFAULT 0,
          requests_last_hour INTEGER NOT NULL DEFAULT 0,
          requests_this_month BIGINT NOT NULL DEFAULT 0,
          last_reset_timestamp BIGINT NOT NULL,
          last_month_reset_timestamp BIGINT,
          origins JSONB DEFAULT '{}'::jsonb,
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Create index for efficient timestamp queries
      await client.query(`
        CREATE INDEX idx_ip_last_reset ON ip_table(last_reset_timestamp)
      `);

      // Create index for updated_at for monitoring
      await client.query(`
        CREATE INDEX idx_ip_updated_at ON ip_table(updated_at)
      `);
      
      console.log('✅ IP table created successfully');
      console.log('Table schema:');
      console.log('  - ip (VARCHAR(45), PRIMARY KEY)');
      console.log('  - requests_total (BIGINT)');
      console.log('  - requests_last_hour (INTEGER)');
      console.log('  - requests_this_month (BIGINT)');
      console.log('  - last_reset_timestamp (BIGINT)');
      console.log('  - last_month_reset_timestamp (BIGINT)');
      console.log('  - origins (JSONB)');
      console.log('  - updated_at (TIMESTAMP)');
      console.log('Indexes created:');
      console.log('  - idx_ip_last_reset on last_reset_timestamp');
      console.log('  - idx_ip_updated_at on updated_at');
    } finally {
      client.release();
      await pool.end();
    }
  } catch (error) {
    console.error('❌ Error creating ip_table:', error);
  }
}

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  createIpTable();
}

export { createIpTable };

