-- Account preferences, UTC timestamps, and realtime for the single shared workspace.

alter table public.profiles
  add column if not exists notification_email text,
  add column if not exists notification_email_verified_at timestamptz,
  add column if not exists email_notifications_enabled boolean not null default false,
  add column if not exists must_change_password boolean not null default false;

alter table public.profiles
  add constraint profiles_notification_email_check check (
    notification_email is null
    or (
      notification_email = btrim(notification_email)
      and char_length(notification_email) between 3 and 320
      and notification_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  ),
  add constraint profiles_notification_enabled_check check (
    not email_notifications_enabled or notification_email is not null
  );

-- All stored schedule values are UTC timestamptz. All-day values use UTC midnight;
-- clients treat their YYYY-MM-DD prefix as a calendar date, never as an instant.
alter table public.tasks drop constraint if exists tasks_schedule_check;
alter table public.tasks
  alter column start_date type timestamptz
    using (start_date::timestamp at time zone 'UTC'),
  alter column due_date type timestamptz
    using (due_date::timestamp at time zone 'UTC');
alter table public.tasks add constraint tasks_schedule_check check (
  (schedule_kind = 'none' and start_date is null and start_at is null and due_date is null and due_at is null)
  or (schedule_kind = 'all_day' and start_at is null and due_at is null
      and (start_date is not null or due_date is not null)
      and (start_date is null or due_date is null or start_date <= due_date))
  or (schedule_kind = 'timed' and start_date is null and due_date is null
      and (start_at is not null or due_at is not null)
      and (start_at is null or due_at is null or start_at <= due_at))
);

create or replace function private.prepare_profile_preferences()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.notification_email is distinct from old.notification_email then
    new.notification_email := nullif(lower(btrim(new.notification_email)), '');
    new.notification_email_verified_at := null;
    if new.notification_email is null then
      new.email_notifications_enabled := false;
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_prepare_preferences
before update of notification_email on public.profiles
for each row execute function private.prepare_profile_preferences();

create or replace function public.complete_password_change()
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  update public.profiles
  set must_change_password = false
  where id = auth.uid();
  if not found then
    raise exception using errcode = 'P0002', message = 'Profile not found';
  end if;
end;
$$;

revoke update on public.profiles from authenticated;
grant update (display_name, timezone, notification_email, email_notifications_enabled)
  on public.profiles to authenticated;
revoke all on function public.complete_password_change() from public, anon, authenticated;
grant execute on function public.complete_password_change() to authenticated;

-- Realtime changes are still filtered through each subscriber's RLS policies.
do $$
declare
  v_table text;
begin
  foreach v_table in array array['tasks', 'labels', 'task_labels', 'comments'] loop
    if not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end;
$$;

alter table public.tasks replica identity full;
alter table public.labels replica identity full;
alter table public.task_labels replica identity full;
alter table public.comments replica identity full;

notify pgrst, 'reload schema';
