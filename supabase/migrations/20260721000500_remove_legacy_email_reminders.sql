-- Remove the retired notification-email and per-recipient email reminder system.
-- Channel reminders and their feed are intentionally preserved.

set lock_timeout = '5s';
set statement_timeout = '60s';

-- Decouple channel task writes from the legacy email editor RPCs before those
-- RPCs are removed. These replacements keep the same public signatures.
create or replace function public.create_task_with_channel_reminder_v2(
  p_workspace_id uuid, p_task jsonb, p_label_ids uuid[], p_assignee_ids uuid[],
  p_remind_at timestamptz
) returns uuid language plpgsql security definer set search_path = pg_catalog as $$
declare
  v_task_id uuid;
  v_kind public.task_schedule_kind := coalesce((p_task->>'schedule_kind')::public.task_schedule_kind, 'none');
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception using errcode='42501', message='Workspace membership required';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_assignee_ids, array[]::uuid[])) a
    where not exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id=p_workspace_id and wm.user_id=a
    )
  ) then
    raise exception using errcode='23514', message='Every assignee must be a workspace member';
  end if;

  insert into public.tasks (
    workspace_id,title,description_md,status,priority,assignee_id,schedule_kind,
    start_date,start_at,due_date,due_at,created_by
  ) values (
    p_workspace_id,btrim(p_task->>'title'),coalesce(p_task->>'description_md',''),
    coalesce((p_task->>'status')::public.task_status,'todo'),
    coalesce((p_task->>'priority')::public.task_priority,'medium'),
    p_assignee_ids[1],v_kind,
    nullif(p_task->>'start_date','')::timestamptz,
    nullif(p_task->>'start_at','')::timestamptz,
    nullif(p_task->>'due_date','')::timestamptz,
    nullif(p_task->>'due_at','')::timestamptz,auth.uid()
  ) returning id into v_task_id;

  insert into public.task_labels(task_id,label_id,workspace_id)
  select v_task_id,l.id,p_workspace_id
  from unnest(coalesce(p_label_ids,array[]::uuid[])) selected(id)
  join public.labels l on l.id=selected.id and l.workspace_id=p_workspace_id;

  delete from public.task_assignees where task_id=v_task_id;
  insert into public.task_assignees(task_id,user_id,workspace_id,assigned_by)
  select v_task_id,a,p_workspace_id,auth.uid()
  from (select distinct unnest(coalesce(p_assignee_ids,array[]::uuid[])) a) selected;

  if p_remind_at is not null
     and coalesce((p_task->>'status')::public.task_status,'todo') <> 'done' then
    perform public.set_task_channel_reminder(v_task_id,p_remind_at);
  end if;
  return v_task_id;
end $$;

create or replace function public.update_task_with_channel_reminder_v2(
  p_task_id uuid, p_task jsonb, p_label_ids uuid[], p_assignee_ids uuid[],
  p_remind_at timestamptz
) returns void language plpgsql security definer set search_path = pg_catalog as $$
declare
  v_workspace_id uuid;
  v_status public.task_status := (p_task->>'status')::public.task_status;
begin
  select t.workspace_id into v_workspace_id from public.tasks t
  where t.id=p_task_id and t.deleted_at is null
    and private.is_workspace_member(t.workspace_id) for update;
  if v_workspace_id is null then
    raise exception using errcode='P0002', message='Task not found or workspace access denied';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_assignee_ids,array[]::uuid[])) a
    where not exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id=v_workspace_id and wm.user_id=a
    )
  ) then
    raise exception using errcode='23514', message='Every assignee must be a workspace member';
  end if;

  update public.tasks set
    title=btrim(p_task->>'title'),description_md=coalesce(p_task->>'description_md',''),
    status=v_status,priority=(p_task->>'priority')::public.task_priority,
    assignee_id=p_assignee_ids[1],
    schedule_kind=(p_task->>'schedule_kind')::public.task_schedule_kind,
    start_date=nullif(p_task->>'start_date','')::timestamptz,
    start_at=nullif(p_task->>'start_at','')::timestamptz,
    due_date=nullif(p_task->>'due_date','')::timestamptz,
    due_at=nullif(p_task->>'due_at','')::timestamptz
  where id=p_task_id;

  delete from public.task_labels where task_id=p_task_id;
  insert into public.task_labels(task_id,label_id,workspace_id)
  select p_task_id,l.id,v_workspace_id
  from unnest(coalesce(p_label_ids,array[]::uuid[])) selected(id)
  join public.labels l on l.id=selected.id and l.workspace_id=v_workspace_id;

  delete from public.task_assignees where task_id=p_task_id;
  insert into public.task_assignees(task_id,user_id,workspace_id,assigned_by)
  select p_task_id,a,v_workspace_id,auth.uid()
  from (select distinct unnest(coalesce(p_assignee_ids,array[]::uuid[])) a) selected;

  update public.channel_reminders set status='cancelled'
  where task_id=p_task_id and status in ('pending','failed')
    and (p_remind_at is null or remind_at<>p_remind_at or v_status='done');
  if p_remind_at is not null and v_status<>'done' then
    perform public.set_task_channel_reminder(p_task_id,p_remind_at);
  end if;
end $$;

create or replace function public.permanently_delete_task(p_task_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare v_workspace_id uuid;
begin
  select t.workspace_id into v_workspace_id from public.tasks t
  where t.id=p_task_id and t.deleted_at is not null
    and private.is_workspace_member(t.workspace_id) for update;
  if v_workspace_id is null then
    raise exception using errcode='P0002', message='Deleted task not found or workspace access denied';
  end if;
  delete from public.tasks where id=p_task_id;
end $$;

-- Remove triggers before their functions and tables.
drop trigger if exists tasks_cancel_reminders_on_delete on public.tasks;
drop trigger if exists tasks_cancel_reminders_on_completion on public.tasks;
drop trigger if exists profiles_prepare_preferences on public.profiles;
drop trigger if exists task_reminders_prepare on public.task_reminders;
drop trigger if exists task_reminders_set_updated_at on public.task_reminders;

-- Legacy public task-reminder RPCs.
drop function if exists public.list_eligible_reminder_recipients(uuid);
drop function if exists public.list_reminder_recipient_capabilities(uuid);
drop function if exists public.create_task_reminders(uuid,uuid[],timestamptz);
drop function if exists public.cancel_task_reminder(uuid);
drop function if exists public.reschedule_task_reminder(uuid,timestamptz);
drop function if exists public.create_task_with_reminders(uuid,jsonb,uuid[],uuid[],timestamptz);
drop function if exists public.update_task_with_reminders(uuid,jsonb,uuid[],uuid[],timestamptz);
drop function if exists public.create_task_with_reminders_v2(uuid,jsonb,uuid[],uuid[],uuid[],timestamptz);
drop function if exists public.update_task_with_reminders_v2(uuid,jsonb,uuid[],uuid[],uuid[],timestamptz);
drop function if exists public.claim_due_task_reminders(integer);
drop function if exists public.mark_task_reminder_sent(uuid);
drop function if exists public.mark_task_reminder_failed(uuid,text);
drop function if exists public.release_dry_run_task_reminder(uuid);

-- Legacy notification-email verification RPCs.
drop function if exists public.issue_notification_email_verification(text);
drop function if exists public.consume_notification_email_verification(text,text);
drop function if exists public.consume_notification_email_verification_v2(text,text);
drop function if exists public.mark_notification_email_verification_delivered(text);
drop function if exists public.cancel_notification_email_verification_issue(text);

-- Private helpers have no remaining callers after the public RPCs above.
drop function if exists private.prepare_task_reminder();
drop function if exists private.cancel_task_reminders();
drop function if exists private.cancel_reminders_when_task_completed();
drop function if exists private.task_reminder_anchor(public.task_schedule_kind,timestamptz,timestamptz,timestamptz,timestamptz);
drop function if exists private.upsert_task_editor_reminders(uuid,uuid,uuid[],timestamptz,timestamptz);
drop function if exists private.prepare_profile_preferences();

-- Remove explicit table-owned objects before dropping their tables. Identity
-- sequences owned by the verification attempt table are removed with that table.
drop policy if exists task_reminders_select_member on public.task_reminders;
drop index if exists public.task_reminders_unique_delivery_idx;
drop index if exists public.task_reminders_workspace_task_idx;
drop index if exists public.task_reminders_delivery_queue_idx;
drop index if exists public.notification_email_verification_user_created_idx;
drop index if exists public.notification_email_verification_attempts_rate_idx;
drop index if exists public.notification_email_verification_delivery_rate_idx;

drop table if exists public.notification_email_verification_attempts;
drop table if exists public.notification_email_verification_tokens;
drop table if exists public.task_reminders;
drop type if exists public.task_reminder_status;

-- Recreate the profile preferences RPC with only retained account fields before
-- dropping the old columns, because PostgreSQL cannot change OUT columns in place.
drop function if exists public.get_my_profile_preferences();
alter table public.profiles drop constraint if exists profiles_notification_email_check;
alter table public.profiles drop constraint if exists profiles_notification_enabled_check;
alter table public.profiles
  drop column if exists notification_email,
  drop column if exists notification_email_verified_at,
  drop column if exists email_notifications_enabled;

create function public.get_my_profile_preferences()
returns table(id uuid,display_name text,timezone text,must_change_password boolean)
language sql stable security definer set search_path = pg_catalog as $$
  select p.id,p.display_name,p.timezone,p.must_change_password
  from public.profiles p where p.id=auth.uid();
$$;
revoke all on function public.get_my_profile_preferences() from public,anon,authenticated;
grant execute on function public.get_my_profile_preferences() to authenticated;

revoke update on public.profiles from authenticated;
grant update(display_name,timezone) on public.profiles to authenticated;

notify pgrst,'reload schema';
