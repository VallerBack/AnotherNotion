-- Keep task activity reminder mutations member-equal while revalidating the
-- current task and recipient whenever a cancelled/failed reminder is enabled.

create or replace function public.create_task_reminders(
  p_task_id uuid,
  p_recipient_user_ids uuid[],
  p_remind_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_workspace_id uuid;
begin
  select t.workspace_id into v_workspace_id
  from public.tasks t
  where t.id = p_task_id
    and t.deleted_at is null
    and private.is_workspace_member(t.workspace_id)
  for update;

  if v_workspace_id is null then
    raise exception using errcode = 'P0002', message = 'Task not found or workspace access denied';
  end if;
  if p_remind_at is null or p_remind_at <= statement_timestamp() then
    raise exception using errcode = '22023', message = 'Reminder time must be in the future';
  end if;
  if coalesce(pg_catalog.array_length(p_recipient_user_ids, 1), 0) = 0 then
    raise exception using errcode = '22023', message = 'Select at least one reminder recipient';
  end if;
  if exists (
    select 1
    from unnest(p_recipient_user_ids) selected(user_id)
    where not exists (
      select 1
      from public.workspace_members wm
      join public.profiles p on p.id = wm.user_id
      where wm.workspace_id = v_workspace_id
        and wm.user_id = selected.user_id
        and p.notification_email is not null
        and p.notification_email_verified_at is not null
        and p.email_notifications_enabled
    )
  ) then
    raise exception using errcode = '23514', message = 'Reminder recipient is not eligible';
  end if;

  insert into public.task_reminders (
    workspace_id, task_id, recipient_user_id, remind_at, next_attempt_at
  )
  select v_workspace_id, p_task_id, selected.user_id, p_remind_at, p_remind_at
  from (select distinct user_id from unnest(p_recipient_user_ids) selected(user_id)) selected
  on conflict (task_id, recipient_user_id, remind_at)
    where task_id is not null do nothing;
end;
$$;

create or replace function public.reschedule_task_reminder(
  p_reminder_id uuid,
  p_remind_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_remind_at is null or p_remind_at <= statement_timestamp() then
    raise exception using errcode = '22023', message = 'Reminder time must be in the future';
  end if;

  update public.task_reminders r
  set remind_at = p_remind_at,
      status = 'pending',
      attempt_count = 0,
      next_attempt_at = p_remind_at,
      locked_at = null,
      sent_at = null,
      last_error = null
  where r.id = p_reminder_id
    and private.is_workspace_member(r.workspace_id)
    and r.status in ('pending', 'failed', 'cancelled')
    and exists (
      select 1 from public.tasks t
      where t.id = r.task_id
        and t.workspace_id = r.workspace_id
        and t.deleted_at is null
    )
    and exists (
      select 1
      from public.workspace_members wm
      join public.profiles p on p.id = wm.user_id
      where wm.workspace_id = r.workspace_id
        and wm.user_id = r.recipient_user_id
        and p.notification_email is not null
        and p.notification_email_verified_at is not null
        and p.email_notifications_enabled
    );

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Reminder cannot be rescheduled or access was denied';
  end if;
end;
$$;

revoke all on function public.create_task_reminders(uuid, uuid[], timestamptz)
  from public, anon, authenticated;
revoke all on function public.reschedule_task_reminder(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_task_reminders(uuid, uuid[], timestamptz)
  to authenticated;
grant execute on function public.reschedule_task_reminder(uuid, timestamptz)
  to authenticated;

notify pgrst, 'reload schema';
