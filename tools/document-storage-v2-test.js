#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260826010000_document_storage_v2.sql');
const app = read('index.html');
const vercel = read('vercel.json');
let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}

console.log('[1] private storage and canonical metadata');
check(/create table if not exists public\.document_files/.test(migration), 'creates canonical document metadata');
check(/organization_id uuid not null references public\.organizations/.test(migration), 'every document is tenant scoped');
check(/bucket_id text not null default 'magnet-documents'/.test(migration), 'metadata points only to the document bucket');
check(/original_path text not null unique/.test(migration), 'object paths are unique references');
check(!/(bytea|base64|data_url|file_bytes)/i.test(migration), 'database model stores no file bytes');
check(/values\('magnet-documents','magnet-documents',false,26214400/.test(migration), 'bucket is private with a 25 MB limit');
check(/allowed_mime_types/.test(migration) && /application\/pdf/.test(migration) && /image\/webp/.test(migration), 'bucket MIME allow-list is explicit');
check(/original_object:=p_organization_id::text\|\|'\/'\|\|document_id::text\|\|'\/original\.'/.test(migration), 'object path uses tenant and random document id');
check(/optimized\.webp/.test(migration) && /thumbnail\.webp/.test(migration), 'image variants have opaque canonical paths');
check(/status text not null default 'UPLOADING'/.test(migration), 'uploads use an explicit state machine');
check(/checksum_sha256/.test(migration) && /\^\[a-f0-9\]\{64\}\$/.test(migration), 'SHA-256 integrity is recorded');

console.log('\n[2] server authorization and lifecycle');
check(/has_org_capability\(p_organization_id,'documents\.manage'\)/.test(migration), 'upload and management require live capability');
check(/current_member_role_key\(p_organization_id\)='client'/.test(migration), 'client access is handled separately');
check(/p_visibility='CLIENT' and public\.document_is_client_self/.test(migration), 'clients read only their own shared files');
check(/hr\.sensitive\.read/.test(migration) && /finance\.read/.test(migration), 'HR and finance documents have narrower reads');
check(/client_document_requires_client/.test(migration), 'client-visible documents require a canonical client');
check(/document_storage_can_upload/.test(migration) && /document\.uploaded_by=auth\.uid\(\)/.test(migration), 'browser upload is limited to its authorized slot');
check(/original_upload_missing/.test(migration) && /optimized_upload_missing/.test(migration) && /thumbnail_upload_missing/.test(migration), 'finalization verifies every required object');
check(/document_version_conflict/.test(migration), 'metadata and state changes use optimistic concurrency');
check(/'ARCHIVED'.*'RESTORED'.*'MOVED_TO_TRASH'/.test(migration), 'archive, restore, and trash are explicit events');
check(/document_events_append_only/.test(migration), 'document audit events are append-only');
check(/deleted_at=case when next_status='DELETED'/.test(migration), 'delete action is recoverable metadata soft deletion');
check(!/create policy [^\n]+ on storage\.objects for delete/i.test(migration), 'browser has no physical object delete policy');
check(/revoke all privileges on public\.document_files.*from public,anon,authenticated/.test(migration), 'direct metadata mutation is revoked');
check(/create policy document_files_authorized_read/.test(migration), 'metadata read is protected by RLS');
check(/revoke all on function public\.list_documents_v2[^\n]+from public,anon/.test(migration), 'anonymous document RPC access is revoked');

console.log('\n[3] migration and legacy safety');
check(/document_import_issues/.test(migration) && /LEGACY_EXTERNAL_LINK_REQUIRES_IMPORT/.test(migration), 'legacy links are inventoried for import');
check(!/delete from public\.records/i.test(migration), 'migration never deletes legacy business records');
check(/on delete restrict/g.test(migration), 'business relationships default to restrictive deletion');
check(/Forward-only rollback/.test(migration) && /Preserve private objects/.test(migration), 'rollback preserves recoverable content');

console.log('\n[4] Document Center UX');
check(/function DocumentCenterView\(/.test(app), 'dedicated Document Center exists');
check(/function DocumentUploadModal\(/.test(app) && /function DocumentProfileModal\(/.test(app), 'upload and document profile flows exist');
check(/case 'files': return html`<\$\{DocumentCenterView\}/.test(app), 'legacy Files navigation opens the secure center');
for (const action of ['Upload file','Scan document','Upload invoice','Upload receipt','Employee document']) {
  check(app.includes(action), `Document Center exposes ${action}`);
}
for (const field of ['Document type','Reference number','Tags, comma separated','Notes']) {
  check(app.includes(field), `upload metadata includes ${field}`);
}
check(/prepareDocumentVariants/.test(app) && /canvas\.toBlob/.test(app) && /image\/webp/.test(app), 'browser creates optimized image and thumbnail variants');
check(/storageUploadObject/.test(app) && /storageSignedUrl/.test(app), 'private Storage upload and signed preview are wired');
check(/finalize_document_upload_v2/.test(app) && /cancel_document_upload_v2/.test(app), 'upload lifecycle finalizes or fails safely');
check(/update_document_metadata_v2/.test(app) && /change_document_state_v2/.test(app), 'rename, move, archive, restore, and trash use server commands');
check(/Download/.test(app) && /Print \/ PDF/.test(app) && /Preview/.test(app), 'profile includes preview, download, and print');
check(/@page\{size:A4/.test(app) && /dir="'\+\(ar\?'rtl':'ltr'\)/.test(app), 'image printing is A4 and RTL aware');
check(/capture=\$\{preset==='scan'\?'environment':null\}/.test(app), 'mobile scan requests the rear camera');
check(!/localStorage[^\n]*(file|blob|base64)/i.test(app), 'file bytes are not persisted to localStorage');
check(/frame-src[^\"]+https:\/\/\*\.supabase\.co/.test(vercel), 'CSP permits only Supabase HTTPS document frames in addition to existing sources');
check(/@media\(max-width:700px\)[\s\S]*document-upload-grid/.test(app), 'Document Center has a mobile layout');

console.log(`\nResult: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
