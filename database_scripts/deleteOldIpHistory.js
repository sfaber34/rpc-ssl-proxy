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

async function confirmAction(count) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(`This will delete ${count} records older than 30 days. Are you sure? (yes/no): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes');
    });
  });
}

async function deleteOldIpHistory() {
  try {
    if (!process.env.RDS_SECRET_NAME || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.DB_HOST) {
      console.error('Required environment variables are missing. Please check your .env file.');
      console.error('Required: RDS_SECRET_NAME, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, DB_HOST');
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
      // Calculate the cutoff timestamp (30 days ago)
      const cutoffQuery = `SELECT EXTRACT(EPOCH FROM NOW() - INTERVAL '30 days') as cutoff`;
      const cutoffResult = await client.query(cutoffQuery);
      const cutoffTimestamp = parseInt(cutoffResult.rows[0].cutoff);
      const cutoffDate = new Date(cutoffTimestamp * 1000).toISOString();
      
      console.log(`\n📅 Cutoff date: ${cutoffDate}`);
      console.log(`   Cutoff timestamp: ${cutoffTimestamp}`);

      // Count how many records will be deleted
      const countResult = await client.query(
        'SELECT COUNT(*) as old_count FROM ip_history_table WHERE hour_timestamp < $1',
        [cutoffTimestamp]
      );
      
      const oldCount = parseInt(countResult.rows[0].old_count);
      
      if (oldCount === 0) {
        console.log('\n✅ No old records found. Nothing to delete.');
        return;
      }

      console.log(`\n🗑️  Found ${oldCount.toLocaleString()} records older than 30 days.`);
      
      const confirmed = await confirmAction(oldCount);
      if (!confirmed) {
        console.log('Operation cancelled by user');
        return;
      }

      // Delete old records
      console.log('\n🔄 Deleting old records...');
      const deleteResult = await client.query(
        'DELETE FROM ip_history_table WHERE hour_timestamp < $1',
        [cutoffTimestamp]
      );
      
      console.log(`✅ Successfully deleted ${deleteResult.rowCount.toLocaleString()} records`);
      
      // Show remaining statistics
      const remainingResult = await client.query(`
        SELECT 
          COUNT(*) as total,
          MIN(hour_timestamp) as earliest,
          MAX(hour_timestamp) as latest
        FROM ip_history_table
      `);
      
      const remaining = remainingResult.rows[0];
      console.log('\n📊 Remaining data:');
      console.log(`   Total records: ${parseInt(remaining.total).toLocaleString()}`);
      
      if (remaining.earliest && remaining.latest) {
        const earliest = new Date(remaining.earliest * 1000).toISOString();
        const latest = new Date(remaining.latest * 1000).toISOString();
        console.log(`   Date range: ${earliest} to ${latest}`);
        
        const daysCovered = (remaining.latest - remaining.earliest) / (24 * 3600);
        console.log(`   Days covered: ${daysCovered.toFixed(1)} days`);
      }
      
    } finally {
      client.release();
      await pool.end();
    }
  } catch (error) {
    console.error('❌ Error deleting old IP history:', error);
  }
}

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  deleteOldIpHistory();
}

export { deleteOldIpHistory };

