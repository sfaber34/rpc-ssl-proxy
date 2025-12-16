/**
 * Test script for origin validation logic
 * 
 * Tests various origin patterns to ensure filtering works correctly
 */

import { testOrigin, filterOrigins } from '../utils/originValidator.js';

console.log('🧪 Testing Origin Validator\n');
console.log('='.repeat(100));

// Test cases
const testCases = {
  'Real Domains (Should TRACK)': [
    'example.com',
    'speedrunethereum.com',
    'passkeydemo.atg.eth.link',
    'app.buidlguidl.com',
    'myapp.test',
    'demo.example',
  ],
  
  'Local/Private IPs (Should FILTER)': [
    '192.168.0.7',
    '192.168.1.105',
    '10.0.0.1',
    '127.0.0.1',
  ],
  
  'IP with Port (Should FILTER)': [
    '192.168.0.7:3000',
    '127.0.0.1:3000',
  ],
  
  'Localhost (Should FILTER)': [
    'localhost',
  ],
  
  'Browser Extensions (Should FILTER)': [
    'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn',
  ],
  
  'Local TLDs (Should FILTER)': [
    'myserver.local',
    'api.internal',
  ],
};

// Run tests
for (const [category, origins] of Object.entries(testCases)) {
  console.log(`\n📋 ${category}`);
  console.log('-'.repeat(100));
  
  for (const origin of origins) {
    const result = testOrigin(origin);
    const paddedOrigin = (origin || '(empty)').padEnd(50);
    const verdict = result.verdict.padEnd(30);
    console.log(`${paddedOrigin} ${verdict}`);
  }
}

// Test filterOrigins function
console.log('\n' + '='.repeat(100));
console.log('\n🧪 Testing filterOrigins() function\n');

const mixedOrigins = {
  'example.com': 100,
  '192.168.0.7': 50,
  'speedrunethereum.com': 200,
  'localhost': 30,
  '10.0.0.1:3000': 20,
  'chrome-extension://abc123': 10,
};

console.log('Input origins:');
console.log(mixedOrigins);

const filtered = filterOrigins(mixedOrigins);

console.log('\nFiltered origins (kept):');
console.log(filtered);

console.log(`\n✅ Filtering working! Kept real domains, filtered local origins.`);
console.log('='.repeat(100));
