import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSessionStore } from '../../session/sqlite-session-store.js';
import { createTrustedSessionStateRoot } from '../../session/session-state-root.js';

const MASTER_KEY = Buffer.alloc(32, 0x5a);

function createStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ah-close-surv-'));
  const stateRoot = createTrustedSessionStateRoot(dir);
  const dbPath = join(dir, 'session.db');
  const store = new SqliteSessionStore(dbPath, { masterKey: MASTER_KEY, state_root: stateRoot });
  return { store, dir };
}

describe('sqlite-store-survival: close() behavior', () => {
  it('close() actually closes the database (operations throw after close)', () => {
    const { store, dir } = createStore();
    store.createRun('r-close-1', 'goal');
    store.close();
    expect(() => store.createRun('r-after-close', 'goal')).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it('close() is idempotent (calling twice does not throw)', () => {
    const { store, dir } = createStore();
    store.createRun('r-close-2', 'goal');
    store.close();
    expect(() => store.close()).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});
