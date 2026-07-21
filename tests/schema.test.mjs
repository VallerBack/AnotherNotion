import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationsUrl = new URL('../supabase/migrations/', import.meta.url)
const files = (await readdir(migrationsUrl)).filter((file) => file.endsWith('.sql')).sort()
const migrations = await Promise.all(files.map(async (file) => ({ file, sql: await readFile(new URL(file, migrationsUrl), 'utf8') })))
const migration = (name) => migrations.find(({ file }) => file === name)?.sql ?? ''
const sql = migrations.map(({ sql: text }) => text).join('\n')
const equalMembers = migration('20260720000100_single_workspace_equal_members.sql')
const softDelete = migration('20260720000200_soft_delete_task_rpc.sql')
const settings = migration('20260720000300_account_settings_realtime.sql')
const activity = migration('20260720000900_task_activity_multi_assignees.sql')
const channel = migration('20260721000400_channel_reminder_feed.sql')
const cleanup = migration('20260721000500_remove_legacy_email_reminders.sql')
const config = await readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8')
const feed = await readFile(new URL('../supabase/functions/reminder-feed/handler.ts', import.meta.url), 'utf8')
const feedIndex = await readFile(new URL('../supabase/functions/reminder-feed/index.ts', import.meta.url), 'utf8')

const retainedTables = ['profiles','workspaces','workspace_members','tasks','labels','task_labels','comments','task_assignees','channel_reminders']

test('all retained business tables enable and force RLS', () => {
  for (const table of retainedTables) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'))
    assert.match(sql, new RegExp(`alter table public\\.${table} force row level security`, 'i'))
  }
})

test('anon has no business grants or policies', () => {
  assert.doesNotMatch(sql, /create policy[^;]+to anon/is)
  assert.doesNotMatch(sql, /grant (select|insert|update|delete|all)[^;]+to anon/is)
  assert.match(sql, /revoke all on all tables in schema public from anon, authenticated/i)
})

test('every SECURITY DEFINER function fixes search_path', () => {
  for (const { file, sql: text } of migrations) {
    for (const [definition] of text.matchAll(/create(?: or replace)? function[\s\S]*?\$\$[\s\S]*?\$\$;/gi)) {
      if (/security definer/i.test(definition)) assert.match(definition, /set search_path\s*=\s*pg_catalog/i, file)
    }
  }
})

test('every update policy has an explicit WITH CHECK', () => {
  const policies = [...sql.matchAll(/create policy\s+\S+\s+on\s+\S+\s+for update[\s\S]*?;/gi)].map(([value]) => value)
  assert.ok(policies.length > 0)
  for (const policy of policies) assert.match(policy, /with check\s*\(/i)
})

test('tenant and audit identities cannot be forged', () => {
  assert.match(sql, /tasks_insert_member[\s\S]*?created_by = auth\.uid\(\)/i)
  assert.match(sql, /labels_insert_member[\s\S]*?created_by = auth\.uid\(\)/i)
  assert.match(sql, /comments_insert_member[\s\S]*?author_id = auth\.uid\(\)/i)
  assert.doesNotMatch(sql, /grant update\s*\([^)]*(workspace_id|created_by|author_id)/i)
})

test('recycle-bin reads and soft deletion require workspace membership', () => {
  assert.match(sql, /tasks_select_member[\s\S]*?deleted_at is null\s*\);/i)
  assert.match(sql, /list_deleted_tasks[\s\S]*?private\.is_workspace_member\(p_workspace_id\)/i)
  assert.match(softDelete, /soft_delete_task[\s\S]*?private\.is_workspace_member\(t\.workspace_id\)/i)
  assert.doesNotMatch(sql, /create policy tasks_delete/i)
})

test('permanent deletion is member-guarded and unavailable as a direct table grant', () => {
  assert.match(cleanup, /permanently_delete_task[\s\S]*?private\.is_workspace_member\(t\.workspace_id\)[\s\S]*?for update/i)
  assert.match(cleanup, /delete from public\.tasks where id=p_task_id/i)
  assert.doesNotMatch(sql, /grant delete on public\.(?:tasks|workspaces)/i)
})

test('ordinary members can mutate all retained shared content', () => {
  for (const policy of ['workspaces_update_member','tasks_update_member','labels_update_member','labels_delete_member','task_labels_insert_member','comments_update_member','comments_delete_member']) {
    assert.match(sql, new RegExp(`${policy}[\\s\\S]*?is_workspace_member`, 'i'))
  }
  assert.doesNotMatch(equalMembers, /\brole\s*=|\brole\s*<>|\brole\s+in\s*\(/i)
})

test('retained Realtime tables use full identity while RLS remains enabled', () => {
  for (const table of ['tasks','labels','task_labels','comments','task_assignees','channel_reminders']) {
    assert.match(sql, new RegExp(`alter table public\\.${table} replica identity full`, 'i'))
  }
  assert.doesNotMatch(settings + channel, /disable row level security|\bto anon\b/i)
})

test('task dates are timestamptz and new profiles default to Asia/Shanghai', () => {
  for (const column of ['start_date','start_at','due_date','due_at']) {
    assert.match(sql, new RegExp(`(?:alter column ${column} type|add column(?: if not exists)? ${column}|${column})\\s+timestamptz`, 'i'))
  }
  assert.match(sql, /alter column timezone set default 'Asia\/Shanghai'/i)
  assert.match(sql, /values \(new\.id, v_display_name, 'Asia\/Shanghai'\)/i)
})

test('multi-assignee table has RLS and workspace consistency enforcement', () => {
  assert.match(activity, /create table public\.task_assignees/i)
  assert.match(activity, /alter table public\.task_assignees enable row level security/i)
  assert.match(activity, /force row level security/i)
  assert.match(activity, /task_assignees_select_member[\s\S]*?private\.is_workspace_member\(workspace_id\)/i)
  assert.match(activity, /validate_task_assignee_link[\s\S]*?t\.workspace_id\s*=\s*new\.workspace_id[\s\S]*?wm\.user_id\s*=\s*new\.user_id/i)
})

test('new task RPC accepts assignees only from the selected workspace', () => {
  const create = cleanup.match(/create or replace function public\.create_task_with_channel_reminder_v2[\s\S]*?end \$\$;/i)?.[0] ?? ''
  assert.match(create, /wm\.workspace_id=p_workspace_id and wm\.user_id=a/i)
  assert.match(create, /Every assignee must be a workspace member/i)
})

test('updated task RPC accepts assignees only from the task workspace', () => {
  const update = cleanup.match(/create or replace function public\.update_task_with_channel_reminder_v2[\s\S]*?end \$\$;/i)?.[0] ?? ''
  assert.match(update, /wm\.workspace_id=v_workspace_id and wm\.user_id=a/i)
  assert.match(update, /Every assignee must be a workspace member/i)
})

test('task labels can only reference labels from the task workspace', () => {
  for (const fn of ['create_task_with_channel_reminder_v2','update_task_with_channel_reminder_v2']) {
    const body = cleanup.match(new RegExp(`create or replace function public\\.${fn}[\\s\\S]*?end \\$\\$;`, 'i'))?.[0] ?? ''
    assert.match(body, /join public\.labels l on l\.id=selected\.id and l\.workspace_id=(?:p_workspace_id|v_workspace_id)/i)
  }
  assert.match(sql, /validate_task_label_workspace[\s\S]*?t\.workspace_id = new\.workspace_id/i)
})

test('comments retain author, audit editor, and enforce 1..5000 characters', () => {
  assert.match(activity, /comments add column if not exists updated_by/i)
  assert.match(activity, /new\.updated_by := auth\.uid\(\)/i)
  assert.match(activity, /char_length\(body_md\) between 1 and 5000/i)
  assert.doesNotMatch(activity, /new\.author_id/i)
})

test('profile direct updates are limited to own display_name and timezone', () => {
  assert.match(sql, /profiles_update_self[\s\S]*?id = auth\.uid\(\)[\s\S]*?with check \(id = auth\.uid\(\)\)/i)
  assert.match(cleanup, /grant update\(display_name,timezone\) on public\.profiles to authenticated/i)
  assert.doesNotMatch(cleanup, /grant update\([^)]*must_change_password/i)
})

test('complete_password_change still clears only the caller flag', () => {
  assert.match(settings, /complete_password_change[\s\S]*?set must_change_password = false[\s\S]*?where id = auth\.uid\(\)/i)
  assert.match(settings, /grant execute on function public\.complete_password_change\(\) to authenticated/i)
})

test('channel_reminders RLS requires workspace membership', () => {
  assert.match(channel, /alter table public\.channel_reminders enable row level security/i)
  assert.match(channel, /force row level security/i)
  assert.match(channel, /channel_reminders_select_member[\s\S]*?private\.is_workspace_member\(workspace_id\)/i)
})

test('only service_role can claim due channel reminders', () => {
  assert.match(channel, /for update of r skip locked/i)
  assert.match(channel, /grant execute on function public\.claim_due_channel_reminders\(integer\) to service_role/i)
  assert.doesNotMatch(channel, /grant execute on function public\.claim_due_channel_reminders\(integer\) to (?:anon|authenticated)/i)
})

test('channel reminder cancellation is member-guarded and only affects pending or failed rows', () => {
  assert.match(channel, /cancel_channel_reminder[\s\S]*?status in \('pending','failed'\)[\s\S]*?private\.is_workspace_member\(workspace_id\)/i)
})

test('channel reminder rescheduling validates time, membership, and active task', () => {
  assert.match(channel, /reschedule_channel_reminder[\s\S]*?p_remind_at <= statement_timestamp\(\)/i)
  assert.match(channel, /reschedule_channel_reminder[\s\S]*?private\.is_workspace_member\(r\.workspace_id\)/i)
  assert.match(channel, /reschedule_channel_reminder[\s\S]*?t\.deleted_at is null and t\.status<>'done'/i)
})

test('exported reminders cannot be implicitly changed back to pending', () => {
  assert.match(channel, /set_task_channel_reminder[\s\S]*?when public\.channel_reminders\.status='exported'[\s\S]*?then public\.channel_reminders\.status else 'pending'/i)
  assert.match(channel, /reschedule_channel_reminder[\s\S]*?when r\.status='exported' then r\.status else 'pending'/i)
  assert.match(channel, /reexport_channel_reminder[\s\S]*?status in \('exported','failed'\)[\s\S]*?set status='pending',exported_at=null/i)
})

test('new channel create and update RPCs never call legacy reminder RPCs', () => {
  const bodies = cleanup.match(/create or replace function public\.(?:create|update)_task_with_channel_reminder_v2[\s\S]*?end \$\$;/gi)?.join('\n') ?? ''
  assert.match(bodies, /insert into public\.tasks|update public\.tasks/i)
  assert.doesNotMatch(bodies, /(?:create|update)_task_with_reminders|task_reminders/i)
})

test('permanent task deletion cascades only that task channel reminders', () => {
  assert.match(channel, /task_id uuid not null references public\.tasks \(id\) on delete cascade/i)
  assert.match(cleanup, /permanently_delete_task[\s\S]*?where t\.id=p_task_id[\s\S]*?delete from public\.tasks where id=p_task_id/i)
})

test('cleanup explicitly removes legacy objects without DROP CASCADE', () => {
  assert.match(cleanup, /set lock_timeout = '5s'/i)
  assert.doesNotMatch(cleanup, /drop[\s\S]{0,120}\bcascade\b/i)
  for (const name of ['task_reminders','notification_email_verification_tokens','notification_email_verification_attempts']) {
    assert.match(cleanup, new RegExp(`drop table if exists public\\.${name}`, 'i'))
  }
})

test('reminder feed remains token-protected, GET-only, and uncached', () => {
  assert.match(config, /\[functions\.reminder-feed\][\s\S]*?verify_jwt = false/i)
  assert.doesNotMatch(config, /\[functions\.(?:request-email-verification|verify-notification-email|send-reminders)\]/i)
  assert.match(feedIndex + feed, /REMINDER_FEED_TOKEN/)
  assert.match(feed, /request\.method !== 'GET'/)
  assert.match(feed, /['"]Cache-Control['"]:\s*['"]no-store/i)
  assert.match(feed, /constantTimeTokenEqual/)
})

test('internal navigation contains no full-page reload APIs', async () => {
  const sourceFiles = (await readdir(new URL('../src/', import.meta.url), { recursive: true }))
    .filter((name) => /\.(?:ts|tsx)$/.test(name) && !/\.test\./.test(name))
  for (const name of sourceFiles) {
    const source = await readFile(new URL(`../src/${name.replaceAll('\\', '/')}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /location\.reload\(|window\.location\.(?:href\s*=|assign\()/, name)
    assert.doesNotMatch(source, /<a\s+[^>]*href=["']\//, name)
  }
})
