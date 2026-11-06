#!/usr/bin/env node
// Creates an API key directly in D1 (useful before you can sign in to the dashboard).
//   node scripts/create-key.mjs "Claude Code" read|write [--local]
// The key is printed once. Only its SHA-256 hash is stored.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

const [name, scope = 'read', flag] = process.argv.slice(2);
if (!name || !['read', 'write'].includes(scope)) {
  console.error('Usage: node scripts/create-key.mjs "<name>" read|write [--local]');
  process.exit(1);
}
const key = 'gsk_' + randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(key).digest('hex');
const q = (s) => "'" + s.replace(/'/g, "''") + "'";
const sql = `INSERT INTO api_keys (name, prefix, hash, scope, created_at) VALUES (${q(name.slice(0, 80))}, ${q(key.slice(0, 10))}, ${q(hash)}, ${q(scope)}, ${q(new Date().toISOString())})`;
execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', flag === '--local' ? '--local' : '--remote', '--command', sql], { stdio: ['inherit', 'ignore', 'inherit'] });
process.stdout.write(`\n${scope} key for "${name}" (shown once):\n${key}\n`);
