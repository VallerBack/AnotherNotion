import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationsUrl = new URL('../supabase/migrations/', import.meta.url)
const migrationFiles = (await readdir(migrationsUrl))
  .filter((file) => file.endsWith('.sql'))
  .sort()
const sql = (
  await Promise.all(
    migrationFiles.map((file) => readFile(new URL(file, migrationsUrl), 'utf8')),
  )
).join('\n')
const equalMemberSql = await readFile(
  new URL('20260720000100_single_workspace_equal_members.sql', migrationsUrl),
  'utf8',
)
const softDeleteSql = await readFile(
  new URL('20260720000200_soft_delete_task_rpc.sql', migrationsUrl),
  'utf8',
)
const settingsRealtimeSql = await readFile(
  new URL('20260720000300_account_settings_realtime.sql', migrationsUrl),
  'utf8',
)
const businessTables = [
  'profiles',
  'workspaces',
  'workspace_members',
  'tasks',
  'labels',
  'task_labels',
  'comments',
]

test('all business tables enable and force RLS', () => {
  for (const table of businessTables) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'))
    assert.match(sql, new RegExp(`alter table public\\.${table} force row level security`, 'i'))
  }
})

test('anon receives no business grants or policies', () => {
  assert.doesNotMatch(sql, /create policy[\s\S]*?\bto anon\b/i)
  assert.match(sql, /revoke all on all tables in schema public from anon, authenticated/i)
})

test('every security definer function fixes search_path', () => {
  const definitions = sql.split(/create function /i).slice(1)
  for (const definition of definitions) {
    if (/security definer/i.test(definition)) {
      assert.match(definition, /set search_path = pg_catalog/i)
    }
  }
})

test('membership writes are exposed only through guarded functions', () => {
  assert.doesNotMatch(sql, /create policy workspace_members_(insert|update|delete)/i)
  assert.match(sql, /create function public\.add_workspace_member/i)
  assert.match(sql, /v_count >= 10/i)
  assert.match(
    equalMemberSql,
    /add_workspace_member[\s\S]*?private\.is_workspace_member\(p_workspace_id, v_caller\)/i,
  )
  assert.match(
    equalMemberSql,
    /remove_workspace_member[\s\S]*?private\.is_workspace_member\(p_workspace_id\)/i,
  )
})

test('every update policy has an explicit with check', () => {
  const updatePolicies = sql.matchAll(
    /create policy\s+\S+\s+on\s+\S+\s+for update[\s\S]*?;/gi,
  )
  const policies = [...updatePolicies].map(([policy]) => policy)
  assert.ok(policies.length > 0)
  for (const policy of policies) {
    assert.match(policy, /with check\s*\(/i)
  }
})

test('tenant and audit identities cannot be forged', () => {
  assert.match(sql, /tasks_insert_member[\s\S]*?created_by = auth\.uid\(\)/i)
  assert.match(sql, /labels_insert_member[\s\S]*?created_by = auth\.uid\(\)/i)
  assert.match(sql, /comments_insert_member[\s\S]*?author_id = auth\.uid\(\)/i)
  assert.doesNotMatch(sql, /grant update\s*\([^)]*workspace_id/i)
  assert.doesNotMatch(sql, /grant update\s*\([^)]*created_by/i)
  assert.doesNotMatch(sql, /grant update\s*\([^)]*author_id/i)
})

test('soft-deleted tasks are available only through guarded recycle-bin functions', () => {
  assert.match(
    sql,
    /tasks_select_member[\s\S]*?deleted_at is null\s*\);/i,
  )
  assert.match(sql, /create function public\.list_deleted_tasks/i)
  assert.match(sql, /create function public\.restore_task/i)
  assert.match(
    sql,
    /list_deleted_tasks[\s\S]*?private\.is_workspace_member\(p_workspace_id\)/i,
  )
  assert.doesNotMatch(sql, /create policy tasks_delete/i)
})

test('destructive cascades are not reachable through workspace or task delete policies', () => {
  assert.doesNotMatch(sql, /create policy workspaces_delete/i)
  assert.doesNotMatch(sql, /create policy tasks_delete/i)
  assert.doesNotMatch(sql, /grant delete on public\.workspaces/i)
  assert.doesNotMatch(sql, /grant delete on public\.tasks/i)
})

test('permanent task deletion is available to every workspace member', () => {
  assert.match(
    equalMemberSql,
    /create or replace function public\.permanently_delete_task[\s\S]*?private\.is_workspace_member\(t\.workspace_id\)/i,
  )
  assert.match(
    equalMemberSql,
    /permanently_delete_task[\s\S]*?security definer[\s\S]*?set search_path = pg_catalog/i,
  )
})

test('latest authorization model does not use role values or disable RLS', () => {
  assert.doesNotMatch(equalMemberSql, /\brole\s*=|\brole\s*<>|\brole\s+in\s*\(/i)
  assert.doesNotMatch(equalMemberSql, /disable row level security/i)
  assert.doesNotMatch(equalMemberSql, /\bto\s+anon\b/i)
})

test('all shared-content mutations use workspace membership', () => {
  assert.match(equalMemberSql, /workspaces_update_member[\s\S]*?is_workspace_member\(id\)/i)
  assert.match(equalMemberSql, /comments_update_member[\s\S]*?is_workspace_member\(workspace_id\)/i)
  assert.match(equalMemberSql, /comments_delete_member[\s\S]*?is_workspace_member\(workspace_id\)/i)
  assert.match(sql, /tasks_update_member[\s\S]*?is_workspace_member\(workspace_id\)/i)
  assert.match(sql, /labels_update_member[\s\S]*?is_workspace_member\(workspace_id\)/i)
  assert.match(sql, /labels_delete_member[\s\S]*?is_workspace_member\(workspace_id\)/i)
  assert.match(sql, /task_labels_insert_member[\s\S]*?is_workspace_member\(workspace_id\)/i)
  assert.match(sql, /restore_task[\s\S]*?is_workspace_member\(t\.workspace_id\)/i)
})

test('soft deletion uses a membership-guarded RPC', () => {
  assert.match(
    softDeleteSql,
    /create or replace function public\.soft_delete_task[\s\S]*?private\.is_workspace_member\(t\.workspace_id\)/i,
  )
  assert.match(softDeleteSql, /security definer[\s\S]*?set search_path = pg_catalog/i)
  assert.match(softDeleteSql, /grant execute on function public\.soft_delete_task\(uuid\) to authenticated/i)
  assert.doesNotMatch(softDeleteSql, /\bto anon\b/i)
})

test('owner template contains placeholders only', async () => {
  const template = await readFile(
    new URL('../supabase/templates/initialize_first_owner.sql', import.meta.url),
    'utf8',
  )
  assert.match(template, /OWNER_EMAIL_PLACEHOLDER/)
  assert.match(template, /v_owner_user_id uuid := null/)
  assert.doesNotMatch(template, /@[a-z0-9-]+\.(com|cn|net|org)\b/i)
  assert.match(template, /where w\.name = 'AnotherNotion'/)
  assert.match(template, /on conflict \(workspace_id, user_id\) do update/i)
  assert.match(template, /pg_advisory_xact_lock/i)
})

test('account settings are self-service without exposing protected flags', () => {
  for (const column of ['notification_email', 'notification_email_verified_at', 'email_notifications_enabled', 'must_change_password']) {
    assert.match(settingsRealtimeSql, new RegExp(`add column if not exists ${column}`, 'i'))
  }
  assert.match(sql, /profiles_update_self[\s\S]*?id = auth\.uid\(\)[\s\S]*?with check \(id = auth\.uid\(\)\)/i)
  assert.match(settingsRealtimeSql, /grant update \(display_name, timezone, notification_email, email_notifications_enabled\)/i)
  assert.doesNotMatch(settingsRealtimeSql, /grant update \([^)]*(must_change_password|notification_email_verified_at)/i)
  assert.match(settingsRealtimeSql, /complete_password_change[\s\S]*?where id = auth\.uid\(\)/i)
})

test('shared workspace tables use RLS-filtered realtime', () => {
  for (const table of ['tasks', 'labels', 'task_labels', 'comments']) {
    assert.match(settingsRealtimeSql, new RegExp(`'${table}'`, 'i'))
    assert.match(settingsRealtimeSql, new RegExp(`alter table public\\.${table} replica identity full`, 'i'))
  }
  assert.doesNotMatch(settingsRealtimeSql, /disable row level security|\bto anon\b/i)
})

test('task schedule columns store UTC-capable timestamps', () => {
  assert.match(settingsRealtimeSql, /alter column start_date type timestamptz/i)
  assert.match(settingsRealtimeSql, /alter column due_date type timestamptz/i)
  assert.match(settingsRealtimeSql, /at time zone 'UTC'/i)
})
