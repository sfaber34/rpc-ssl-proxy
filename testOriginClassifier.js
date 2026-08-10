/**
 * Guards three invariants that rate limiting depends on.
 *
 * INVARIANT 1 - Accounting and enforcement must pick the same bucket.
 *   An origin that accounting refuses to record accumulates no counts. If enforcement
 *   nevertheless treats it as a real origin, it is checked against a counter that is
 *   permanently zero and can never trip - and because enforcement took the origin branch,
 *   the IP limit is never consulted either. That gap let `Origin: *` bypass both buckets.
 *
 * INVARIANT 2 - Case variants of one origin must collapse to one key.
 *   Origins are case-insensitive per DNS, but JSONB keys and JS Set/Map lookups are not.
 *   If capitalization survives into the key, one origin fragments into many independent
 *   counters, each granted its own full rate limit.
 *
 * INVARIANT 3 - The exempt origin cannot be borrowed for arbitrary methods.
 *   The Origin header is caller-supplied, so the EXEMPT bucket is available to anyone who
 *   copies it. Requests claiming that origin are restricted to the methods it actually uses,
 *   so the free pass cannot be turned into unlimited access to the rest of the RPC surface.
 *
 * Buckets:
 *   ORIGIN - counted per deployed app, aggregated across all IPs (higher limit)
 *   IP     - counted per IP as no-origin traffic (lower limit)
 *   EXEMPT - not counted and not limited at all
 *
 * No database or network access. Run: node testOriginClassifier.js
 */

import { isLocalOrigin as validatorIsLocalOrigin, normalizeOrigin } from './utils/originValidator.js';
import { isLocalOrigin, isExemptOrigin, isExemptOriginMethod } from './utils/rateLimiter.js';

/**
 * Models the ACCOUNTING path: backgroundTasks.updateIpCountMap() decides what gets
 * counted, then originValidator.filterOrigins() decides which origins survive the
 * database write. Mirrors those two functions step for step.
 */
function accountingBucket(origin) {
  // updateIpCountMap() returns before incrementing anything for exempt origins
  if (origin && normalizeOrigin(origin) === 'buidlguidl-client') return 'EXEMPT';

  // From here the IP total is incremented; only the origin attribution is still in question
  if (!origin || origin === 'unknown') return 'IP';

  const cleanOrigin = normalizeOrigin(origin);
  if (!cleanOrigin) return 'IP';
  if (cleanOrigin.includes('localhost')) return 'IP';

  // Origin enters ipCountMap; filterOrigins() decides whether it reaches the DB
  return validatorIsLocalOrigin(cleanOrigin) ? 'IP' : 'ORIGIN';
}

/** Models the ENFORCEMENT path: rateLimiter.checkRateLimit() bucket selection. */
function enforcementBucket(origin) {
  if (isExemptOrigin(origin)) return 'EXEMPT';
  const cleanOrigin = normalizeOrigin(origin);
  const hasRealOrigin = cleanOrigin && !isLocalOrigin(cleanOrigin);
  return hasRealOrigin ? 'ORIGIN' : 'IP';
}

/** The key both paths use to look up / store a counter. */
function counterKey(origin) {
  return normalizeOrigin(origin);
}

// ---------------------------------------------------------------------------
// INVARIANT 1: bucket agreement
// ---------------------------------------------------------------------------

// [origin, expectedBucket, description]
const BUCKET_CASES = [
  // --- Real deployed apps: must stay in the ORIGIN bucket ---
  ['https://speedrunethereum.com',       'ORIGIN', 'real origin'],
  ['https://app.buidlguidl.com',         'ORIGIN', 'real subdomain'],
  ['https://bm-lyart.vercel.app',        'ORIGIN', 'vercel app'],
  ['https://a.b.c.example.co.uk',        'ORIGIN', 'deep subdomain'],
  ['https://xn--bcher-kva.com',          'ORIGIN', 'punycode IDN'],
  ['https://foo-bar.com',                'ORIGIN', 'hyphen in label'],
  ['https://1024x.fun',                  'ORIGIN', 'leading digit label'],
  ['http://plain-http.com',              'ORIGIN', 'http scheme'],
  ['https://trailing.com/',              'ORIGIN', 'trailing slash'],
  ['  https://padded.com  ',             'ORIGIN', 'surrounding whitespace'],

  // --- Case variants of real origins must still reach the ORIGIN bucket ---
  ['HTTPS://SpeedRunEthereum.com',       'ORIGIN', 'uppercase scheme + mixed host'],
  ['https://SPEEDRUNETHEREUM.COM',       'ORIGIN', 'all-caps host'],
  ['HtTpS://Foo.CoM/',                   'ORIGIN', 'mixed everything'],

  // --- The live bypass ---
  ['*',                                  'IP',     'wildcard (the exploited bypass)'],

  // --- Same class of bypass ---
  ['https://foo',                        'IP',     'single label, no dot'],
  ['foo',                                'IP',     'bare single label'],
  ['http://8.8.8.8',                     'IP',     'public IPv4 literal'],
  ['https://1.2.3.4',                    'IP',     'public IPv4 literal'],
  ['http://x.local',                     'IP',     '.local TLD'],
  ['http://y.internal',                  'IP',     '.internal TLD'],
  ['http://z.lan',                       'IP',     '.lan TLD'],
  ['http://w.home',                      'IP',     '.home TLD'],
  ['http://foo_bar.com',                 'IP',     'underscore is invalid in DNS'],
  ['http://foo.123',                     'IP',     'numeric TLD'],
  ['http://foo..com',                    'IP',     'empty label'],
  ['http://-foo.com',                    'IP',     'label starts with hyphen'],
  ['http://foo-.com',                    'IP',     'label ends with hyphen'],
  ['https://foo.c',                      'IP',     'single-char TLD'],
  ['https://' + 'a'.repeat(64) + '.com', 'IP',     'label over 63 chars'],
  ['https://' + 'a'.repeat(300) + '.com','IP',     'origin over 253 chars'],
  ['HTTP://X.LOCAL',                     'IP',     'uppercase .local still local'],
  ['HTTP://8.8.8.8',                     'IP',     'uppercase scheme on IP literal'],

  // --- Already-known local origins ---
  ['http://localhost:3000',              'IP',     'localhost with port'],
  ['http://localhost',                   'IP',     'bare localhost'],
  ['HTTP://LOCALHOST:3000',              'IP',     'uppercase localhost'],
  ['http://127.0.0.1:8545',              'IP',     'loopback'],
  ['http://192.168.1.10',                'IP',     'private network'],
  ['http://10.0.0.1',                    'IP',     'private network'],
  ['https://myapp.com:8545',             'IP',     'explicit port'],
  ['chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn', 'IP', 'MetaMask extension'],
  ['CHROME-EXTENSION://NKBIHFBEOGAEAOEHLEFNKODBEFGPGKNN', 'IP', 'uppercase extension'],
  ['file:///Users/x/index.html',         'IP',     'file protocol'],
  ['null',                               'IP',     'sandboxed iframe'],

  // --- Missing / malformed input ---
  [undefined,                            'IP',     'no origin header'],
  ['',                                   'IP',     'empty string'],
  ['   ',                                'IP',     'whitespace only'],
  ['unknown',                            'IP',     'literal "unknown"'],

  // --- Exempt special case: exempt in every casing ---
  ['buidlguidl-client',                  'EXEMPT', 'buidlguidl-client is exempt'],
  ['BuidlGuidl-Client',                  'EXEMPT', 'mixed case still exempt'],
  ['BUIDLGUIDL-CLIENT',                  'EXEMPT', 'upper case still exempt'],
];

const label = (o) => o === undefined ? '(undefined)'
  : o.trim() === '' ? '(blank)'
  : o.length > 38 ? o.slice(0, 35) + '...'
  : o;

let failures = 0;
const bucketRows = [];

for (const [origin, expected, description] of BUCKET_CASES) {
  const accounting = accountingBucket(origin);
  const enforcement = enforcementBucket(origin);
  const agree = accounting === enforcement;
  const correct = agree && accounting === expected;
  if (!correct) failures++;

  bucketRows.push({
    origin: label(origin),
    accounting,
    enforcement,
    expected,
    result: correct ? 'PASS' : (agree ? 'WRONG BUCKET' : 'MISMATCH'),
    description,
  });
}

console.log('INVARIANT 1 - accounting and enforcement agree on the bucket\n');
console.table(bucketRows);

const mismatches = bucketRows.filter(r => r.result === 'MISMATCH');
if (mismatches.length > 0) {
  console.log('\nBUCKET MISMATCHES - these origins bypass both limits:');
  for (const m of mismatches) {
    console.log(`  ${m.origin}  counted as ${m.accounting}, enforced as ${m.enforcement}  (${m.description})`);
  }
}

// ---------------------------------------------------------------------------
// INVARIANT 2: case/format variants collapse to one counter key
// ---------------------------------------------------------------------------

// Each group must produce exactly one distinct counter key.
const KEY_GROUPS = [
  {
    name: 'speedrunethereum.com',
    variants: [
      'https://speedrunethereum.com',
      'https://SpeedRunEthereum.com',
      'https://SPEEDRUNETHEREUM.COM',
      'HTTPS://speedrunethereum.com',
      'HtTpS://SpeedRunEthereum.CoM',
      'http://speedrunethereum.com',
      'https://speedrunethereum.com/',
      'speedrunethereum.com',
      '  https://SpeedRunEthereum.com/  ',
    ],
  },
  {
    name: 'app.buidlguidl.com',
    variants: [
      'https://app.buidlguidl.com',
      'https://App.BuidlGuidl.com',
      'HTTPS://APP.BUIDLGUIDL.COM/',
      'app.buidlguidl.com',
    ],
  },
  {
    name: 'buidlguidl-client',
    variants: ['buidlguidl-client', 'BuidlGuidl-Client', 'BUIDLGUIDL-CLIENT'],
  },
];

const keyRows = [];
for (const group of KEY_GROUPS) {
  const keys = [...new Set(group.variants.map(counterKey))];
  const ok = keys.length === 1;
  if (!ok) failures++;
  keyRows.push({
    group: group.name,
    variants: group.variants.length,
    distinctKeys: keys.length,
    key: keys.length === 1 ? keys[0] : keys.join(' | '),
    result: ok ? 'PASS' : 'FRAGMENTED',
  });
}

console.log('\nINVARIANT 2 - case/format variants collapse to a single counter key\n');
console.table(keyRows);

const fragmented = keyRows.filter(r => r.result === 'FRAGMENTED');
if (fragmented.length > 0) {
  console.log('\nFRAGMENTED KEYS - each variant would get its own full rate limit:');
  for (const f of fragmented) {
    console.log(`  ${f.group} produced ${f.distinctKeys} keys: ${f.key}`);
  }
}

// Distinct origins must NOT collapse into each other
const DISTINCT_PAIRS = [
  ['https://foo.com', 'https://bar.com'],
  ['https://app.buidlguidl.com', 'https://v3.buidlguidl.com'],
  ['https://buidlguidl.com', 'https://www.buidlguidl.com'],
];
for (const [a, b] of DISTINCT_PAIRS) {
  if (counterKey(a) === counterKey(b)) {
    failures++;
    console.log(`\nOVER-COLLAPSED: "${a}" and "${b}" share key "${counterKey(a)}"`);
  }
}

// ---------------------------------------------------------------------------
// INVARIANT 3: the exempt origin only buys access to its own methods
// ---------------------------------------------------------------------------

/**
 * Models the ADMISSION path: validateRpcRequest() (utils/requestValidator.js) rejects a
 * request when isExemptOrigin() says the caller claims the free pass and
 * isExemptOriginMethod() says the method is not one the exempt client issues.
 *
 *   SERVE      - exempt origin asking for something it legitimately asks for
 *   REJECT     - exempt origin asking for anything else, i.e. a spoofed header
 *   NOT_EXEMPT - ordinary traffic, admitted here and limited by the buckets above
 */
function admissionVerdict(origin, method) {
  if (!isExemptOrigin(origin)) return 'NOT_EXEMPT';
  return isExemptOriginMethod(method) ? 'SERVE' : 'REJECT';
}

// [origin, method, expectedVerdict, description]
const ADMISSION_CASES = [
  // --- The traffic the exemption exists for ---
  ['buidlguidl-client', 'eth_blockNumber',        'SERVE',  'exempt client polling head'],
  ['buidlguidl-client', 'eth_call',               'SERVE',  'exempt client reading state'],
  ['BuidlGuidl-Client', 'eth_call',               'SERVE',  'casing does not lose the pass'],

  // --- Spoofers: exempt header, methods the client never sends ---
  ['buidlguidl-client', 'eth_getBalance',         'REJECT', 'spoofed header'],
  ['buidlguidl-client', 'eth_getLogs',            'REJECT', 'spoofed header on a heavy method'],
  ['buidlguidl-client', 'eth_sendRawTransaction', 'REJECT', 'spoofed header on a write'],
  ['BUIDLGUIDL-CLIENT', 'eth_getBlockByNumber',   'REJECT', 'casing does not grant the pass'],
  ['buidlguidl-client', 'net_version',            'REJECT', 'spoofed header, other namespace'],

  // --- Method matching is exact: no casing or padding tricks ---
  ['buidlguidl-client', 'ETH_CALL',               'REJECT', 'method names are case-sensitive'],
  ['buidlguidl-client', ' eth_call',              'REJECT', 'leading whitespace'],
  ['buidlguidl-client', 'eth_call2',              'REJECT', 'suffixed method name'],
  ['buidlguidl-client', '',                       'REJECT', 'empty method'],
  ['buidlguidl-client', undefined,                'REJECT', 'missing method'],

  // --- Ordinary traffic is untouched by this check ---
  ['https://speedrunethereum.com', 'eth_getBalance', 'NOT_EXEMPT', 'real origin, normal limits'],
  ['buidlguidl-client.com',        'eth_getBalance', 'NOT_EXEMPT', 'lookalike domain is not exempt'],
  [undefined,                      'eth_getBalance', 'NOT_EXEMPT', 'no origin, IP limits'],
];

const admissionRows = [];
for (const [origin, method, expected, description] of ADMISSION_CASES) {
  const verdict = admissionVerdict(origin, method);
  const correct = verdict === expected;
  if (!correct) failures++;

  admissionRows.push({
    origin: label(origin),
    method: method === undefined ? '(undefined)' : method === '' ? '(blank)' : method,
    verdict,
    expected,
    result: correct ? 'PASS' : 'FAIL',
    description,
  });
}

console.log('\nINVARIANT 3 - the exempt origin only buys access to its own methods\n');
console.table(admissionRows);

const admitted = admissionRows.filter(r => r.result === 'FAIL' && r.verdict !== 'REJECT' && r.expected === 'REJECT');
if (admitted.length > 0) {
  console.log('\nSPOOFING ADMITTED - these requests skip rate limiting on a forged header:');
  for (const a of admitted) {
    console.log(`  ${a.origin} + ${a.method}  (${a.description})`);
  }
}

const total = BUCKET_CASES.length + KEY_GROUPS.length + ADMISSION_CASES.length;
console.log(`\n${total - failures}/${total} checks passed`);
if (failures > 0) {
  console.log(`FAILED: ${failures} check(s). Do not deploy.`);
  process.exit(1);
}
console.log('All invariants hold.');
