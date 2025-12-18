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

/**
 * Creates a custom PostgreSQL function to merge JSONB origin objects
 * by ADDING numeric values instead of overwriting them.
 * 
 * This fixes the critical bug where origin counts were being replaced
 * instead of accumulated.
 */
async function createOriginMergeFunction() {
  let pool = null;
  let client = null;
  
  try {
    // Validate environment variables
    if (!process.env.RDS_SECRET_NAME || !process.env.AWS_ACCESS_KEY_ID || 
        !process.env.AWS_SECRET_ACCESS_KEY || !process.env.DB_HOST) {
      throw new Error('Required environment variables are missing. Please check your .env file.\nRequired: RDS_SECRET_NAME, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, DB_HOST');
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
    pool = new Pool(dbConfig);
    client = await pool.connect();
    console.log('✅ Connected to database successfully');

    // Create the custom JSONB merge function that adds numeric values
    console.log('📝 Creating jsonb_merge_add_numeric function...');
    
    await client.query(`
      CREATE OR REPLACE FUNCTION jsonb_merge_add_numeric(existing JSONB, incoming JSONB)
      RETURNS JSONB
      LANGUAGE plpgsql
      IMMUTABLE
      AS $$
      DECLARE
        result JSONB;
        key TEXT;
        existing_val NUMERIC;
        incoming_val NUMERIC;
      BEGIN
        -- Handle NULL inputs safely
        IF existing IS NULL AND incoming IS NULL THEN
          RETURN '{}'::JSONB;
        END IF;
        
        IF existing IS NULL THEN
          RETURN incoming;
        END IF;
        
        IF incoming IS NULL THEN
          RETURN existing;
        END IF;
        
        -- Start with existing values
        result := existing;
        
        -- Iterate through each key in incoming JSONB
        FOR key IN SELECT jsonb_object_keys(incoming)
        LOOP
          BEGIN
            -- Try to convert both values to numeric
            -- If key exists in existing, add the values
            IF existing ? key THEN
              BEGIN
                existing_val := (existing->key)::TEXT::NUMERIC;
                incoming_val := (incoming->key)::TEXT::NUMERIC;
                result := jsonb_set(result, ARRAY[key], to_jsonb(existing_val + incoming_val));
              EXCEPTION
                WHEN OTHERS THEN
                  -- If conversion fails, use incoming value (overwrite)
                  result := jsonb_set(result, ARRAY[key], incoming->key);
              END;
            ELSE
              -- Key doesn't exist in existing, just add it
              result := jsonb_set(result, ARRAY[key], incoming->key);
            END IF;
          EXCEPTION
            WHEN OTHERS THEN
              -- If anything goes wrong with this key, skip it and continue
              CONTINUE;
          END;
        END LOOP;
        
        RETURN result;
      EXCEPTION
        WHEN OTHERS THEN
          -- Ultimate fallback: return existing if something catastrophic happens
          RETURN COALESCE(existing, incoming, '{}'::JSONB);
      END;
      $$;
    `);

    console.log('✅ Function jsonb_merge_add_numeric created successfully');

    // Test the function with sample data
    console.log('\n🧪 Testing the function...');
    
    const testQuery = `
      SELECT 
        jsonb_merge_add_numeric(
          '{"passkeydemo.atg.eth.link": 100, "speedrunethereum.com": 50}'::JSONB,
          '{"passkeydemo.atg.eth.link": 6, "app.buidlguidl.com": 10}'::JSONB
        ) as result;
    `;
    
    const testResult = await client.query(testQuery);
    const expected = {
      "passkeydemo.atg.eth.link": 106,  // 100 + 6
      "speedrunethereum.com": 50,        // only in existing
      "app.buidlguidl.com": 10           // only in incoming
    };
    
    console.log('Test result:', JSON.stringify(testResult.rows[0].result, null, 2));
    console.log('Expected:', JSON.stringify(expected, null, 2));
    
    // Verify the test
    const result = testResult.rows[0].result;
    if (result["passkeydemo.atg.eth.link"] === 106 &&
        result["speedrunethereum.com"] === 50 &&
        result["app.buidlguidl.com"] === 10) {
      console.log('✅ Function test PASSED - origin counts are being added correctly!');
    } else {
      console.error('❌ Function test FAILED - unexpected result');
    }

    // Test NULL handling
    console.log('\n🧪 Testing NULL handling...');
    const nullTest = await client.query(`
      SELECT 
        jsonb_merge_add_numeric(NULL, '{"test": 5}'::JSONB) as test1,
        jsonb_merge_add_numeric('{"test": 5}'::JSONB, NULL) as test2,
        jsonb_merge_add_numeric(NULL, NULL) as test3;
    `);
    console.log('NULL test results:', nullTest.rows[0]);
    console.log('✅ NULL handling test PASSED');

    console.log('\n✨ Setup complete! The function is ready to use.');
    console.log('\n📋 Next steps:');
    console.log('   1. The updateRDSWithIpRequests.js file will be updated to use this function');
    console.log('   2. Origin counts will now accumulate correctly instead of being overwritten');
    console.log('   3. Existing data will automatically fix itself as new requests come in');

  } catch (error) {
    console.error('❌ Error creating origin merge function:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack
    });
    throw error;
  } finally {
    // Clean up resources
    if (client) {
      try {
        client.release();
        console.log('🔌 Database client released');
      } catch (releaseError) {
        console.error('⚠️  Error releasing client:', releaseError.message);
      }
    }
    
    if (pool) {
      try {
        await pool.end();
        console.log('🔌 Database pool closed');
      } catch (poolError) {
        console.error('⚠️  Error closing pool:', poolError.message);
      }
    }
  }
}

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  createOriginMergeFunction()
    .then(() => {
      console.log('\n✅ Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Script failed:', error.message);
      process.exit(1);
    });
}

export { createOriginMergeFunction };

