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

async function listIpHistoryTable() {
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
      const countResult = await client.query('SELECT COUNT(*) as total FROM ip_history_table');
      const totalRecords = parseInt(countResult.rows[0].total);

      // Get unique hours and IPs
      const statsResult = await client.query(`
        SELECT 
          COUNT(DISTINCT hour_timestamp) as unique_hours,
          COUNT(DISTINCT ip) as unique_ips,
          MIN(hour_timestamp) as earliest_hour,
          MAX(hour_timestamp) as latest_hour
        FROM ip_history_table
      `);
      
      const stats = statsResult.rows[0];

      // Query recent records (last 24 hours)
      const result = await client.query(`
        SELECT 
          hour_timestamp,
          ip, 
          request_count,
          origins,
          created_at
        FROM ip_history_table 
        WHERE hour_timestamp >= EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours')
        ORDER BY hour_timestamp DESC, request_count DESC
        LIMIT 100
      `);
      
      console.log('\n📊 IP History Table Statistics:');
      console.log('='.repeat(120));
      console.log(`Total Records: ${totalRecords.toLocaleString()}`);
      console.log(`Unique Hours: ${stats.unique_hours || 0}`);
      console.log(`Unique IPs: ${stats.unique_ips || 0}`);
      
      if (stats.earliest_hour && stats.latest_hour) {
        const earliest = new Date(stats.earliest_hour * 1000).toISOString();
        const latest = new Date(stats.latest_hour * 1000).toISOString();
        console.log(`Data Range: ${earliest} to ${latest}`);
        
        const daysCovered = (stats.latest_hour - stats.earliest_hour) / (24 * 3600);
        console.log(`Days Covered: ${daysCovered.toFixed(1)} days`);
      }
      
      console.log('\n🔍 Recent History (Last 24 Hours, Top 100):');
      console.log('='.repeat(120));
      
      if (result.rows.length === 0) {
        console.log('No records found in the last 24 hours.');
      } else {
        // Print column headers
        console.log('Hour (UTC)'.padEnd(22) + 
                    'IP Address'.padEnd(20) + 
                    'Requests'.padEnd(12) + 
                    'Origins'.padEnd(40) +
                    'Logged At');
        console.log('-'.repeat(120));
        
        // Print each row
        result.rows.forEach(row => {
          const hourTime = new Date(row.hour_timestamp * 1000).toISOString().substring(0, 13) + ':00:00';
          const createdAt = row.created_at ? new Date(row.created_at).toISOString().substring(0, 19) : 'N/A';
          const originsCount = Object.keys(row.origins || {}).length;
          const originsPreview = originsCount > 0 
            ? `${originsCount} origin(s): ${Object.keys(row.origins).slice(0, 3).join(', ')}${originsCount > 3 ? '...' : ''}`
            : 'No origins';
          
          console.log(
            hourTime.padEnd(22) + 
            row.ip.padEnd(20) + 
            row.request_count.toString().padEnd(12) + 
            originsPreview.substring(0, 39).padEnd(40) +
            createdAt
          );
        });
        
        // Calculate totals for displayed records
        const totalRequests = result.rows.reduce((sum, row) => sum + Number(row.request_count), 0);
        
        console.log('='.repeat(120));
        console.log(`📈 Last 24 Hours Summary (displayed records):`);
        console.log(`   Records shown: ${result.rows.length}`);
        console.log(`   Total requests: ${totalRequests.toLocaleString()}`);
        
        // Show top 5 IPs by request count in last 24 hours
        console.log('\n🔥 Top 5 Most Active IPs (Last 24 Hours):');
        const ipTotals = {};
        result.rows.forEach(row => {
          if (!ipTotals[row.ip]) ipTotals[row.ip] = 0;
          ipTotals[row.ip] += row.request_count;
        });
        
        const topIps = Object.entries(ipTotals)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);
        
        topIps.forEach(([ip, count], index) => {
          console.log(`   ${index + 1}. ${ip}: ${count.toLocaleString()} requests`);
        });
      }
      
      // Check for old data that should be cleaned up
      const oldDataResult = await client.query(`
        SELECT COUNT(*) as old_count
        FROM ip_history_table
        WHERE hour_timestamp < EXTRACT(EPOCH FROM NOW() - INTERVAL '30 days')
      `);
      
      const oldCount = parseInt(oldDataResult.rows[0].old_count);
      if (oldCount > 0) {
        console.log(`\n⚠️  Warning: ${oldCount} records are older than 30 days and should be cleaned up.`);
        console.log('   Run: node database_scripts/deleteOldIpHistory.js');
      }
      
    } finally {
      client.release();
      await pool.end();
    }
  } catch (error) {
    console.error('❌ Error listing ip_history_table:', error);
  }
}

// Execute the function
listIpHistoryTable();

