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
    rl.question('This will add origins_last_hour column to ip_table. Continue? (yes/no): ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes');
    });
  });
}

async function addOriginsLastHourColumn() {
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
      // Check if column already exists
      const checkQuery = `
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'ip_table' 
        AND column_name = 'origins_last_hour'
      `;
      
      const checkResult = await client.query(checkQuery);
      
      if (checkResult.rows.length > 0) {
        console.log('⚠️  Column origins_last_hour already exists in ip_table');
        console.log('✅ No action needed - column is already present');
        return;
      }

      console.log('📝 Adding origins_last_hour column to ip_table...');
      
      // Add the new column with default empty JSONB
      await client.query(`
        ALTER TABLE ip_table 
        ADD COLUMN origins_last_hour JSONB DEFAULT '{}'::jsonb
      `);
      
      console.log('✅ Column origins_last_hour added successfully');
      
      // Verify the column was added
      const verifyResult = await client.query(checkQuery);
      
      if (verifyResult.rows.length > 0) {
        console.log('✅ Verified: origins_last_hour column exists in ip_table');
        console.log('\nColumn details:');
        console.log('  - Name: origins_last_hour');
        console.log('  - Type: JSONB');
        console.log('  - Default: {}');
        console.log('  - Purpose: Track per-origin request counts for current hour');
        console.log('\n📊 This column will:');
        console.log('  1. Accumulate origin counts during each hour');
        console.log('  2. Get reset to {} every hour (like requests_last_hour)');
        console.log('  3. Be captured in ip_history_table snapshots');
        console.log('\n⚠️  NEXT STEPS:');
        console.log('  - Restart the proxy service to start using this column');
        console.log('  - The system will auto-detect the new column');
        console.log('  - Historical data in ip_history_table will still show cumulative origins');
        console.log('  - New snapshots will show hourly origins (correct for time-series)');
      } else {
        console.error('❌ Error: Column was not created successfully');
      }
      
    } finally {
      client.release();
      await pool.end();
    }
  } catch (error) {
    console.error('❌ Error adding origins_last_hour column:', error);
    console.error('Error details:', error.message);
  }
}

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  addOriginsLastHourColumn();
}

export { addOriginsLastHourColumn };
