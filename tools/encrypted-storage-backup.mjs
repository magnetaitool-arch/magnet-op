import { execFileSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
for (const name of [
  'MAGNET_BACKUP_DATABASE_URL',
  'MAGNET_BACKUP_KEY_BASE64',
  'MAGNET_BACKUP_PROJECT_REF',
  'MAGNET_BACKUP_STORAGE_SERVICE_KEY',
])
  if (!process.env[name]) throw Error(`Missing configuration: ${name}`);
const key = Buffer.from(process.env.MAGNET_BACKUP_KEY_BASE64, 'base64'),
  ref = process.env.MAGNET_BACKUP_PROJECT_REF,
  url = new URL(process.env.MAGNET_BACKUP_DATABASE_URL);
if (
  key.length !== 32 ||
  !/^[a-z]{20}$/.test(ref) ||
  (!url.hostname.includes(ref) && !decodeURIComponent(url.username).includes(ref))
)
  throw Error('Backup target/key validation failed');
const env = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: url.pathname.slice(1),
  PGSSLMODE: 'verify-full',
  PGSSLROOTCERT: process.env.MAGNET_BACKUP_SSLROOTCERT || 'system',
};
let objects;
try {
  objects = JSON.parse(
    execFileSync(
      'psql',
      [
        '-X',
        '-qAt',
        '-c',
        "begin read only; set local role postgres; select coalesce(jsonb_agg(jsonb_build_object('id',id,'bucket',bucket_id,'name',name,'size',metadata->>'size') order by id),'[]') from storage.objects; commit;",
      ],
      { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
} catch {
  throw Error('Could not read storage inventory; no successful backup claimed');
}
if (!Array.isArray(objects)) throw Error('Invalid storage inventory');
const iv = randomBytes(12),
  cipher = createCipheriv('aes-256-gcm', key, iv),
  hash = createHash('sha256'),
  manifest = [];
async function* archive() {
  yield Buffer.from(
    JSON.stringify({
      type: 'header',
      format: 'magnet-storage-jsonl-v1',
      projectRef: ref,
      objects: objects.length,
    }) + '\n',
  );
  for (const object of objects) {
    const response = await fetch(
      'https://' +
        ref +
        '.supabase.co/storage/v1/object/authenticated/' +
        encodeURIComponent(object.bucket) +
        '/' +
        object.name.split('/').map(encodeURIComponent).join('/'),
      {
        headers: {
          apikey: process.env.MAGNET_BACKUP_STORAGE_SERVICE_KEY,
          Authorization: 'Bearer ' + process.env.MAGNET_BACKUP_STORAGE_SERVICE_KEY,
        },
        signal: AbortSignal.timeout(120000),
      },
    );
    if (!response.ok || !response.body) throw Error('Storage object download failed');
    yield Buffer.from(JSON.stringify({ type: 'object', ...object }) + '\n');
    const checksum = createHash('sha256');
    let bytes = 0;
    for await (const raw of response.body) {
      const chunk = Buffer.from(raw);
      bytes += chunk.length;
      checksum.update(chunk);
      yield Buffer.from(
        JSON.stringify({ type: 'chunk', id: object.id, data: chunk.toString('base64') }) + '\n',
      );
    }
    if (object.size !== null && object.size !== undefined && Number(object.size) !== bytes)
      throw Error('Storage object changed during backup; retry required');
    const entry = { id: object.id, bytes, sha256: checksum.digest('hex') };
    manifest.push(entry);
    yield Buffer.from(JSON.stringify({ type: 'end', ...entry }) + '\n');
  }
  yield Buffer.from(JSON.stringify({ type: 'complete', objects: manifest.length }) + '\n');
}
const output = resolve(process.env.MAGNET_BACKUP_STORAGE_OUTPUT || 'storage.jsonl.aesgcm'),
  sink = createWriteStream(output, { mode: 0o600 });
sink.write(Buffer.concat([Buffer.from('MAGNET-BACKUP-V1\n'), iv]));
try {
  await pipeline(
    Readable.from(archive()),
    new Transform({
      transform(chunk, _encoding, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    }),
    cipher,
    sink,
    { end: false },
  );
  sink.end(cipher.getAuthTag());
  await new Promise((yes, no) => {
    sink.on('finish', yes);
    sink.on('error', no);
  });
  await writeFile(
    output + '.manifest.json',
    JSON.stringify(
      {
        format: 1,
        projectRef: ref,
        createdAt: new Date().toISOString(),
        objects: manifest.length,
        bytes: manifest.reduce((n, x) => n + x.bytes, 0),
        plainArchiveSha256: hash.digest('hex'),
        status: 'EXPORTED_NOT_RESTORE_VERIFIED',
        storageBytesIncluded: true,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log('Encrypted storage bytes exported and checksummed:', manifest.length, 'objects');
} catch {
  sink.destroy();
  throw Error('Storage backup failed; discard incomplete ciphertext and retry.');
} finally {
  key.fill(0);
}
