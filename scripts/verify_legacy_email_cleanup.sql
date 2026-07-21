-- Read-only checks to run after applying 20260721000500_remove_legacy_email_reminders.sql.
-- Every row should return true. This script does not change application data.
begin transaction read only;

select 'retained tables exist' as check_name,
  array['profiles','workspaces','workspace_members','tasks','labels','task_labels','comments','task_assignees','channel_reminders']
  <@ array(select tablename::text from pg_catalog.pg_tables where schemaname='public') as passed;

select 'legacy tables removed' as check_name,
  not exists (
    select 1 from pg_catalog.pg_tables
    where schemaname='public' and tablename in (
      'task_reminders','notification_email_verification_tokens','notification_email_verification_attempts'
    )
  ) as passed;

select 'legacy profile columns removed' as check_name,
  not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='profiles'
      and column_name in ('notification_email','notification_email_verified_at','email_notifications_enabled')
  ) as passed;

select 'retained tables have forced RLS' as check_name,
  count(*)=9 as passed
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in (
  'profiles','workspaces','workspace_members','tasks','labels','task_labels','comments','task_assignees','channel_reminders'
) and c.relrowsecurity and c.relforcerowsecurity;

select 'anon has no retained-table write or read grants' as check_name,
  not exists (
    select 1 from information_schema.role_table_grants
    where grantee='anon' and table_schema='public'
      and table_name in ('profiles','workspaces','workspace_members','tasks','labels','task_labels','comments','task_assignees','channel_reminders')
      and privilege_type in ('SELECT','INSERT','UPDATE','DELETE')
  ) as passed;

select 'channel RPCs retained' as check_name,
  array[
    'public.set_task_channel_reminder(uuid,timestamp with time zone)',
    'public.cancel_channel_reminder(uuid)',
    'public.reschedule_channel_reminder(uuid,timestamp with time zone)',
    'public.reexport_channel_reminder(uuid)',
    'public.claim_due_channel_reminders(integer)',
    'public.create_task_with_channel_reminder_v2(uuid,jsonb,uuid[],uuid[],timestamp with time zone)',
    'public.update_task_with_channel_reminder_v2(uuid,jsonb,uuid[],uuid[],timestamp with time zone)'
  ] <@ array(select p.oid::regprocedure::text from pg_catalog.pg_proc p) as passed;

select 'legacy RPCs removed' as check_name,
  not exists (
    select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.proname in (
      'create_task_reminders','cancel_task_reminder','reschedule_task_reminder',
      'claim_due_task_reminders','issue_notification_email_verification',
      'consume_notification_email_verification','consume_notification_email_verification_v2'
    )
  ) as passed;

select 'claim RPC service_role-only' as check_name,
  has_function_privilege('service_role','public.claim_due_channel_reminders(integer)','EXECUTE')
  and not has_function_privilege('anon','public.claim_due_channel_reminders(integer)','EXECUTE')
  and not has_function_privilege('authenticated','public.claim_due_channel_reminders(integer)','EXECUTE') as passed;

select 'task delete cascades channel reminders' as check_name,
  exists (
    select 1 from pg_catalog.pg_constraint c
    where c.conrelid='public.channel_reminders'::regclass
      and c.confrelid='public.tasks'::regclass
      and c.contype='f' and c.confdeltype='c'
  ) as passed;

select 'profile preferences retain account fields' as check_name,
  to_regprocedure('public.get_my_profile_preferences()') is not null
  and to_regprocedure('public.complete_password_change()') is not null as passed;

rollback;
