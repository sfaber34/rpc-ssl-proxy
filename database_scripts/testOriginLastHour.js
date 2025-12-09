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

async function testOriginLastHour() {
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
      connectionTimeoutMillis: 10000,
    };

    console.log(`🔌 Connecting to database at ${process.env.DB_HOST}:5432...`);
    const pool = new Pool(dbConfig);
    const client = await pool.connect();
    console.log('✅ Connected to database successfully\n');

    try {
      // Get the most recent hour timestamp
      const latestHourResult = await client.query(`
        SELECT MAX(hour_timestamp) as latest_hour
        FROM ip_history_table
      `);
      
      const latestHour = latestHourResult.rows[0]?.latest_hour;
      
      if (!latestHour) {
        console.log('❌ No data found in ip_history_table');
        return;
      }
      
      const hourDate = new Date(latestHour * 1000);
      console.log('📅 Testing Most Recent Hour:');
      console.log(`   Timestamp: ${latestHour}`);
      console.log(`   UTC Time: ${hourDate.toISOString()}`);
      console.log('='.repeat(100));
      
      // Get total request count for that hour (sum of all IPs)
      const totalRequestsResult = await client.query(`
        SELECT SUM(request_count)::bigint as total_requests
        FROM ip_history_table
        WHERE hour_timestamp = $1
      `, [latestHour]);
      
      const totalRequests = Number(totalRequestsResult.rows[0]?.total_requests || 0);
      console.log(`\n🔢 Total Requests (All IPs): ${totalRequests.toLocaleString()}\n`);
      
      // Get sum of all origin requests for that hour
      const originSumResult = await client.query(`
        SELECT 
          origin_key AS origin,
          SUM((origin_value)::bigint)::bigint AS request_count
        FROM 
          ip_history_table,
          jsonb_each_text(origins) AS origin_data(origin_key, origin_value)
        WHERE 
          hour_timestamp = $1
        GROUP BY 
          origin_key
        ORDER BY 
          request_count DESC
      `, [latestHour]);
      
      if (originSumResult.rows.length === 0) {
        console.log('❌ No origin data found for this hour');
        return;
      }
      
      console.log('📊 Origin Breakdown:');
      console.log('-'.repeat(100));
      console.log('Origin'.padEnd(50) + 'Requests'.padEnd(20) + '% of Total');
      console.log('-'.repeat(100));
      
      let originTotal = 0;
      
      originSumResult.rows.forEach(row => {
        const count = Number(row.request_count);
        originTotal += count;
        const percentage = totalRequests > 0 ? ((count / totalRequests) * 100).toFixed(2) : '0.00';
        console.log(
          row.origin.substring(0, 49).padEnd(50) + 
          count.toLocaleString().padEnd(20) + 
          `${percentage}%`
        );
      });
      
      console.log('='.repeat(100));
      console.log(`Total Origin Requests: ${originTotal.toLocaleString()}`);
      console.log(`Total System Requests: ${totalRequests.toLocaleString()}`);
      
      // Validation
      console.log('\n🧪 Validation:');
      console.log('-'.repeat(100));
      
      if (originTotal === totalRequests) {
        console.log('✅ PERFECT MATCH! Origin requests = System requests');
        console.log('   This means every request is properly attributed to an origin.');
      } else if (originTotal < totalRequests) {
        const diff = totalRequests - originTotal;
        const diffPercent = ((diff / totalRequests) * 100).toFixed(2);
        console.log(`⚠️  Origin requests are LESS than system requests`);
        console.log(`   Difference: ${diff.toLocaleString()} requests (${diffPercent}%)`);
        console.log(`   This is normal if some requests don't have an origin header.`);
      } else {
        const diff = originTotal - totalRequests;
        const diffPercent = ((diff / totalRequests) * 100).toFixed(2);
        console.log(`❌ PROBLEM: Origin requests are MORE than system requests!`);
        console.log(`   Difference: +${diff.toLocaleString()} requests (${diffPercent}%)`);
        console.log(`   This suggests old cumulative data is mixed in.`);
      }
      
      // Check if this looks like cumulative data
      const avgPerOrigin = originTotal / originSumResult.rows.length;
      console.log(`\n📈 Data Quality Check:`);
      console.log(`   Origins tracked: ${originSumResult.rows.length}`);
      console.log(`   Average per origin: ${avgPerOrigin.toFixed(0)} requests`);
      
      if (avgPerOrigin > 1000) {
        console.log(`   ⚠️  WARNING: Average is very high (>1000)`);
        console.log(`   This might be cumulative data instead of hourly data.`);
        console.log(`   Expected hourly average: 10-500 requests per origin`);
      } else if (avgPerOrigin < 500) {
        console.log(`   ✅ LOOKS GOOD: This appears to be hourly data (not cumulative)`);
      } else {
        console.log(`   🤔 UNCLEAR: Could be hourly or low-traffic cumulative data`);
      }
      
      // Show top 5 origins for quick inspection
      console.log(`\n🔥 Top 5 Origins:`);
      originSumResult.rows.slice(0, 5).forEach((row, index) => {
        console.log(`   ${index + 1}. ${row.origin}: ${Number(row.request_count).toLocaleString()} requests`);
      });
      
    } finally {
      client.release();
      await pool.end();
    }
  } catch (error) {
    console.error('❌ Error testing origin last hour:', error);
    console.error('Error details:', error.message);
  }
}

// Execute the function
testOriginLastHour();
