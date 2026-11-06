import type { Env } from './env';
import { withD1Retry } from './db';
import { MIGRATIONS } from './schema';

let ready: Promise<void> | null = null;

/**
 * Applies pending migrations once per isolate. Uses the same d1_migrations table as
 * `wrangler d1 migrations apply`, so CLI and runtime migrations agree.
 */
export function ensureSchema(env: Env): Promise<void> {
  ready ??= withD1Retry(() => apply(env)).catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

async function apply(env: Env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
  ).run();
  const done = new Set((await env.DB.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()).results.map((r) => r.name));
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    try {
      await env.DB.batch([...m.statements.map((s) => env.DB.prepare(s)), env.DB.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(m.name)]);
    } catch (e) {
      // Another isolate may have applied it at the same moment.
      const applied = await env.DB.prepare('SELECT 1 FROM d1_migrations WHERE name = ?').bind(m.name).first();
      if (!applied) throw e;
    }
  }
}
