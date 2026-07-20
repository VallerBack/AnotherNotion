-- Atomic task/editor writes and a privacy-preserving recipient capability list.

create function public.list_reminder_recipient_capabilities(p_workspace_id uuid)
returns table (user_id uuid, display_name text, can_receive_email boolean)
language sql stable security definer set search_path = pg_catalog
as $$
  select p.id, p.display_name,
    p.notification_email is not null
      and p.notification_email_verified_at is not null
      and p.email_notifications_enabled
  from public.workspace_members wm
  join public.profiles p on p.id = wm.user_id
  where wm.workspace_id = p_workspace_id
    and private.is_workspace_member(p_workspace_id)
  order by p.display_name;
$$;

create function private.task_reminder_anchor(
  p_schedule_kind public.task_schedule_kind,
  p_start_date timestamptz, p_start_at timestamptz,
  p_due_date timestamptz, p_due_at timestamptz
)
returns timestamptz language sql immutable set search_path = pg_catalog
as $$
  select case p_schedule_kind
    when 'timed' then coalesce(p_start_at, p_due_at)
    when 'all_day' then coalesce(p_start_date, p_due_date)
    else null
  end;
$$;

create function private.upsert_task_editor_reminders(
  p_workspace_id uuid, p_task_id uuid, p_recipient_ids uuid[],
  p_remind_at timestamptz, p_anchor timestamptz
)
returns void language plpgsql security definer set search_path = pg_catalog
as $$
declare v_recipient uuid;
begin
  if p_remind_at is null or coalesce(array_length(p_recipient_ids, 1), 0) = 0 then
    return;
  end if;
  if p_anchor is null then
    raise exception using errcode = '22023', message = 'A dated task is required for email reminders';
  end if;
  if p_remind_at > p_anchor then
    raise exception using errcode = '22023', message = 'Reminder time cannot be later than the task start or due time';
  end if;
  foreach v_recipient in array p_recipient_ids loop
    insert into public.task_reminders (
      workspace_id, task_id, recipient_user_id, remind_at, status, next_attempt_at
    ) values (
      p_workspace_id, p_task_id, v_recipient, p_remind_at, 'pending', p_remind_at
    )
    on conflict (task_id, recipient_user_id, remind_at) where task_id is not null
    do update set
      status = case when task_reminders.status = 'sent' then 'sent'::public.task_reminder_status else 'pending'::public.task_reminder_status end,
      attempt_count = case when task_reminders.status = 'sent' then task_reminders.attempt_count else 0 end,
      next_attempt_at = case when task_reminders.status = 'sent' then null else excluded.remind_at end,
      locked_at = null,
      last_error = case when task_reminders.status = 'sent' then task_reminders.last_error else null end;
  end loop;
end;
$$;

create function public.create_task_with_reminders(
  p_workspace_id uuid, p_task jsonb, p_label_ids uuid[],
  p_recipient_user_ids uuid[], p_remind_at timestamptz
)
returns uuid language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_task_id uuid;
  v_kind public.task_schedule_kind := (p_task->>'schedule_kind')::public.task_schedule_kind;
  v_start_date timestamptz := nullif(p_task->>'start_date', '')::timestamptz;
  v_start_at timestamptz := nullif(p_task->>'start_at', '')::timestamptz;
  v_due_date timestamptz := nullif(p_task->>'due_date', '')::timestamptz;
  v_due_at timestamptz := nullif(p_task->>'due_at', '')::timestamptz;
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception using errcode = '42501', message = 'Workspace membership required';
  end if;
  insert into public.tasks (
    workspace_id, title, description_md, status, priority, assignee_id,
    schedule_kind, start_date, start_at, due_date, due_at, created_by
  ) values (
    p_workspace_id, btrim(p_task->>'title'), coalesce(p_task->>'description_md', ''),
    coalesce((p_task->>'status')::public.task_status, 'todo'),
    coalesce((p_task->>'priority')::public.task_priority, 'medium'),
    nullif(p_task->>'assignee_id', '')::uuid, v_kind,
    v_start_date, v_start_at, v_due_date, v_due_at, auth.uid()
  ) returning id into v_task_id;

  insert into public.task_labels (task_id, label_id, workspace_id)
  select v_task_id, l.id, p_workspace_id
  from unnest(coalesce(p_label_ids, array[]::uuid[])) selected(id)
  join public.labels l on l.id = selected.id and l.workspace_id = p_workspace_id;

  if coalesce((p_task->>'status')::public.task_status, 'todo') <> 'done' then
    perform private.upsert_task_editor_reminders(
      p_workspace_id, v_task_id, p_recipient_user_ids, p_remind_at,
      private.task_reminder_anchor(v_kind, v_start_date, v_start_at, v_due_date, v_due_at)
    );
  end if;
  return v_task_id;
end;
$$;

create function public.update_task_with_reminders(
  p_task_id uuid, p_task jsonb, p_label_ids uuid[],
  p_recipient_user_ids uuid[], p_remind_at timestamptz
)
returns void language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_workspace_id uuid;
  v_kind public.task_schedule_kind := (p_task->>'schedule_kind')::public.task_schedule_kind;
  v_status public.task_status := (p_task->>'status')::public.task_status;
  v_start_date timestamptz := nullif(p_task->>'start_date', '')::timestamptz;
  v_start_at timestamptz := nullif(p_task->>'start_at', '')::timestamptz;
  v_due_date timestamptz := nullif(p_task->>'due_date', '')::timestamptz;
  v_due_at timestamptz := nullif(p_task->>'due_at', '')::timestamptz;
begin
  select t.workspace_id into v_workspace_id from public.tasks t
  where t.id = p_task_id and t.deleted_at is null
    and private.is_workspace_member(t.workspace_id) for update;
  if v_workspace_id is null then
    raise exception using errcode = 'P0002', message = 'Task not found or workspace access denied';
  end if;
  update public.tasks set
    title = btrim(p_task->>'title'), description_md = coalesce(p_task->>'description_md', ''),
    status = v_status, priority = (p_task->>'priority')::public.task_priority,
    assignee_id = nullif(p_task->>'assignee_id', '')::uuid,
    schedule_kind = v_kind, start_date = v_start_date, start_at = v_start_at,
    due_date = v_due_date, due_at = v_due_at
  where id = p_task_id;

  delete from public.task_labels where task_id = p_task_id;
  insert into public.task_labels (task_id, label_id, workspace_id)
  select p_task_id, l.id, v_workspace_id
  from unnest(coalesce(p_label_ids, array[]::uuid[])) selected(id)
  join public.labels l on l.id = selected.id and l.workspace_id = v_workspace_id;

  update public.task_reminders set status = 'cancelled', locked_at = null, next_attempt_at = null
  where task_id = p_task_id and status in ('pending', 'processing', 'failed');
  if v_status <> 'done' then
    perform private.upsert_task_editor_reminders(
      v_workspace_id, p_task_id, p_recipient_user_ids, p_remind_at,
      private.task_reminder_anchor(v_kind, v_start_date, v_start_at, v_due_date, v_due_at)
    );
  end if;
end;
$$;

create function private.cancel_reminders_when_task_completed()
returns trigger language plpgsql security definer set search_path = pg_catalog
as $$
begin
  if old.status <> 'done' and new.status = 'done' then
    update public.task_reminders set status = 'cancelled', locked_at = null, next_attempt_at = null
    where task_id = new.id and status in ('pending', 'processing', 'failed');
  end if;
  return new;
end;
$$;
create trigger tasks_cancel_reminders_on_completion
after update of status on public.tasks
for each row execute function private.cancel_reminders_when_task_completed();

revoke all on function public.list_reminder_recipient_capabilities(uuid) from public, anon, authenticated;
revoke all on function public.create_task_with_reminders(uuid, jsonb, uuid[], uuid[], timestamptz) from public, anon, authenticated;
revoke all on function public.update_task_with_reminders(uuid, jsonb, uuid[], uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.list_reminder_recipient_capabilities(uuid) to authenticated;
grant execute on function public.create_task_with_reminders(uuid, jsonb, uuid[], uuid[], timestamptz) to authenticated;
grant execute on function public.update_task_with_reminders(uuid, jsonb, uuid[], uuid[], timestamptz) to authenticated;

notify pgrst, 'reload schema';
