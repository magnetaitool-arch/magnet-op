// Only the four known encrypted recovery artifacts are eligible. Never touch source buckets.
export function expiredRecoveryObjects(folders, now = Date.now()) {
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  return folders.filter(x=>typeof x.name==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f-]{36}$/.test(x.name))
    .filter(x=>Date.parse(x.name.slice(0,24).replace(/T(\d{2})-(\d{2})-(\d{2})/,'T$1:$2:$3'))<cutoff)
    .flatMap(x=>['database.aesgcm','database.manifest.json','storage.aesgcm','storage.manifest.json'].map(name=>'snapshots/'+x.name+'/'+name));
}
