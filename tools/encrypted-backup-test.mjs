import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, createDecipheriv, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
test('backup stream encrypts authenticated bytes and rejects wrong target/failed dump', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'magnet-backup-test-'));
  try {
    const key = randomBytes(32),
      archive = Buffer.from('Synthetic PostgreSQL archive\n'.repeat(80)),
      file = join(dir, 'backup.aesgcm');
    await writeFile(
      join(dir, 'pg_dump'),
      '#!/bin/sh\nexec "' +
        process.execPath +
        '" -e "process.stdout.write(Buffer.from(\'' +
        archive.toString('base64') +
        "','base64'))\"\n",
      { mode: 0o700 },
    );
    const env = {
      ...process.env,
      PATH: dir + ':' + process.env.PATH,
      MAGNET_BACKUP_DATABASE_URL: 'postgresql://postgres.fixtureabcdefghijklmn:test@localhost/test',
      MAGNET_BACKUP_PROJECT_REF: 'fixtureabcdefghijklmn',
      MAGNET_BACKUP_KEY_BASE64: key.toString('base64'),
      MAGNET_BACKUP_OUTPUT: file,
    };
    // Exactly twenty-character project ref is required; fake connection is only consumed by stub pg_dump.
    env.MAGNET_BACKUP_PROJECT_REF = 'abcdefghijklmnopqrst';
    env.MAGNET_BACKUP_DATABASE_URL =
      'postgresql://postgres.abcdefghijklmnopqrst:test@localhost/test';
    let r = spawnSync(process.execPath, [resolve('tools/encrypted-backup.mjs')], {
      env,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const encrypted = await readFile(file),
      header = Buffer.byteLength('MAGNET-BACKUP-V1\n'),
      dec = createDecipheriv('aes-256-gcm', key, encrypted.subarray(header, header + 12));
    dec.setAuthTag(encrypted.subarray(-16));
    assert.deepEqual(
      Buffer.concat([dec.update(encrypted.subarray(header + 12, -16)), dec.final()]),
      archive,
    );
    const manifest = JSON.parse(await readFile(file + '.manifest.json'));
    assert.equal(manifest.plainArchiveSha256, createHash('sha256').update(archive).digest('hex'));
    assert.equal(manifest.storageBytesIncluded, false);
    r = spawnSync(process.execPath, [resolve('tools/encrypted-backup.mjs')], {
      env: { ...env, MAGNET_BACKUP_PROJECT_REF: 'zzzzzzzzzzzzzzzzzzzz' },
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
    await writeFile(join(dir, 'pg_dump'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    r = spawnSync(process.execPath, [resolve('tools/encrypted-backup.mjs')], {
      env,
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('storage exporter encrypts bytes, records checksums and fails on changed objects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'magnet-storage-test-'));
  try {
    const key = randomBytes(32),
      file = join(dir, 'storage.aesgcm'),
      object = { id: 'synthetic-object', bucket: 'private', name: 'folder/test.txt', size: 5 };
    await writeFile(
      join(dir, 'psql'),
      "#!/bin/sh\nprintf '%s\\n' '" + JSON.stringify([object]) + "'\n",
      { mode: 0o700 },
    );
    const hook = join(dir, 'fetch-fixture.mjs');
    await writeFile(
      hook,
      "globalThis.fetch=async(url)=>{if(!url.endsWith('/private/folder/test.txt'))throw Error('Unexpected storage target');return new Response(new TextEncoder().encode('hello'));};",
    );
    const env = {
      ...process.env,
      PATH: dir + ':' + process.env.PATH,
      MAGNET_BACKUP_DATABASE_URL: 'postgresql://postgres.abcdefghijklmnopqrst:test@localhost/test',
      MAGNET_BACKUP_PROJECT_REF: 'abcdefghijklmnopqrst',
      MAGNET_BACKUP_KEY_BASE64: key.toString('base64'),
      MAGNET_BACKUP_STORAGE_SERVICE_KEY: 'synthetic-test-only',
      MAGNET_BACKUP_STORAGE_OUTPUT: file,
    };
    let r = spawnSync(
      process.execPath,
      ['--import', hook, resolve('tools/encrypted-storage-backup.mjs')],
      { env, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    const bytes = await readFile(file),
      header = Buffer.byteLength('MAGNET-BACKUP-V1\n'),
      dec = createDecipheriv('aes-256-gcm', key, bytes.subarray(header, header + 12));
    dec.setAuthTag(bytes.subarray(-16));
    const rows = Buffer.concat([dec.update(bytes.subarray(header + 12, -16)), dec.final()])
      .toString()
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(
      Buffer.from(rows.find((r) => r.type === 'chunk').data, 'base64').toString(),
      'hello',
    );
    assert.equal(rows.at(-1).type, 'complete');
    assert.equal(
      rows.find((r) => r.type === 'end').sha256,
      createHash('sha256').update('hello').digest('hex'),
    );
    await writeFile(hook, "globalThis.fetch=async()=>new Response('changed bytes');");
    r = spawnSync(
      process.execPath,
      ['--import', hook, resolve('tools/encrypted-storage-backup.mjs')],
      { env, encoding: 'utf8' },
    );
    assert.notEqual(r.status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
