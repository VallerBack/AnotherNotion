-- Shared task email reminders. Delivery is intentionally left to a later Edge Function.

create type public.task_reminder_status as enum (
  'pending', 'processing', 'sent', 'failed', 'cancelled'
);

create table public.task_reminders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  task_id uuid references public.tasks (id) on delete set null,
  recipient_user_id uuid not null references public.profiles (id) on delete restrict,
  remind_at timestamptz not null,
  status public.task_reminder_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  locked_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task_reminders_delivery_state_check check (
    (status = 'sent' and sent_at is not null)
    or status <> 'sent'
  )
);

create unique index task_reminders_unique_delivery_idx
  on public.task_reminders (task_id, recipient_user_id, remind_at)
  where task_id is not null;
create index task_reminders_workspace_task_idx
  on public.task_reminders (workspace_id, task_id, remind_at);
create index task_reminders_delivery_queue_idx
  on public.task_reminders (next_attempt_at)
  where status in ('pending', 'failed');

create function private.prepare_task_reminder()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.task_id is null then
    raise exception using errcode = '23502', message = 'A new reminder requires a task';
  end if;
  if not exists (
    select 1 from public.tasks as t
    where t.id = new.task_id
      and t.workspace_id = new.workspace_id
      and t.deleted_at is null
  ) then
    raise exception using errcode = '23514', message = 'Reminder task must be active and belong to the workspace';
  end if;
  if not exists (
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
  new.next_attempt_at := coalesce(new.next_attempt_at, new.remind_at);
  return new;
end;
$$;

create trigger task_reminders_prepare
before insert or update of workspace_id, task_id, recipient_user_id, remind_at
on public.task_reminders
for each row execute function private.prepare_task_reminder();
create trigger task_reminders_set_updated_at
before update on public.task_reminders
for each row execute function private.set_updated_at();

create function private.cancel_task_reminders()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    update public.task_reminders
    set status = 'cancelled', locked_at = null, next_attempt_at = null
    where task_id = old.id and status in ('pending', 'processing', 'failed');
    return old;
  elsif old.deleted_at is null and new.deleted_at is not null then
    update public.task_reminders
    set status = 'cancelled', locked_at = null, next_attempt_at = null
    where task_id = old.id and status in ('pending', 'processing', 'failed');
  end if;
  return new;
end;
$$;

create trigger tasks_cancel_reminders_on_delete
before delete or update of deleted_at on public.tasks
for each row execute function private.cancel_task_reminders();

create function public.get_my_profile_preferences()
returns table (
  id uuid,
  display_name text,
  timezone text,
  notification_email text,
  notification_email_verified_at timestamptz,
  email_notifications_enabled boolean,
  must_change_password boolean
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select p.id, p.display_name, p.timezone, p.notification_email,
    p.notification_email_verified_at, p.email_notifications_enabled,
    p.must_change_password
  from public.profiles as p
  where p.id = auth.uid();
$$;

create function public.list_eligible_reminder_recipients(p_workspace_id uuid)
returns table (user_id uuid, display_name text)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select p.id, p.display_name
  from public.workspace_members as wm
  join public.profiles as p on p.id = wm.user_id
  where wm.workspace_id = p_workspace_id
    and private.is_workspace_member(p_workspace_id)
    and p.notification_email is not null
    and p.notification_email_verified_at is not null
    and p.email_notifications_enabled
  order by p.display_name;
$$;

create function public.create_task_reminders(
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
  v_recipient_id uuid;
begin
  select t.workspace_id into v_workspace_id
  from public.tasks as t
  where t.id = p_task_id and t.deleted_at is null
    and private.is_workspace_member(t.workspace_id);
  if v_workspace_id is null then
    raise exception using errcode = 'P0002', message = 'Task not found or workspace access denied';
  end if;
  if p_remind_at is null then
    raise exception using errcode = '22023', message = 'Reminder time is required';
  end if;
  if coalesce(pg_catalog.array_length(p_recipient_user_ids, 1), 0) = 0 then
    raise exception using errcode = '22023', message = 'Select at least one reminder recipient';
  end if;

  foreach v_recipient_id in array p_recipient_user_ids loop
    insert into public.task_reminders (
      workspace_id, task_id, recipient_user_id, remind_at, next_attempt_at
    ) values (
      v_workspace_id, p_task_id, v_recipient_id, p_remind_at, p_remind_at
    )
    on conflict (task_id, recipient_user_id, remind_at)
      where task_id is not null do nothing;
  end loop;
end;
$$;

create function public.cancel_task_reminder(p_reminder_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  update public.task_reminders as r
  set status = 'cancelled', locked_at = null, next_attempt_at = null
  where r.id = p_reminder_id
    and private.is_workspace_member(r.workspace_id)
    and r.status in ('pending', 'processing', 'failed');
  if not found then
    raise exception using errcode = 'P0002', message = 'Reminder not found, already delivered, or access denied';
  end if;
end;
$$;

create function public.reschedule_task_reminder(
  p_reminder_id uuid,
  p_remind_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  update public.task_reminders as r
  set remind_at = p_remind_at, status = 'pending', attempt_count = 0,
      next_attempt_at = p_remind_at, locked_at = null, sent_at = null,
      last_error = null
  where r.id = p_reminder_id
    and private.is_workspace_member(r.workspace_id)
    and r.task_id is not null
    and r.status in ('pending', 'failed', 'cancelled');
  if not found then
    raise exception using errcode = 'P0002', message = 'Reminder cannot be rescheduled or access was denied';
  end if;
end;
$$;

alter table public.task_reminders enable row level security;
alter table public.task_reminders force row level security;
create policy task_reminders_select_member on public.task_reminders
for select to authenticated
using (private.is_workspace_member(workspace_id));

revoke all on public.profiles from authenticated;
grant select (id, display_name, timezone, created_at, updated_at)
  on public.profiles to authenticated;
grant update (display_name, timezone, notification_email, email_notifications_enabled)
  on public.profiles to authenticated;

revoke all on public.task_reminders from public, anon, authenticated;
grant select on public.task_reminders to authenticated;
revoke all on function public.get_my_profile_preferences() from public, anon, authenticated;
revoke all on function public.list_eligible_reminder_recipients(uuid) from public, anon, authenticated;
revoke all on function public.create_task_reminders(uuid, uuid[], timestamptz) from public, anon, authenticated;
revoke all on function public.cancel_task_reminder(uuid) from public, anon, authenticated;
revoke all on function public.reschedule_task_reminder(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.get_my_profile_preferences() to authenticated;
grant execute on function public.list_eligible_reminder_recipients(uuid) to authenticated;
grant execute on function public.create_task_reminders(uuid, uuid[], timestamptz) to authenticated;
grant execute on function public.cancel_task_reminder(uuid) to authenticated;
grant execute on function public.reschedule_task_reminder(uuid, timestamptz) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'task_reminders'
  ) then
    alter publication supabase_realtime add table public.task_reminders;
  end if;
end;
$$;
alter table public.task_reminders replica identity full;

notify pgrst, 'reload schema';
