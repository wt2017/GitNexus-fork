/**
 * Integration test: orphan sidecar recovery in doInitLbug.
 *
 * Exercises the real `initLbug` → `doInitLbug` path against a native
 * LadybugDB instance. Creates actual orphan `.shadow` and
 * `.wal.checkpoint` files on disk (without a main DB file) and confirms
 * that `initLbug` cleans them up and opens a fresh database successfully.
 *
 * This complements the unit-level mocked coverage in
 * `lbug-checkpoint-lifecycle.test.ts` with a real-filesystem,
 * real-LadybugDB integration proof required by DoD §2.7.
 */
import fs from 'fs/promises';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { createTempDir } from '../helpers/test-db.js';

/**
 * LadybugDB 0.16.0 has a known Windows-only regression: `Database.close()`
 * does not release the underlying file lock until the process exits, so any
 * `closeLbug()` followed by `initLbug(samePath)` in the same process raises
 * Win32 Error 33. Skip reopen-dependent tests on Windows.
 */
const itLbugReopen = process.platform === 'win32' ? it.skip : it;

describe('orphan sidecar recovery — native integration', () => {
  itLbugReopen(
    'initLbug recovers when both .shadow and .wal.checkpoint orphan sidecars are present without a main DB file',
    async () => {
      const tmp = await createTempDir('gitnexus-lbug-orphan-');
      const dbPath = path.join(tmp.dbPath, 'lbug');
      const shadowPath = `${dbPath}.shadow`;
      const walCheckpointPath = `${dbPath}.wal.checkpoint`;

      try {
        // Simulate crash-recovery state: orphan sidecars without main DB file
        await fs.writeFile(shadowPath, 'stale-shadow-data');
        await fs.writeFile(walCheckpointPath, 'stale-wal-checkpoint-data');

        // Confirm precondition: main DB file does NOT exist, sidecars DO
        await expect(fs.access(dbPath)).rejects.toThrow();
        await expect(fs.access(shadowPath)).resolves.toBeUndefined();
        await expect(fs.access(walCheckpointPath)).resolves.toBeUndefined();

        const adapter = await import('../../src/core/lbug/lbug-adapter.js');

        // initLbug should clean up orphan sidecars and open a fresh DB
        await adapter.initLbug(dbPath);

        // Verify the database is functional — execute a simple query
        const rows = await adapter.executeQuery('RETURN 1 AS result');
        expect(rows).toEqual([{ result: 1 }]);

        // Verify orphan sidecars were removed
        await expect(fs.access(shadowPath)).rejects.toThrow();
        await expect(fs.access(walCheckpointPath)).rejects.toThrow();

        await adapter.closeLbug();
      } finally {
        await tmp.cleanup();
      }
    },
  );

  itLbugReopen(
    'initLbug recovers when only .shadow orphan sidecar is present (partial crash state)',
    async () => {
      const tmp = await createTempDir('gitnexus-lbug-orphan-');
      const dbPath = path.join(tmp.dbPath, 'lbug');
      const shadowPath = `${dbPath}.shadow`;
      const walCheckpointPath = `${dbPath}.wal.checkpoint`;

      try {
        // Only .shadow present — partial crash state
        await fs.writeFile(shadowPath, 'stale-shadow-data');

        const adapter = await import('../../src/core/lbug/lbug-adapter.js');
        await adapter.initLbug(dbPath);

        const rows = await adapter.executeQuery('RETURN 42 AS answer');
        expect(rows).toEqual([{ answer: 42 }]);

        // .shadow cleaned, .wal.checkpoint was never present
        await expect(fs.access(shadowPath)).rejects.toThrow();
        await expect(fs.access(walCheckpointPath)).rejects.toThrow();

        await adapter.closeLbug();
      } finally {
        await tmp.cleanup();
      }
    },
  );

  itLbugReopen(
    'initLbug succeeds on a clean path with no orphan sidecars (baseline)',
    async () => {
      const tmp = await createTempDir('gitnexus-lbug-orphan-');
      const dbPath = path.join(tmp.dbPath, 'lbug');

      try {
        const adapter = await import('../../src/core/lbug/lbug-adapter.js');
        await adapter.initLbug(dbPath);

        const rows = await adapter.executeQuery('RETURN 1 AS ok');
        expect(rows).toEqual([{ ok: 1 }]);

        await adapter.closeLbug();
      } finally {
        await tmp.cleanup();
      }
    },
  );

  itLbugReopen(
    'initLbug does not attempt orphan cleanup when the main DB file exists',
    async () => {
      const tmp = await createTempDir('gitnexus-lbug-orphan-');
      const dbPath = path.join(tmp.dbPath, 'lbug');
      // Place a marker file with a non-sidecar extension next to the DB path.
      // Our cleanup only targets `.shadow` and `.wal.checkpoint` and only when
      // the main DB is missing. We verify the DB opens normally and the marker
      // remains — proving that init did not perform broad sibling file cleanup.
      const markerPath = `${dbPath}.test-marker`;

      try {
        const adapter = await import('../../src/core/lbug/lbug-adapter.js');

        // Create a real DB file by initializing normally
        await adapter.initLbug(dbPath);
        await adapter.closeLbug();

        // Plant marker file next to the existing DB
        await fs.writeFile(markerPath, 'should-survive');

        // Re-init: main DB exists, so orphan cleanup should NOT fire
        await adapter.initLbug(dbPath);

        const rows = await adapter.executeQuery('RETURN 1 AS ok');
        expect(rows).toEqual([{ ok: 1 }]);

        // Marker file survives — no broad cleanup happened
        const content = await fs.readFile(markerPath, 'utf-8');
        expect(content).toBe('should-survive');

        await adapter.closeLbug();
      } finally {
        // Clean up marker file — best-effort; may already be absent
        await fs.unlink(markerPath).catch(() => { /* test cleanup only */ });
        await tmp.cleanup();
      }
    },
  );
});
