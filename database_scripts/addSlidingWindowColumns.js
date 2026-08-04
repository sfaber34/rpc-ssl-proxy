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
    rl.question('This will add sliding window columns to ip_table. Continue? (yes/no): ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes');
    });
  });
}

async function addSlidingWindowColumns() {
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
        AND column_name IN ('requests_previous_hour', 'origins_previous_hour')
      `;
      const checkResult = await client.query(checkQuery);
      const existingColumns = checkResult.rows.map(r => r.column_name);

      // Add requests_previous_hour if it doesn't exist
      if (!existingColumns.includes('requests_previous_hour')) {
        console.log('Adding requests_previous_hour column...');
        await client.query(`
          ALTER TABLE ip_table 
          ADD COLUMN requests_previous_hour INTEGER NOT NULL DEFAULT 0
        `);
        console.log('✅ Added requests_previous_hour column');
      } else {
        console.log('ℹ️  requests_previous_hour column already exists');
      }

      // Add origins_previous_hour if it doesn't exist
      if (!existingColumns.includes('origins_previous_hour')) {
        console.log('Adding origins_previous_hour column...');
        await client.query(`
          ALTER TABLE ip_table 
          ADD COLUMN origins_previous_hour JSONB DEFAULT '{}'::jsonb
        `);
        console.log('✅ Added origins_previous_hour column');
      } else {
        console.log('ℹ️  origins_previous_hour column already exists');
      }

      console.log('');
      console.log('✅ Sliding window columns migration complete!');
      console.log('');
      console.log('New columns:');
      console.log('  - requests_previous_hour (INTEGER): Stores last hour\'s request count');
      console.log('  - origins_previous_hour (JSONB): Stores last hour\'s per-origin counts');
      console.log('');
      console.log('How it works:');
      console.log('  At each hour boundary, current hour data shifts to previous hour,');
      console.log('  then current hour resets to 0. The rate limiter uses both values');
      console.log('  with a weighted calculation to approximate a rolling 60-minute window.');

    } finally {
      client.release();
      await pool.end();
    }
  } catch (error) {
    console.error('❌ Error adding sliding window columns:', error);
  }
}

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  addSlidingWindowColumns();
}

export { addSlidingWindowColumns };
