import { createCipheriv, createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DurableSession,
  SessionError,
  loadSession,
  type SessionEvent,
  type SessionSnapshot,
  persistSession,
} from '../../session/durable-session.js';

const FIXED_TIME = '2026-07-25T00:00:00.000Z';
const FILE_OPTIONS = { encryptionKey: Buffer.alloc(32, 0x6b) };

function encryptedFixtureRecord(
  plaintext: string,
  associatedData: string,
  options: { nonceBytes?: number; tagBytes?: number } = {},
): string {
  const nonce = Buffer.alloc(options.nonceBytes ?? 12, 0x4d);
  const tagBytes = options.tagBytes ?? 16;
  const cipher = createCipheriv(
    'aes-256-gcm',
    FILE_OPTIONS.encryptionKey,
    nonce,
    { authTagLength: tagBytes },
  );
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [
    'ahfile:v1',
    nonce.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

describe('DurableSession authority boundaries', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects an empty session identity', () => {
    expect(() => new DurableSession('')).toThrow('session_id is required');
    expect(() => new DurableSession('   ')).toThrow('session_id is required');
  });

  it('uses a stable typed error identity', () => {
    const error = new SessionError('example');
    expect(error.name).toBe('SessionError');
    expect(error.message).toBe('example');
    expect(error).toBeInstanceOf(Error);
  });

  it('publishes the exact immutable Phase 1 event vocabulary', () => {
    expect(DurableSession.EVENT_TYPES).toEqual([
      'user',
      'assistant',
      'tool_call',
      'tool_result',
      'compaction',
      'branch',
      'fork',
      'steer',
      'system',
      'error',
      'summary',
    ]);
    expect(Object.isFrozen(DurableSession.EVENT_TYPES)).toBe(true);
  });

  it('rejects non-JSON event data with a stable typed error', () => {
    const session = new DurableSession('json-events');
    session.acquireWriter('runtime');
    expect(() => session.append('user', undefined)).toThrow(
      'event data must be JSON-serializable',
    );
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => session.append('user', circular)).toThrow(
      'event data must be JSON-serializable',
    );
    expect(session.eventCount()).toBe(0);
  });

  it('reports exact append boundary failures', () => {
    const session = new DurableSession('append-errors');
    expect(() => session.append('user', {})).toThrow(
      'writer lock required to append',
    );
    session.acquireWriter();
    expect(() => session.append('not-an-event' as never, {})).toThrow(
      'invalid event type: not-an-event',
    );
  });

  it('normalizes a non-Error serialization failure without leaking it', () => {
    const session = new DurableSession('json-throw');
    session.acquireWriter('runtime');
    const hostile = {
      toJSON(): never {
        throw 'hostile serializer';
      },
    };
    expect(() => session.append('user', hostile)).toThrow(
      'event data must be JSON-serializable: serialization failed',
    );
    expect(session.eventCount()).toBe(0);
  });

  it('freezes null and primitive event data without treating it as an object', () => {
    const session = new DurableSession('primitive-events', {
      clock: () => FIXED_TIME,
    });
    session.acquireWriter('runtime');
    expect(session.append('user', null).data).toBeNull();
    expect(session.append('system', 'ready').data).toBe('ready');
    expect(session.eventCount()).toBe(2);
  });

  it('does not advance the in-memory authority when durable append fails', () => {
    const session = new DurableSession('persist-failure', {
      clock: () => FIXED_TIME,
      persistence: {
        appendEvent: () => {
          throw new Error('disk full');
        },
      },
    });
    session.acquireWriter('runtime');

    expect(() => session.append('user', { text: 'not committed' })).toThrow(
      'disk full',
    );
    expect(session.eventCount()).toBe(0);
    expect(session.resumeFrom()).toBe(1);
    expect(session.getSnapshot()).toBeNull();
  });

  it('persists snapshots through the configured durable backend', () => {
    const snapshots: SessionSnapshot[] = [];
    const session = new DurableSession('snapshot-persistence', {
      clock: () => FIXED_TIME,
      persistence: {
        appendEvent: () => undefined,
        saveSnapshot: (_sessionId, snapshot) => snapshots.push(snapshot),
      },
    });
    session.acquireWriter('runtime');
    session.append('user', { text: 'one' });

    const first = session.snapshot_({ completed: 1 });
    const second = session.snapshot_({ nested: { completed: 2 } });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(snapshots).toEqual([first, second]);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.summary)).toBe(true);
    expect(
      Object.isFrozen(
        (second.summary as { nested: { completed: number } }).nested,
      ),
    ).toBe(true);
  });

  it('does not publish a snapshot when its durable write fails', () => {
    const session = new DurableSession('snapshot-failure', {
      persistence: {
        appendEvent: () => undefined,
        saveSnapshot: () => {
          throw new Error('snapshot store unavailable');
        },
      },
    });
    expect(() => session.snapshot_({ state: 'pending' })).toThrow(
      'snapshot store unavailable',
    );
    expect(session.getSnapshot()).toBeNull();
  });

  it('accepts an event-only backend when snapshots are not implemented', () => {
    const session = new DurableSession('optional-snapshot-backend', {
      persistence: { appendEvent: () => undefined },
    });
    expect(() => session.snapshot_({ state: 'safe' })).not.toThrow();
    expect(session.getSnapshot()?.version).toBe(1);
  });

  it('rejects a non-JSON snapshot summary with the snapshot label', () => {
    const session = new DurableSession('json-snapshot');
    expect(() => session.snapshot_(undefined)).toThrow(
      'snapshot summary must be JSON-serializable',
    );
  });

  it('distinguishes an idempotent owner reacquire from a competing writer', () => {
    const session = new DurableSession('writer-owner');
    session.acquireWriter('runtime');
    expect(() => session.acquireWriter('runtime')).not.toThrow();
    expect(() => session.acquireWriter('other-runtime')).toThrow(
      'writer lock already held',
    );
    expect(() => session.releaseWriter('other-runtime')).toThrow(
      'writer lock owned by another caller',
    );
    session.releaseWriter('runtime');
    session.acquireWriter('other-runtime');
    session.releaseWriter('other-runtime');
  });

  it('rejects a blank owner and permits an idempotent release while unlocked', () => {
    const session = new DurableSession('writer-validation');
    expect(() => session.acquireWriter('   ')).toThrow(
      'writer owner is required',
    );
    expect(() => session.releaseWriter('runtime')).not.toThrow();
  });

  it('returns detached frozen read models so callers cannot corrupt the hash chain', () => {
    const session = new DurableSession('immutable-authority', {
      clock: () => FIXED_TIME,
    });
    session.acquireWriter('runtime');
    session.append('user', { nested: { value: 1 } });

    const exported = session.export_();
    const events = session.getEvents();
    const event = session.getEvent(1)!;

    expect(Object.isFrozen(events)).toBe(true);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(
      Object.isFrozen(
        (event.data as { nested: { value: number } }).nested,
      ),
    ).toBe(true);
    (exported.events[0]!.data as { nested: { value: number } }).nested.value = 99;

    expect(
      (session.getEvent(1)!.data as { nested: { value: number } }).nested.value,
    ).toBe(1);
    expect(() =>
      (events as SessionEvent[]).push(exported.events[0]!),
    ).toThrow();
  });

  it('hashes the exact canonical event envelope and previous hash', () => {
    const session = new DurableSession('known-hash', {
      clock: () => FIXED_TIME,
    });
    session.acquireWriter('runtime');
    const event = session.append('user', { text: 'hello' });
    const expected = createHash('sha256')
      .update(`1|user|${FIXED_TIME}|{"text":"hello"}|`)
      .digest('hex');

    expect(event).toMatchObject({
      seq: 1,
      type: 'user',
      timestamp: FIXED_TIME,
      prev_hash: '',
      hash: expected,
    });
  });

  it('rejects a snapshot for another session or an invalid version', () => {
    const session = new DurableSession('snapshot-validation', {
      clock: () => FIXED_TIME,
    });
    session.acquireWriter('runtime');
    session.append('user', {});
    const exported = session.export_();
    const snapshot = session.snapshot_({});

    expect(() =>
      DurableSession.import_({
        ...exported,
        snapshot: { ...snapshot, session_id: 'other-session' },
      }),
    ).toThrow('snapshot session_id mismatch');
    expect(() =>
      DurableSession.import_({
        ...exported,
        snapshot: { ...snapshot, version: 0 },
      }),
    ).toThrow('snapshot version must be a positive integer');
    expect(() =>
      DurableSession.import_({
        ...exported,
        snapshot: { ...snapshot, last_hash: 'not-the-event-head' },
      }),
    ).toThrow('snapshot version mismatch: last_hash');
    expect(() =>
      DurableSession.import_({
        ...exported,
        snapshot: { ...snapshot, last_seq: 2 },
      }),
    ).toThrow('snapshot version mismatch: last_seq');
    expect(() =>
      DurableSession.import_({
        ...exported,
        snapshot: { ...snapshot, last_seq: -1 },
      }),
    ).toThrow('snapshot version mismatch: last_seq');

    const genesis = DurableSession.import_({
      ...exported,
      snapshot: {
        ...snapshot,
        last_seq: 0,
        last_hash: '',
        summary: { checkpoint: 'before replay' },
      },
    });
    expect(genesis.getSnapshot()).toMatchObject({
      last_seq: 0,
      last_hash: '',
      summary: { checkpoint: 'before replay' },
    });
    expect(genesis.eventCount()).toBe(1);
  });

  it('rejects malformed imported event envelopes before accepting authority', () => {
    const source = new DurableSession('import-validation', {
      clock: () => FIXED_TIME,
    });
    source.acquireWriter('runtime');
    source.append('user', { value: 1 });
    const valid = source.export_();

    expect(() =>
      DurableSession.import_({
        session_id: 'import-validation',
        events: null as unknown as SessionEvent[],
        snapshot: null,
      }),
    ).toThrow('events must be an array');
    expect(() =>
      DurableSession.import_({
        ...valid,
        events: [{ ...valid.events[0]!, type: 'invalid' as never }],
      }),
    ).toThrow('invalid event type at seq 1');
    expect(() =>
      DurableSession.import_({
        ...valid,
        events: [{ ...valid.events[0]!, timestamp: '' }],
      }),
    ).toThrow('invalid timestamp at seq 1');
    expect(() =>
      DurableSession.import_({
        ...valid,
        events: [{ ...valid.events[0]!, timestamp: 1 as unknown as string }],
      }),
    ).toThrow('invalid timestamp at seq 1');
    expect(() =>
      DurableSession.import_({
        ...valid,
        events: [{ ...valid.events[0]!, hash: null as unknown as string }],
      }),
    ).toThrow('invalid hash envelope at seq 1');
    expect(() =>
      DurableSession.import_({
        ...valid,
        events: [{ ...valid.events[0]!, prev_hash: null as unknown as string }],
      }),
    ).toThrow('invalid hash envelope at seq 1');
    expect(() =>
      DurableSession.import_({
        ...valid,
        events: [{ ...valid.events[0]!, type: 'bad' as never }],
      }),
    ).toThrow('invalid event type at seq 1');
    expect(() =>
      DurableSession.import_({
        ...valid,
        events: [{ ...valid.events[0]!, hash: '0'.repeat(64) }],
      }),
    ).toThrow('hash chain broken at seq 1');
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() =>
      DurableSession.import_({
        ...valid,
        events: [{ ...valid.events[0]!, data: circular }],
      }),
    ).toThrow('event data at seq 1 must be JSON-serializable');
  });

  it('rejects a validly hashed event that does not link to the prior event', () => {
    const source = new DurableSession('prev-link', { clock: () => FIXED_TIME });
    source.acquireWriter('runtime');
    source.append('user', { value: 1 });
    source.append('assistant', { value: 2 });
    const exported = source.export_();
    const second = exported.events[1]!;
    const wrongPreviousHash = '0'.repeat(64);
    const rehashed = createHash('sha256')
      .update(
        `${second.seq}|${second.type}|${second.timestamp}|${JSON.stringify(second.data)}|${wrongPreviousHash}`,
      )
      .digest('hex');
    exported.events[1] = {
      ...second,
      prev_hash: wrongPreviousHash,
      hash: rehashed,
    };

    expect(() => DurableSession.import_(exported)).toThrow(
      'prev_hash mismatch at seq 2',
    );
  });

  it('does not allow incremental file persistence to start after events exist', () => {
    const directory = mkdtempSync(join(tmpdir(), 'late-log-'));
    temporaryDirectories.push(directory);
    const session = new DurableSession('late-log', { clock: () => FIXED_TIME });
    session.acquireWriter('runtime');
    session.append('user', {});

    expect(() =>
      session.setLogPath(join(directory, 'session.ndjson'), FILE_OPTIONS),
    ).toThrow(
      'log path must be configured before the first event',
    );
  });

  it('rejects a blank incremental log path', () => {
    const session = new DurableSession('blank-log');
    expect(() => session.setLogPath('   ', FILE_OPTIONS)).toThrow(
      'log path is required',
    );
  });

  it('does not allow two independent persistence authorities', () => {
    const session = new DurableSession('dual-authority', {
      persistence: { appendEvent: () => undefined },
    });
    expect(() =>
      session.setLogPath('/tmp/dual-authority.ndjson', FILE_OPTIONS),
    ).toThrow(
      'persistence backend already configured',
    );
  });

  it('requires an exact 256-bit key for file persistence', () => {
    const session = new DurableSession('file-key');
    expect(() =>
      session.setLogPath('/tmp/file-key.ndjson', {
        encryptionKey: Buffer.alloc(31),
      }),
    ).toThrow('32-byte session file encryptionKey is required');
    const directory = mkdtempSync(join(tmpdir(), 'missing-file-key-'));
    temporaryDirectories.push(directory);
    expect(() =>
      persistSession(
        new DurableSession('missing-file-key'),
        join(directory, 'session.ndjson'),
        undefined as never,
      ),
    ).toThrow('32-byte session file encryptionKey is required');
  });

  it.each([
    ['invalid header', 'wrong-header\n'],
    ['wrong record prefix', 'AH-SESSION-LOG:1\nwrong:v1:YQ==:YQ==:YQ==\n'],
    [
      'invalid nonce length',
      'AH-SESSION-LOG:1\nahfile:v1:YQ==:AAAAAAAAAAAAAAAAAAAAAA==:YQ==\n',
    ],
    [
      'invalid tag length',
      'AH-SESSION-LOG:1\nahfile:v1:AAAAAAAAAAAAAAAA:YWJj:YQ==\n',
    ],
  ])('fails closed on encrypted log corruption: %s', (name, content) => {
    const directory = mkdtempSync(join(tmpdir(), 'encrypted-corrupt-'));
    temporaryDirectories.push(directory);
    const path = join(directory, `${name}.ndjson`);
    writeFileSync(path, content, 'utf8');
    expect(() => loadSession('corrupt', path, FILE_OPTIONS)).toThrow(
      name === 'invalid header'
        ? 'invalid session log header'
        : name === 'wrong record prefix'
          ? 'invalid encrypted session record'
          : 'session file authentication failed',
    );
  });

  it('fails closed with the wrong file encryption key', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wrong-file-key-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'session.ndjson');
    const session = new DurableSession('wrong-file-key', {
      clock: () => FIXED_TIME,
    });
    session.acquireWriter();
    session.append('user', { private: 'content' });
    persistSession(session, path, FILE_OPTIONS);

    expect(() =>
      loadSession('wrong-file-key', path, {
        encryptionKey: Buffer.alloc(32, 0x7c),
      }),
    ).toThrow('session file authentication failed');
  });

  it('wraps malformed on-disk JSON as a typed SessionError', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bad-log-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'session.ndjson');
    writeFileSync(path, 'AH-SESSION-LOG:1\nbroken-record\n', 'utf8');

    expect(() => loadSession('bad-log', path, FILE_OPTIONS)).toThrow(SessionError);
    expect(() => loadSession('bad-log', path, FILE_OPTIONS)).toThrow(
      'invalid encrypted session record',
    );
  });

  it('rejects authenticated malformed event JSON with the exact durable line', () => {
    const directory = mkdtempSync(join(tmpdir(), 'authenticated-bad-json-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'session.ndjson');
    writeFileSync(
      path,
      `AH-SESSION-LOG:1\n${encryptedFixtureRecord(
        '{',
        'event:authenticated-bad-json:1',
      )}\n`,
      'utf8',
    );

    expect(() =>
      loadSession('authenticated-bad-json', path, FILE_OPTIONS),
    ).toThrow('invalid encrypted session event at line 2');
  });

  it.each([
    ['non-standard nonce', { nonceBytes: 8 }],
    ['truncated authentication tag', { tagBytes: 4 }],
  ])('rejects a cryptographically valid record with %s', (_name, envelopeOptions) => {
    const directory = mkdtempSync(join(tmpdir(), 'noncanonical-envelope-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'session.ndjson');
    const event = {
      seq: 1,
      type: 'user',
      timestamp: FIXED_TIME,
      data: { text: 'authenticated' },
      hash: '0'.repeat(64),
      prev_hash: '',
    };
    writeFileSync(
      path,
      `AH-SESSION-LOG:1\n${encryptedFixtureRecord(
        JSON.stringify(event),
        'event:noncanonical-envelope:1',
        envelopeOptions,
      )}\n`,
      'utf8',
    );

    expect(() =>
      loadSession('noncanonical-envelope', path, FILE_OPTIONS),
    ).toThrow('session file authentication failed');
  });

  it('rejects extra encrypted-envelope fields before authentication', () => {
    const directory = mkdtempSync(join(tmpdir(), 'extra-envelope-field-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'session.ndjson');
    const record = encryptedFixtureRecord(
      '{}',
      'event:extra-envelope-field:1',
    );
    writeFileSync(path, `AH-SESSION-LOG:1\n${record}:extra\n`, 'utf8');

    expect(() =>
      loadSession('extra-envelope-field', path, FILE_OPTIONS),
    ).toThrow('invalid encrypted session record');
  });

  it('wraps malformed snapshot JSON as a typed SessionError', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bad-snapshot-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'session.ndjson');
    writeFileSync(path, 'AH-SESSION-LOG:1\n', 'utf8');
    writeFileSync(
      `${path}.snapshot.json`,
      'AH-SESSION-LOG:1\nbroken-record\n',
      'utf8',
    );

    expect(() => loadSession('bad-snapshot', path, FILE_OPTIONS)).toThrow(
      'invalid encrypted session record',
    );
  });

  it('rejects a snapshot with a noncanonical file header', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bad-snapshot-header-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'session.ndjson');
    writeFileSync(path, 'AH-SESSION-LOG:1\n', 'utf8');
    writeFileSync(`${path}.snapshot.json`, 'WRONG\n', 'utf8');

    expect(() => loadSession('bad-snapshot-header', path, FILE_OPTIONS)).toThrow(
      'invalid encrypted session snapshot',
    );
  });

  it('rejects a snapshot file with no encrypted record', () => {
    const directory = mkdtempSync(join(tmpdir(), 'missing-snapshot-record-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'session.ndjson');
    writeFileSync(path, 'AH-SESSION-LOG:1\n', 'utf8');
    writeFileSync(`${path}.snapshot.json`, 'AH-SESSION-LOG:1\n  \n', 'utf8');

    expect(() => loadSession('missing-snapshot', path, FILE_OPTIONS)).toThrow(
      'invalid encrypted session snapshot',
    );
  });

  it('skips blank snapshot lines and decrypts the actual record', () => {
    const directory = mkdtempSync(join(tmpdir(), 'blank-snapshot-lines-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'session.ndjson');
    const source = new DurableSession('blank-snapshot-lines', {
      clock: () => FIXED_TIME,
    });
    source.acquireWriter();
    source.append('user', { text: 'private event marker' });
    source.snapshot_({ text: 'private snapshot marker' });
    persistSession(source, path, FILE_OPTIONS);
    const snapshotPath = `${path}.snapshot.json`;
    const encryptedSnapshot = readFileSync(snapshotPath, 'utf8');
    writeFileSync(
      snapshotPath,
      encryptedSnapshot.replace('\n', '\n \t \n'),
      'utf8',
    );

    const loaded = loadSession('blank-snapshot-lines', path, FILE_OPTIONS);
    expect(loaded.getSnapshot()?.summary).toEqual({
      text: 'private snapshot marker',
    });
    expect(readFileSync(path).includes(Buffer.from('private event marker'))).toBe(
      false,
    );
    expect(
      readFileSync(snapshotPath).includes(
        Buffer.from('private snapshot marker'),
      ),
    ).toBe(false);
  });

  it('ignores blank and whitespace-only lines in an event log', () => {
    const directory = mkdtempSync(join(tmpdir(), 'blank-lines-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'session.ndjson');
    const source = new DurableSession('blank-lines', { clock: () => FIXED_TIME });
    source.setLogPath(path, FILE_OPTIONS);
    source.acquireWriter('runtime');
    source.append('user', { value: 1 });
    const encrypted = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      encrypted.replace('\n', '\n\n  \n').concat('\t\n'),
      'utf8',
    );

    expect(loadSession('blank-lines', path, FILE_OPTIONS).eventCount()).toBe(1);
  });

  it('persists an empty authority without inventing an event or snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'empty-session-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'session.ndjson');
    const session = new DurableSession('empty-session');

    persistSession(session, path, FILE_OPTIONS);

    expect(readFileSync(path, 'utf8')).toBe('AH-SESSION-LOG:1\n');
    expect(existsSync(`${path}.snapshot.json`)).toBe(false);
    expect(loadSession('empty-session', path, FILE_OPTIONS).eventCount()).toBe(0);
  });

  it('removes its temporary file when an atomic replacement cannot publish', () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-failure-'));
    temporaryDirectories.push(directory);
    const targetDirectory = join(directory, 'target');
    const session = new DurableSession('atomic-failure');
    writeFileSync(join(directory, 'keep'), 'sentinel', 'utf8');
    // The target path is a directory, so rename(temp, target) must fail.
    mkdirSync(targetDirectory);

    expect(() =>
      persistSession(session, targetDirectory, FILE_OPTIONS),
    ).toThrow();
    expect(
      readdirSync(directory).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
    expect(readFileSync(join(directory, 'keep'), 'utf8')).toBe('sentinel');
  });

  it('reports a typed error for a missing event log without creating a file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'missing-log-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'missing.ndjson');

    expect(() => loadSession('missing-log', path, FILE_OPTIONS)).toThrow(
      `session log not found: ${path}`,
    );
    expect(existsSync(path)).toBe(false);
  });

  it('loads a valid log without mutating its bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'read-log-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'session.ndjson');
    const source = new DurableSession('read-log', { clock: () => FIXED_TIME });
    source.setLogPath(path, FILE_OPTIONS);
    source.acquireWriter('runtime');
    source.append('user', { text: 'persisted' });
    source.releaseWriter('runtime');
    const before = readFileSync(path, 'utf8');

    const loaded = loadSession('read-log', path, FILE_OPTIONS);

    expect(loaded.eventCount()).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
