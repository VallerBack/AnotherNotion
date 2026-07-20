-- Fix permanent task deletion when reminder history is preserved with ON DELETE SET NULL.

create or replace function private.prepare_task_reminder()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_task_association_changed boolean;
  v_recipient_changed boolean;
begin
  v_task_association_changed := tg_op = 'INSERT' or (
    tg_op = 'UPDATE' and (
      new.task_id is distinct from old.task_id
      or new.workspace_id is distinct from old.workspace_id
    )
  );
  v_recipient_changed := tg_op = 'INSERT' or (
    tg_op = 'UPDATE' and (
      new.recipient_user_id is distinct from old.recipient_user_id
      or new.workspace_id is distinct from old.workspace_id
    )
  );

  -- A newly-created reminder must belong to a real active task. An FK-driven
  -- task_id = NULL update during permanent deletion is historical detachment,
  -- not creation or reassignment, and must remain valid.
  if tg_op = 'INSERT' and new.task_id is null then
    raise exception using errcode = '23502', message = 'A new reminder requires a task';
  end if;

  if v_task_association_changed and new.task_id is not null and not exists (
    select 1 from public.tasks as t
    where t.id = new.task_id
      and t.workspace_id = new.workspace_id
      and t.deleted_at is null
  ) then
    raise exception using errcode = '23514', message = 'Reminder task must be active and belong to the workspace';
  end if;

  if v_recipient_changed and not exists (
    select 1
    from public.workspace_members as wm
    join public.profiles as p on p.id = wm.user_id
    where wm.workspace_id = new.workspace_id
      and wm.user_id = new.recipient_user_id
      and p.notification_email is not null
      and p.notification_email_verified_at is not null
      and p.email_notifications_enabled
  ) then
    raise exception using errcode = '23514', message = 'Reminder recipient must be an eligible workspace member';
  end if;

  if tg_op = 'INSERT' then
    new.next_attempt_at := coalesce(new.next_attempt_at, new.remind_at);
  end if;
  return new;
end;
$$;

create or replace function public.permanently_delete_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_workspace_id uuid;
begin
  select t.workspace_id into v_workspace_id
  from public.tasks as t
  where t.id = p_task_id
    and t.deleted_at is not null
    and private.is_workspace_member(t.workspace_id)
  for update;

  if v_workspace_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Deleted task not found or workspace access denied';
  end if;

  -- The existing BEFORE DELETE trigger cancels undelivered reminders. The
  -- task_id FK then uses ON DELETE SET NULL to retain only this task's history.
  delete from public.tasks where id = p_task_id;
end;
$$;

revoke all on function public.permanently_delete_task(uuid)
  from public, anon, authenticated;
grant execute on function public.permanently_delete_task(uuid) to authenticated;

notify pgrst, 'reload schema';
