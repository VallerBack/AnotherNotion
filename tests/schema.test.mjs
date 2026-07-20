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
  assert.match(sql, /create function public\.transfer_workspace_ownership/i)
  assert.match(sql, /private\.is_workspace_owner\(p_workspace_id, v_current_owner\)/i)
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

test('permanent task deletion is restricted to an owner-only definer function', () => {
  assert.match(
    sql,
    /create function public\.permanently_delete_task[\s\S]*?private\.is_workspace_owner\(t\.workspace_id\)/i,
  )
  assert.match(
    sql,
    /permanently_delete_task[\s\S]*?security definer[\s\S]*?set search_path = pg_catalog/i,
  )
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
