import { spawn } from 'node:child_process';
import { createCipheriv, randomBytes, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { writeFile, chmod } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { resolve } from 'node:path';
// No plaintext dump is written. PostgreSQL custom archive streams into AES-256-GCM.
// Run storage export separately too; a DB-only archive is not a full storage backup.
const required = [
  'MAGNET_BACKUP_DATABASE_URL',
  'MAGNET_BACKUP_KEY_BASE64',
  'MAGNET_BACKUP_PROJECT_REF',
];
for (const name of required) if (!process.env[name]) throw Error(`Missing configuration: ${name}`);
const key = Buffer.from(process.env.MAGNET_BACKUP_KEY_BASE64, 'base64');
if (key.length !== 32) throw Error('Backup key must decode to exactly 32 bytes');
const db = new URL(process.env.MAGNET_BACKUP_DATABASE_URL);
if (!['postgres:', 'postgresql:'].includes(db.protocol)) throw Error('PostgreSQL URL required');
const ref = process.env.MAGNET_BACKUP_PROJECT_REF;
if (!/^[a-z]{20}$/.test(ref)) throw Error('Invalid explicit project ref');
if (!db.hostname.includes(ref) && !decodeURIComponent(db.username).includes(ref))
  throw Error('Database target does not match project ref');
const iv = randomBytes(12),
  cipher = createCipheriv('aes-256-gcm', key, iv),
  sha = createHash('sha256');
const path = resolve(process.env.MAGNET_BACKUP_OUTPUT || 'production.dump.aesgcm');
const sink = createWriteStream(path, { mode: 0o600 });
sink.write(Buffer.concat([Buffer.from('MAGNET-BACKUP-V1\n'), iv]));
const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--role=postgres', '--schema=public', '--schema=auth', '--schema=storage', '--schema=supabase_migrations', '--lock-wait-timeout=20000'], {
  env: {
    ...process.env,
    PGHOST: db.hostname,
    PGPORT: db.port || '5432',
    PGUSER: decodeURIComponent(db.username),
    PGPASSWORD: decodeURIComponent(db.password),
    PGDATABASE: db.pathname.slice(1),
    PGCONNECT_TIMEOUT: '20',
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: process.env.MAGNET_BACKUP_SSLROOTCERT || 'system',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bytes = 0,
  failed = false;
child.stderr.on('data', () => {
  /* Do not print provider URLs/connection diagnostics. Exit status is authoritative. */
});
const completed = new Promise((yes, no) => {
  child.on('error', no);
  child.on('exit', (code) =>
    code === 0 ? yes() : no(Error('pg_dump failed; no successful backup recorded')),
  );
});
try {
  await Promise.all([
    pipeline(
      child.stdout,
      new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          sha.update(chunk);
          done(null, chunk);
        },
      }),
      cipher,
      sink,
      { end: false },
    ),
    completed,
  ]);
  if (bytes < 1024) throw Error('Backup unexpectedly empty');
  sink.end(cipher.getAuthTag());
  await new Promise((yes, no) => {
    sink.on('finish', yes);
    sink.on('error', no);
  });
  await chmod(path, 0o600);
  await writeFile(
    path + '.manifest.json',
    JSON.stringify(
      {
        format: 1,
        projectRef: ref,
        createdAt: new Date().toISOString(),
        plainArchiveBytes: bytes,
        plainArchiveSha256: sha.digest('hex'),
        encryption: 'AES-256-GCM',
        status: 'EXPORTED_NOT_RESTORE_VERIFIED',
        storageBytesIncluded: false,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    'Encrypted PostgreSQL archive exported; manifest explicitly excludes storage bytes and restore verification.',
  );
} catch {
  failed = true;
  child.kill();
  sink.destroy();
  throw Error('Backup failed; discard incomplete ciphertext. Check target and server credentials.');
} finally {
  key.fill(0);
  if (failed) process.exitCode = 1;
}
