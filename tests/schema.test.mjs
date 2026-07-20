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
const remindersSql = await readFile(
  new URL('20260720000400_task_email_reminders.sql', migrationsUrl),
  'utf8',
)
const deliverySql = await readFile(
  new URL('20260720000500_email_verification_and_delivery_queue.sql', migrationsUrl),
  'utf8',
)
const atomicReminderEditorSql = await readFile(
  new URL('20260720000600_atomic_task_reminder_editor.sql', migrationsUrl),
  'utf8',
)
const reminderDeletionFixSql = await readFile(
  new URL('20260720000700_fix_permanent_task_deletion_reminders.sql', migrationsUrl),
  'utf8',
)
const defaultTimezoneSql = await readFile(
  new URL('20260720000800_default_profile_timezone.sql', migrationsUrl),
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
  'task_reminders',
  'notification_email_verification_tokens',
  'notification_email_verification_attempts',
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

test('new profiles default to Asia/Shanghai without rewriting existing profiles', () => {
  assert.match(defaultTimezoneSql, /alter column timezone set default 'Asia\/Shanghai'/i)
  assert.match(defaultTimezoneSql, /values \(new\.id, v_display_name, 'Asia\/Shanghai'\)/i)
  assert.doesNotMatch(defaultTimezoneSql, /update public\.profiles/i)
  assert.match(defaultTimezoneSql, /security definer[\s\S]*?set search_path = pg_catalog/i)
})

test('task reminders are unique, UTC-capable, member-managed, and never granted to anon', () => {
  assert.match(remindersSql, /create table public\.task_reminders/i)
  assert.match(remindersSql, /remind_at timestamptz not null/i)
  assert.match(remindersSql, /unique index task_reminders_unique_delivery_idx[\s\S]*?task_id, recipient_user_id, remind_at/i)
  assert.match(remindersSql, /task_reminders_select_member[\s\S]*?private\.is_workspace_member\(workspace_id\)/i)
  assert.match(remindersSql, /create function public\.create_task_reminders[\s\S]*?private\.is_workspace_member\(t\.workspace_id\)/i)
  assert.doesNotMatch(remindersSql, /\bto anon\b/i)
})

test('reminder recipients must have verified enabled notification email', () => {
  assert.match(remindersSql, /notification_email_verified_at is not null/i)
  assert.match(remindersSql, /p\.email_notifications_enabled/i)
  assert.match(remindersSql, /Reminder recipient must be an eligible workspace member/i)
})

test('task deletion cancels undelivered reminders and preserves delivery history', () => {
  assert.match(remindersSql, /references public\.tasks \(id\) on delete set null/i)
  assert.match(remindersSql, /tasks_cancel_reminders_on_delete[\s\S]*?before delete or update of deleted_at/i)
  assert.match(remindersSql, /status = 'cancelled'[\s\S]*?status in \('pending', 'processing', 'failed'\)/i)
})

test('permanent deletion accepts an old trashed task without reminders', () => {
  assert.match(reminderDeletionFixSql, /where t\.id = p_task_id[\s\S]*?t\.deleted_at is not null/i)
  assert.match(reminderDeletionFixSql, /delete from public\.tasks where id = p_task_id/i)
})

test('permanent deletion cancels pending reminders before detaching their history', () => {
  assert.match(remindersSql, /if tg_op = 'DELETE'[\s\S]*?status = 'cancelled'[\s\S]*?status in \('pending', 'processing', 'failed'\)/i)
  assert.match(remindersSql, /before delete or update of deleted_at on public\.tasks/i)
  assert.match(remindersSql, /references public\.tasks \(id\) on delete set null/i)
})

test('cancelled reminder history does not block permanent deletion', () => {
  assert.match(reminderDeletionFixSql, /v_task_association_changed and new\.task_id is not null/i)
  assert.match(reminderDeletionFixSql, /if tg_op = 'INSERT' and new\.task_id is null then[\s\S]*?A new reminder requires a task/i)
  assert.doesNotMatch(reminderDeletionFixSql, /if tg_op = 'UPDATE' and new\.task_id is null then/i)
})

test('sent reminder history does not block permanent deletion', () => {
  assert.match(remindersSql, /status in \('pending', 'processing', 'failed'\)/i)
  assert.doesNotMatch(remindersSql, /status in \([^)]*'sent'/i)
  assert.match(reminderDeletionFixSql, /task_id = NULL update during permanent deletion is historical detachment/i)
})

test('soft deletion cancels pending reminders even after the task becomes trashed', () => {
  assert.match(remindersSql, /old\.deleted_at is null and new\.deleted_at is not null[\s\S]*?status = 'cancelled'/i)
  assert.match(reminderDeletionFixSql, /v_task_association_changed := tg_op = 'INSERT' or/i)
})

test('deleting one task only changes reminders associated with that task', () => {
  assert.match(remindersSql, /where task_id = old\.id and status in \('pending', 'processing', 'failed'\)/i)
  assert.match(remindersSql, /task_id uuid references public\.tasks \(id\) on delete set null/i)
})

test('ordinary workspace members can permanently delete in one guarded transaction', () => {
  assert.match(reminderDeletionFixSql, /private\.is_workspace_member\(t\.workspace_id\)/i)
  assert.doesNotMatch(reminderDeletionFixSql, /\brole\b|owner|admin/i)
  assert.match(reminderDeletionFixSql, /for update/i)
  assert.match(reminderDeletionFixSql, /grant execute on function public\.permanently_delete_task\(uuid\) to authenticated/i)
  assert.doesNotMatch(reminderDeletionFixSql, /disable row level security|\bto anon\b/i)
})

test('notification email is readable only through the current-user preferences function', () => {
  assert.match(remindersSql, /revoke all on public\.profiles from authenticated/i)
  assert.match(remindersSql, /grant select \(id, display_name, timezone, created_at, updated_at\)/i)
  assert.match(remindersSql, /get_my_profile_preferences[\s\S]*?where p\.id = auth\.uid\(\)/i)
  assert.doesNotMatch(remindersSql, /grant select \([^)]*notification_email/i)
})

test('verification tokens are hashed, expiring, one-time, rate limited, and atomically consumed', () => {
  assert.match(deliverySql, /token_hash text not null unique/i)
  assert.match(deliverySql, /interval '30 minutes'/i)
  assert.match(deliverySql, /created_at > statement_timestamp\(\) - interval '1 minute'/i)
  assert.match(deliverySql, />= 5/i)
  assert.match(deliverySql, /for update/i)
  assert.match(deliverySql, /set used_at = statement_timestamp\(\)/i)
  assert.doesNotMatch(deliverySql, /grant .*notification_email_verification_tokens.*authenticated/i)
})

test('reminder worker claims atomically with bounded skip-locked retries', () => {
  assert.match(deliverySql, /create function public\.claim_due_task_reminders/i)
  assert.match(deliverySql, /for update skip locked/i)
  assert.match(deliverySql, /limit least\(greatest\(p_limit, 1\), 50\)/i)
  assert.match(deliverySql, /locked_at < statement_timestamp\(\) - interval '10 minutes'/i)
  assert.match(deliverySql, /pg_catalog\.power\(2, attempt_count\)/i)
  assert.match(deliverySql, /attempt_count >= 5/i)
})

test('edge functions implement auth boundaries, CORS, hashing, Brevo, and dry-run safety', async () => {
  const root = new URL('../supabase/functions/', import.meta.url)
  const requestFunction = await readFile(new URL('request-email-verification/index.ts', root), 'utf8')
  const verifyFunction = await readFile(new URL('verify-notification-email/index.ts', root), 'utf8')
  const sendFunction = await readFile(new URL('send-reminders/index.ts', root), 'utf8')
  const provider = await readFile(new URL('_shared/brevo.ts', root), 'utf8')
  const config = await readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8')
  assert.match(requestFunction, /auth\.getUser\(\)/)
  assert.match(requestFunction, /randomToken\(32\)/)
  assert.match(verifyFunction, /sha256\(token\)/)
  assert.match(sendFunction, /x-cron-secret/)
  assert.match(sendFunction, /claim_due_task_reminders/)
  assert.match(sendFunction, /recipient_timezone \|\| 'Asia\/Shanghai'/)
  assert.match(deliverySql, /coalesce\(r\.next_attempt_at, r\.remind_at\) <= statement_timestamp\(\)/i)
  assert.match(provider, /https:\/\/api\.brevo\.com\/v3\/smtp\/email/)
  assert.match(provider, /EMAIL_DRY_RUN/)
  assert.match(provider, /Idempotency-Key/)
  assert.ok(provider.indexOf("if (dryRun)") < provider.indexOf("fetch('https://api.brevo.com"))
  assert.match(sendFunction, /if \(result\.dryRun\) \{[\s\S]*?release_dry_run_task_reminder[\s\S]*?\} else \{[\s\S]*?mark_task_reminder_sent/)
  assert.match(config, /\[functions\.request-email-verification\][\s\S]*?verify_jwt = true/)
  assert.match(config, /\[functions\.verify-notification-email\][\s\S]*?verify_jwt = false/)
  assert.match(config, /\[functions\.send-reminders\][\s\S]*?verify_jwt = false/)
})

test('task editor uses privacy-safe recipients and atomic task/reminder RPCs', () => {
  assert.match(atomicReminderEditorSql, /returns table \(user_id uuid, display_name text, can_receive_email boolean\)/i)
  assert.doesNotMatch(atomicReminderEditorSql, /returns table \([^)]*notification_email/i)
  assert.match(atomicReminderEditorSql, /create function public\.create_task_with_reminders/i)
  assert.match(atomicReminderEditorSql, /create function public\.update_task_with_reminders/i)
  assert.match(atomicReminderEditorSql, /status = 'cancelled'[\s\S]*?status in \('pending', 'processing', 'failed'\)/i)
  assert.match(atomicReminderEditorSql, /old\.status <> 'done' and new\.status = 'done'/i)
  assert.match(atomicReminderEditorSql, /p_remind_at > p_anchor/i)
})

test('reminder verification script is read-only', async () => {
  const verification = await readFile(new URL('../scripts/verify_reminders.sql', import.meta.url), 'utf8')
  assert.match(verification, /^\s*select\b/i)
  assert.doesNotMatch(verification, /\b(insert|update|delete|drop|truncate|alter|create)\b/i)
})
