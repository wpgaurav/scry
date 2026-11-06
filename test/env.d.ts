/// <reference types="@cloudflare/vitest-plugin/types" />
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    KV: KVNamespace;
    JOBS: Queue;
    ASSETS: Fetcher;
    TEST_MIGRATIONS: unknown;
  }
}
