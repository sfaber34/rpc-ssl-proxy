import pkg from 'pg';
const { Pool } = pkg;
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import path from 'path';
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

async function listIpTable() {
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
      // Get table statistics
      const countResult = await client.query('SELECT COUNT(*) as total FROM ip_table');
      const totalIps = parseInt(countResult.rows[0].total);

      // Query to select all records from the ip_table, ordered by requests_total descending
      const result = await client.query(`
        SELECT 
          ip, 
          requests_total, 
          requests_last_hour, 
          last_reset_timestamp,
          origins,
          updated_at
        FROM ip_table 
        ORDER BY requests_total DESC
        LIMIT 100
      `);
      
      console.log('\n🔍 IP Table Contents (Top 100 by requests_total):');
      console.log('='.repeat(120));
      
      if (result.rows.length === 0) {
        console.log('No records found in the ip_table.');
      } else {
        // Print column headers
        console.log('IP Address'.padEnd(20) + 
                    'Total Reqs'.padEnd(15) + 
                    'Last Hour'.padEnd(15) + 
                    'Last Reset'.padEnd(25) + 
                    'Updated At'.padEnd(25) +
                    'Origins');
        console.log('-'.repeat(120));
        
        // Print each row
        result.rows.forEach(row => {
          const lastReset = new Date(row.last_reset_timestamp * 1000).toISOString();
          const updatedAt = row.updated_at ? new Date(row.updated_at).toISOString() : 'N/A';
          const originsCount = Object.keys(row.origins || {}).length;
          const originsPreview = originsCount > 0 
            ? `${originsCount} origin(s): ${Object.keys(row.origins).slice(0, 2).join(', ')}${originsCount > 2 ? '...' : ''}`
            : 'No origins';
          
          console.log(
            row.ip.padEnd(20) + 
            row.requests_total.toString().padEnd(15) + 
            row.requests_last_hour.toString().padEnd(15) + 
            lastReset.substring(0, 19).padEnd(25) + 
            updatedAt.substring(0, 19).padEnd(25) +
            originsPreview
          );
        });
        
        // Calculate and print totals
        const totalRequests = result.rows.reduce((sum, row) => sum + Number(row.requests_total), 0);
        const totalLastHour = result.rows.reduce((sum, row) => sum + Number(row.requests_last_hour), 0);
        
        console.log('='.repeat(120));
        console.log(`📊 Statistics:`);
        console.log(`   Total IPs in database: ${totalIps}`);
        console.log(`   IPs shown: ${result.rows.length}`);
        console.log(`   Total requests (shown IPs): ${totalRequests.toLocaleString()}`);
        console.log(`   Total requests last hour (shown IPs): ${totalLastHour.toLocaleString()}`);
        
        // Show top 5 IPs by last hour activity
        console.log('\n🔥 Top 5 Most Active IPs (Last Hour):');
        const topLastHour = [...result.rows]
          .sort((a, b) => b.requests_last_hour - a.requests_last_hour)
          .slice(0, 5);
        
        topLastHour.forEach((row, index) => {
          console.log(`   ${index + 1}. ${row.ip}: ${row.requests_last_hour} requests`);
        });
      }
    } finally {
      client.release();
      await pool.end();
    }
  } catch (error) {
    console.error('❌ Error listing ip_table:', error);
  }
}

// Execute the function
listIpTable();

