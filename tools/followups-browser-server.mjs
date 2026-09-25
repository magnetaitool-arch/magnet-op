import http from 'node:http';
import { createPreviewServer } from './dev-server.js';
// Synthetic embedded-Postgres QA only. The caller owns the temporary DB lifecycle.
export async function serveFollowupsQA({ connect, organizationId, userId }) {
  const port = 48765,
    origin = `http://127.0.0.1:${port}`;
  const preview = createPreviewServer();
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/__qa_followups') {
      preview.emit('request', req, res);
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (
      req.method !== 'POST' ||
      req.headers.origin !== origin ||
      !String(req.headers['content-type']).startsWith('application/json')
    ) {
      res.writeHead(403);
      res.end('{}');
      return;
    }
    let client;
    try {
      let text = '';
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 16000) throw new Error('body_too_large');
      }
      const { name, args } = JSON.parse(text);
      const publicReview = ['get_public_proposal_v2', 'accept_public_proposal_v2'].includes(name);
      if (!publicReview && args.p_organization_id !== organizationId)
        throw new Error('synthetic_scope_only');
      const commands = {
        get_task_dependencies_v2: ['p_organization_id','p_task_id','p_search'],
        set_task_dependency_v2: ['p_organization_id','p_task_id','p_depends_on_task_id','p_action','p_command_id'],
        create_task_command_v2: ['p_organization_id','p_payload','p_command_id'],
        get_task_record_v2: ['p_organization_id','p_record_id'],
        change_task_record_status_v2: ['p_organization_id','p_record_id','p_expected_status','p_status','p_note'],
        list_client_workspaces: ['p_organization_id','p_status','p_search','p_page','p_page_size'],
        update_task_v2: ['p_organization_id','p_task_id','p_expected_version','p_title','p_client_account_id','p_project_record_id','p_assigned_employee_record_id','p_priority','p_task_type','p_start_date','p_due_date','p_estimated_hours','p_brief','p_requirements','p_reference_links','p_delivery_link','p_blockers','p_client_visible'],
        get_task_v2: ['p_organization_id','p_task_id'],
        create_task_v2: ['p_organization_id','p_title','p_client_account_id','p_project_record_id','p_assigned_employee_record_id','p_status','p_priority','p_task_type','p_start_date','p_due_date','p_estimated_hours','p_brief','p_requirements','p_reference_links','p_client_visible'],
        list_tasks_v2: ['p_organization_id','p_scope','p_status','p_search','p_client_account_id','p_project_record_id','p_page','p_page_size'],
        list_documents_v2: ['p_organization_id','p_search','p_document_type','p_visibility','p_client_account_id','p_employee_record_id','p_status','p_page','p_page_size'],
        change_task_status_v2: ['p_organization_id','p_task_id','p_expected_version','p_status','p_note'],
        get_project_briefs_v2: ['p_organization_id','p_project_id'],
        capture_project_brief_v2: ['p_organization_id','p_project_id','p_brief_id','p_source_hash','p_expected_revision','p_command_id'],
        create_project_setup_v2: ['p_organization_id','p_payload','p_command_id'],
        get_client_onboarding_v2: ['p_organization_id','p_client_id'],
        set_client_onboarding_item_v2: ['p_organization_id','p_client_id','p_expected_version','p_index','p_done','p_command_id'],
        workflow_readiness_v2: ['p_organization_id', 'p_workflow_id'],
        start_workflow_v2: ['p_organization_id', 'p_client_id'],
        advance_workflow_v2: ['p_organization_id', 'p_workflow_id', 'p_expected_stage', 'p_command_id'],
        handoff_accepted_proposal_v2: ['p_organization_id', 'p_revision_id'],
        manage_proposal_review_link_v2: [
          'p_organization_id',
          'p_revision_id',
          'p_action',
          'p_link_id',
        ],
        get_public_proposal_v2: ['p_token'],
        accept_public_proposal_v2: ['p_token', 'p_content_hash', 'p_name', 'p_email', 'p_confirm'],
        list_crm_followup_queue_v2: [
          'p_organization_id',
          'p_scope',
          'p_bucket',
          'p_timezone',
          'p_page',
        ],
        list_crm_followups_v2: ['p_organization_id', 'p_legacy_record_id'],
        save_crm_followup_v2: [
          'p_organization_id',
          'p_legacy_record_id',
          'p_command_id',
          'p_id',
          'p_expected_version',
          'p_title',
          'p_due_at',
          'p_source_timezone',
          'p_owner_user_id',
          'p_status',
          'p_outcome',
          'p_next_action',
        ],
        get_proposal_revisions_v2: ['p_organization_id', 'p_record_id'],
        create_proposal_revision_v2: [
          'p_organization_id',
          'p_record_id',
          'p_expected_hash',
          'p_command_id',
        ],
        transition_proposal_revision_v2: [
          'p_organization_id',
          'p_revision_id',
          'p_expected_version',
          'p_action',
          'p_evidence',
          'p_command_id',
        ],
      };
      if (args.p_record_id && !['get_task_record_v2','change_task_record_status_v2'].includes(name) && args.p_record_id !== 'workflow-proposal')
        throw new Error('synthetic_scope_only');
      if (args.p_legacy_record_id && args.p_legacy_record_id !== 'workflow-lead')
        throw new Error('synthetic_scope_only');
      const keys = Object.hasOwn(commands, name) ? commands[name] : null;
      if (!keys) throw new Error('unsupported_qa_command');
      client = connect();
      await client.connect();
      await client.query('begin');
      await client.query(publicReview ? 'set local role anon' : 'set local role authenticated');
      await client.query(
        "select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true)",
        [publicReview ? '' : userId, publicReview ? 'anon' : 'authenticated'],
      );
      const result = (
        await client.query(
          `select public.${name}(${keys.map((_, i) => '$' + (i + 1)).join(',')}) result`,
          keys.map((k) => args[k] ?? null),
        )
      ).rows[0].result;
      await client.query('commit');
      res.end(JSON.stringify(result));
    } catch (error) {
      if (client) await client.query('rollback').catch(() => {});
      res.writeHead(400);
      res.end(JSON.stringify({ error: error.message }));
    } finally {
      if (client) await client.end();
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  console.log(
    `Synthetic persistent workflow QA: ${origin} organization=${organizationId} user=${userId}`,
  );
  await new Promise((resolve) => process.once('SIGINT', resolve));
  await new Promise((resolve) => server.close(resolve));
}
