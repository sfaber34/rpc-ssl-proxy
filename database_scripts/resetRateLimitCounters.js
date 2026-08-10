/**
 * Reset the rate limit enforcement counters in ip_table.
 *
 * Why this exists: a failing Firebase write used to make processBackgroundTasks restore
 * the IP counts that Postgres had already committed, and because the RDS upsert is
 * additive those counts were re-applied every cycle. Enforcement counters therefore hold
 * values far above real traffic, which blocks legitimate origins and IPs.
 *
 * These columns do reset on their own -- hourly ones at the hour boundary, daily ones at
 * UTC midnight -- so this script only buys back the time until then. Run it after the
 * proxy has been restarted onto the fixed code, otherwise the still-running process will
 * re-apply its in-memory backlog within one cycle and undo the reset.
 *
 * Deliberately NOT touched: requests_total, requests_this_month, the cumulative origins
 * column, and ip_history_table. None of them feed enforcement, so they cannot block
 * anyone; they are reporting data only.
 *
 * Usage:
 *   node database_scripts/resetRateLimitCounters.js             # report only, no writes
 *   node database_scripts/resetRateLimitCounters.js --confirm   # perform the reset
 */

import pkg from 'pg';
const { Pool } = pkg;
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  originRateLimitPerHour,
  originRateLimitPerDay,
  ipRateLimitPerHour,
  ipRateLimitPerDay
} from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const RDS_CA_BUNDLE_PATH = '/home/ubuntu/rpc-ssl-proxy/rds-ca-bundle.pem';

// Column -> the value that clears it. Only columns that actually exist are used, so this
// works regardless of which migrations have been applied.
const RESET_TARGETS = {
  requests_last_hour: '0',
  requests_previous_hour: '0',
  origins_last_hour: `'{}'::jsonb`,
  origins_previous_hour: `'{}'::jsonb`,
  requests_today: '0',
  origins_today: `'{}'::jsonb`
};

const CONFIRMED = process.argv.includes('--confirm');
const TOP_N = 15;

async function connect() {
  const required = ['RDS_SECRET_NAME', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'DB_HOST'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  console.log('🔐 Fetching database credentials from AWS Secrets Manager...');
  const secretsClient = new SecretsManagerClient({
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });

  const data = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.RDS_SECRET_NAME, VersionStage: 'AWSCURRENT' })
  );
  const secret = JSON.parse(data.SecretString);
  console.log('✅ Retrieved database credentials');

  return new Pool({
    host: process.env.DB_HOST,
    user: secret.username,
    password: secret.password,
    database: secret.dbname || 'postgres',
    port: 5432,
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(RDS_CA_BUNDLE_PATH).toString() },
    connectionTimeoutMillis: 10000,
    max: 5
  });
}

async function findExistingColumns(pool) {
  const result = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'ip_table' AND column_name = ANY($1)`,
    [Object.keys(RESET_TARGETS)]
  );
  return result.rows.map((row) => row.column_name);
}

/**
 * Sum an origins JSONB column per origin, mirroring the aggregation the rate limiter uses
 * (including LOWER on the key and the absence of any row filter, so dormant rows count).
 */
async function originTotals(pool, column) {
  const result = await pool.query(`
    SELECT LOWER(origin_key) AS origin, SUM((origin_value)::bigint) AS requests
    FROM ip_table, jsonb_each_text(COALESCE(${column}, '{}'::jsonb)) AS x(origin_key, origin_value)
    GROUP BY LOWER(origin_key)
    ORDER BY requests DESC
  `);
  return result.rows.map((row) => ({ origin: row.origin, requests: Number(row.requests) }));
}

async function report(pool, columns, label) {
  console.log(`\n${'='.repeat(78)}\n${label}\n${'='.repeat(78)}`);

  const counters = ['requests_last_hour', 'requests_today'].filter((c) => columns.includes(c));
  const selects = ['COUNT(*) AS total_rows'].concat(
    counters.map((c) => `COUNT(*) FILTER (WHERE ${c} > 0) AS active_${c}`),
    counters.map((c) => `COALESCE(SUM(${c}), 0) AS sum_${c}`),
    counters.map((c) => `COALESCE(MAX(${c}), 0) AS max_${c}`)
  );
  const { rows: [totals] } = await pool.query(`SELECT ${selects.join(', ')} FROM ip_table`);

  console.log(`\nRows in ip_table: ${Number(totals.total_rows).toLocaleString()}`);
  for (const c of counters) {
    console.log(
      `  ${c.padEnd(24)} rows > 0: ${Number(totals[`active_${c}`]).toLocaleString().padStart(10)}` +
      `   sum: ${Number(totals[`sum_${c}`]).toLocaleString().padStart(14)}` +
      `   max on one row: ${Number(totals[`max_${c}`]).toLocaleString()}`
    );
  }

  for (const [column, cap, window] of [
    ['origins_today', originRateLimitPerDay, 'day'],
    ['origins_last_hour', originRateLimitPerHour, 'hour']
  ]) {
    if (!columns.includes(column)) continue;

    const origins = await originTotals(pool, column);
    const overCap = origins.filter((o) => o.requests > cap);

    console.log(
      `\nOrigins by ${column} (cap ${cap.toLocaleString()}/${window}): ` +
      `${origins.length.toLocaleString()} distinct, ${overCap.length.toLocaleString()} over cap`
    );

    for (const { origin, requests } of origins.slice(0, TOP_N)) {
      const flag = requests > cap ? 'BLOCKED' : 'ok';
      const multiple = requests > cap ? ` (${(requests / cap).toFixed(1)}x cap)` : '';
      console.log(
        `  ${flag.padEnd(8)} ${requests.toLocaleString().padStart(14)}  ${origin}${multiple}`
      );
    }
    if (origins.length > TOP_N) {
      console.log(`  ... and ${(origins.length - TOP_N).toLocaleString()} more`);
    }
  }

  for (const [column, cap, window] of [
    ['requests_today', ipRateLimitPerDay, 'day'],
    ['requests_last_hour', ipRateLimitPerHour, 'hour']
  ]) {
    if (!columns.includes(column)) continue;
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*) AS over FROM ip_table WHERE ${column} > $1`,
      [cap]
    );
    console.log(
      `\nIPs over the ${window}ly no-origin cap (${cap.toLocaleString()}) by ${column}: ` +
      `${Number(row.over).toLocaleString()}`
    );
  }
}

async function main() {
  let pool;
  try {
    pool = await connect();

    const columns = await findExistingColumns(pool);
    if (columns.length === 0) {
      console.log('No enforcement counter columns found in ip_table - nothing to do.');
      return;
    }

    console.log(`\nEnforcement columns present: ${columns.join(', ')}`);
    const absent = Object.keys(RESET_TARGETS).filter((c) => !columns.includes(c));
    if (absent.length > 0) {
      console.log(`Not present, will be skipped: ${absent.join(', ')}`);
    }

    await report(pool, columns, 'BEFORE');

    if (!CONFIRMED) {
      console.log(`\n${'='.repeat(78)}`);
      console.log('DRY RUN - nothing was written.');
      console.log(`Would zero on every row: ${columns.join(', ')}`);
      console.log('Leaves untouched: requests_total, requests_this_month, origins, ip_history_table');
      console.log('\nRe-run with --confirm to apply.');
      console.log(`${'='.repeat(78)}`);
      return;
    }

    const assignments = columns.map((c) => `${c} = ${RESET_TARGETS[c]}`).join(', ');
    console.log(`\nApplying: UPDATE ip_table SET ${assignments}`);

    const started = Date.now();
    const result = await pool.query(`UPDATE ip_table SET ${assignments}`);
    console.log(`✅ Reset ${result.rowCount.toLocaleString()} rows in ${Date.now() - started} ms`);

    await report(pool, columns, 'AFTER');

    console.log(
      '\nThe rate limiter rebuilds its blocklists from these columns on its next poll ' +
      '(rateLimitPollInterval), so blocks should lift within seconds without a restart.'
    );
  } catch (error) {
    console.error('\n❌ Failed:', error.message);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}

main();
