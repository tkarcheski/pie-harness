import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { requireValue } from '../../packages/local/store.mjs';

export function health(studio) {
  const status = studio.status();
  const disk = fs.statfsSync(studio.dir);
  return {
    integrity: studio.store.db.prepare('PRAGMA quick_check').get().quick_check,
    uptimeSeconds: Math.floor(os.uptime()),
    freeMemoryBytes: os.freemem(),
    freeDiskBytes: disk.bavail * disk.bsize,
    nodes: status.nodes,
    needsOwner: status.inbox.filter((m) => m.status === 'needs-owner').length,
    failed: status.tasks.filter((t) =>
      ['blocked', 'failed', 'needs-reconciliation'].includes(t.status)
    ).length,
    lastBackup: studio.store.read().studio.lastBackup ?? null
  };
}

export function maintain(studio) {
  const before = health(studio);
  requireValue(
    before.integrity === 'ok',
    'Database integrity check failed; owner intervention required'
  );
  requireValue(
    before.freeDiskBytes > 2 * fs.statSync(studio.file).size + 1048576,
    'Insufficient free space for a snapshot'
  );
  const dir = path.join(studio.dir, 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, randomUUID() + '.sqlite');
  try {
    studio.store.db.prepare('VACUUM INTO ?').run(temp);
    const verify = new DatabaseSync(temp, { readOnly: true });
    try {
      requireValue(
        verify.prepare('PRAGMA integrity_check').get().integrity_check === 'ok',
        'Snapshot integrity check failed'
      );
      const state = JSON.parse(
        verify.prepare('SELECT data FROM workspace WHERE id=1').get().data
      );
      requireValue(
        state.studio.node === studio.store.read().studio.node,
        'Snapshot enrollment mismatch'
      );
    } finally {
      verify.close();
    }
    const target = path.join(dir, 'latest.sqlite');
    fs.renameSync(temp, target);
    const backup = {
      at: studio.store.clock(),
      file: 'backups/latest.sqlite',
      bytes: fs.statSync(target).size
    };
    studio.store.change((s) => {
      s.studio.lastBackup = backup;
    });
    return backup;
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
