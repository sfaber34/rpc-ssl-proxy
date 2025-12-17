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

      // Check which columns exist
      const columnCheck = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'ip_table' 
        AND column_name IN ('origins_last_hour', 'requests_previous_hour', 'origins_previous_hour', 'requests_today', 'origins_today')
      `);
      const existingColumns = columnCheck.rows.map(r => r.column_name);
      const hasOriginsLastHour = existingColumns.includes('origins_last_hour');
      const hasSlidingWindow = existingColumns.includes('requests_previous_hour');
      const hasDailyLimit = existingColumns.includes('requests_today');
      
      // Build dynamic column list
      let selectColumns = 'ip, requests_total, requests_last_hour, requests_this_month, origins';
      if (hasOriginsLastHour) selectColumns += ', origins_last_hour';
      if (hasSlidingWindow) selectColumns += ', requests_previous_hour, origins_previous_hour';
      if (hasDailyLimit) selectColumns += ', requests_today, origins_today';
      
      const result = await client.query(`
        SELECT ${selectColumns}
        FROM ip_table 
        ORDER BY requests_total DESC
        LIMIT 100
      `);
      
      console.log('\n🔍 IP Table Contents (Top 100 by requests_total):');
      console.log('='.repeat(180));
      
      // Show feature detection
      console.log('Features detected:');
      console.log(`  ${hasOriginsLastHour ? '✅' : '❌'} origins_last_hour (hourly origin tracking)`);
      console.log(`  ${hasSlidingWindow ? '✅' : '❌'} sliding window columns (requests_previous_hour, origins_previous_hour)`);
      console.log(`  ${hasDailyLimit ? '✅' : '❌'} daily limit columns (requests_today, origins_today)`);
      console.log('');
      
      if (result.rows.length === 0) {
        console.log('No records found in the ip_table.');
      } else {
        // Print column headers
        let header = 'IP Address'.padEnd(18) + 
                    'Total'.padEnd(10) + 
                    'Hour'.padEnd(8) + 
                    'Prev Hr'.padEnd(10) +
                    'Today'.padEnd(10) +
                    'Month'.padEnd(10) + 
                    'Origins';
        console.log(header);
        console.log('-'.repeat(180));
        
        // Print each row
        result.rows.forEach(row => {
          const prevHour = hasSlidingWindow ? (row.requests_previous_hour || 0) : '-';
          const today = hasDailyLimit ? (row.requests_today || 0) : '-';
          
          // Format origins summary
          const originsCount = Object.keys(row.origins || {}).length;
          const originsPreview = originsCount > 0 
            ? `${originsCount} total: ${Object.entries(row.origins).slice(0, 2).map(([k,v]) => `${k}(${v})`).join(', ')}${originsCount > 2 ? '...' : ''}`
            : 'None';
          
          let displayLine = row.ip.padEnd(18) + 
            row.requests_total.toString().padEnd(10) + 
            row.requests_last_hour.toString().padEnd(8) + 
            prevHour.toString().padEnd(10) +
            today.toString().padEnd(10) +
            (row.requests_this_month || 0).toString().padEnd(10) + 
            originsPreview;
          
          console.log(displayLine);
          
          // Show hourly origins on second line if they exist
          if (hasOriginsLastHour && row.origins_last_hour && Object.keys(row.origins_last_hour).length > 0) {
            const hourlyOrigins = Object.entries(row.origins_last_hour).slice(0, 3).map(([k,v]) => `${k}(${v})`).join(', ');
            console.log(''.padEnd(18) + `↳ This hour: ${hourlyOrigins}${Object.keys(row.origins_last_hour).length > 3 ? '...' : ''}`);
          }
          
          // Show previous hour origins if sliding window exists
          if (hasSlidingWindow && row.origins_previous_hour && Object.keys(row.origins_previous_hour).length > 0) {
            const prevOrigins = Object.entries(row.origins_previous_hour).slice(0, 3).map(([k,v]) => `${k}(${v})`).join(', ');
            console.log(''.padEnd(18) + `↳ Prev hour: ${prevOrigins}${Object.keys(row.origins_previous_hour).length > 3 ? '...' : ''}`);
          }
          
          // Show today's origins if daily limit exists
          if (hasDailyLimit && row.origins_today && Object.keys(row.origins_today).length > 0) {
            const todayOrigins = Object.entries(row.origins_today).slice(0, 3).map(([k,v]) => `${k}(${v})`).join(', ');
            console.log(''.padEnd(18) + `↳ Today: ${todayOrigins}${Object.keys(row.origins_today).length > 3 ? '...' : ''}`);
          }
        });
        
        // Calculate and print totals
        const totalRequests = result.rows.reduce((sum, row) => sum + Number(row.requests_total), 0);
        const totalLastHour = result.rows.reduce((sum, row) => sum + Number(row.requests_last_hour), 0);
        const totalPrevHour = hasSlidingWindow 
          ? result.rows.reduce((sum, row) => sum + Number(row.requests_previous_hour || 0), 0) 
          : null;
        const totalToday = hasDailyLimit 
          ? result.rows.reduce((sum, row) => sum + Number(row.requests_today || 0), 0) 
          : null;
        const totalThisMonth = result.rows.reduce((sum, row) => sum + Number(row.requests_this_month || 0), 0);
        
        console.log('='.repeat(180));
        console.log(`📊 Statistics:`);
        console.log(`   Total IPs in database: ${totalIps}`);
        console.log(`   IPs shown: ${result.rows.length}`);
        console.log(`   Total requests (all time): ${totalRequests.toLocaleString()}`);
        console.log(`   Total requests (this hour): ${totalLastHour.toLocaleString()}`);
        if (totalPrevHour !== null) {
          console.log(`   Total requests (prev hour): ${totalPrevHour.toLocaleString()}`);
        }
        if (totalToday !== null) {
          console.log(`   Total requests (today): ${totalToday.toLocaleString()}`);
        }
        console.log(`   Total requests (this month): ${totalThisMonth.toLocaleString()}`);
        
        // Show top 5 IPs by last hour activity
        console.log('\n🔥 Top 5 Most Active IPs (This Hour):');
        const topLastHour = [...result.rows]
          .sort((a, b) => b.requests_last_hour - a.requests_last_hour)
          .slice(0, 5);
        
        topLastHour.forEach((row, index) => {
          const prevHour = hasSlidingWindow ? ` (prev: ${row.requests_previous_hour || 0})` : '';
          console.log(`   ${index + 1}. ${row.ip}: ${row.requests_last_hour} requests${prevHour}`);
        });
        
        // Show sliding window effective counts if available
        if (hasSlidingWindow) {
          console.log('\n📈 Sliding Window Effective Counts (approx):');
          const now = new Date();
          const minutesIntoHour = now.getMinutes();
          const weight = 1 - (minutesIntoHour / 60);
          console.log(`   (Current time: ${minutesIntoHour} min into hour, prev hour weight: ${(weight * 100).toFixed(1)}%)`);
          
          const withEffective = result.rows.map(row => ({
            ip: row.ip,
            effective: row.requests_last_hour + ((row.requests_previous_hour || 0) * weight)
          })).sort((a, b) => b.effective - a.effective).slice(0, 5);
          
          withEffective.forEach((item, index) => {
            console.log(`   ${index + 1}. ${item.ip}: ~${Math.round(item.effective)} effective requests`);
          });
        }
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

