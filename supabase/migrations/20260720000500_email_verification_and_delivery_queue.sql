create table public.notification_email_verification_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  notification_email text not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz not null default now()
);

create index notification_email_verification_user_created_idx
  on public.notification_email_verification_tokens (user_id, created_at desc);

create table public.notification_email_verification_attempts (
  id bigint generated always as identity primary key,
  attempt_key text not null,
  attempted_at timestamptz not null default now()
);
create index notification_email_verification_attempts_rate_idx
  on public.notification_email_verification_attempts (attempt_key, attempted_at desc);

alter table public.notification_email_verification_tokens enable row level security;
alter table public.notification_email_verification_tokens force row level security;
alter table public.notification_email_verification_attempts enable row level security;
alter table public.notification_email_verification_attempts force row level security;
revoke all on public.notification_email_verification_tokens from public, anon, authenticated;
revoke all on public.notification_email_verification_attempts from public, anon, authenticated;

create function public.issue_notification_email_verification(p_token_hash text)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid token hash';
  end if;
  select p.notification_email into v_email
  from public.profiles as p where p.id = v_user_id;
  if v_email is null then
    raise exception using errcode = '22023', message = 'Notification email is not configured';
  end if;
  if exists (
    select 1 from public.notification_email_verification_tokens
    where user_id = v_user_id and created_at > statement_timestamp() - interval '1 minute'
  ) then
    raise exception using errcode = 'P0001', message = 'RATE_LIMIT: wait one minute before requesting another email';
  end if;
  if (
    select count(*) from public.notification_email_verification_tokens
    where user_id = v_user_id and created_at > statement_timestamp() - interval '1 hour'
  ) >= 5 then
    raise exception using errcode = 'P0001', message = 'RATE_LIMIT: hourly verification email limit reached';
  end if;
  update public.notification_email_verification_tokens
  set invalidated_at = statement_timestamp()
  where user_id = v_user_id and used_at is null and invalidated_at is null;
  insert into public.notification_email_verification_tokens (
    user_id, notification_email, token_hash, expires_at
  ) values (
    v_user_id, v_email, p_token_hash, statement_timestamp() + interval '30 minutes'
  );
  return v_email;
end;
$$;

create function public.consume_notification_email_verification(
  p_token_hash text,
  p_attempt_key text
)
returns table (verified boolean, user_id uuid, error_code text)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_token public.notification_email_verification_tokens%rowtype;
begin
  delete from public.notification_email_verification_attempts
  where attempted_at < statement_timestamp() - interval '1 day';
  insert into public.notification_email_verification_attempts (attempt_key)
  values (p_attempt_key);
  if (
    select count(*) from public.notification_email_verification_attempts
    where attempt_key = p_attempt_key
      and attempted_at > statement_timestamp() - interval '10 minutes'
  ) > 20 then
    return query select false, null::uuid, 'rate_limited'::text;
    return;
  end if;

  select * into v_token
  from public.notification_email_verification_tokens
  where token_hash = p_token_hash
  for update;
  if not found then return query select false, null::uuid, 'invalid'::text; return; end if;
  if v_token.used_at is not null then return query select false, null::uuid, 'used'::text; return; end if;
  if v_token.invalidated_at is not null then return query select false, null::uuid, 'invalidated'::text; return; end if;
  if v_token.expires_at <= statement_timestamp() then return query select false, null::uuid, 'expired'::text; return; end if;

  update public.profiles
  set notification_email_verified_at = statement_timestamp()
  where id = v_token.user_id and notification_email = v_token.notification_email;
  if not found then return query select false, null::uuid, 'email_changed'::text; return; end if;
  update public.notification_email_verification_tokens
  set used_at = statement_timestamp() where id = v_token.id;
  return query select true, v_token.user_id, null::text;
end;
$$;

create function public.claim_due_task_reminders(p_limit integer default 50)
returns table (
  reminder_id uuid, recipient_user_id uuid, recipient_email text,
  recipient_name text, recipient_timezone text, task_title text,
  task_start_at timestamptz, task_due_at timestamptz,
  remind_at timestamptz, attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  update public.task_reminders r
  set status = 'cancelled', locked_at = null, next_attempt_at = null
  where r.status in ('pending', 'processing', 'failed') and (
    r.task_id is null or not exists (
      select 1 from public.tasks t where t.id = r.task_id and t.deleted_at is null
    ) or not exists (
      select 1 from public.profiles p
      where p.id = r.recipient_user_id and p.notification_email is not null
        and p.notification_email_verified_at is not null and p.email_notifications_enabled
    )
  );
  update public.task_reminders
  set status = 'failed', locked_at = null, next_attempt_at = statement_timestamp()
  where status = 'processing' and locked_at < statement_timestamp() - interval '10 minutes';

  return query
  with candidates as (
    select r.id from public.task_reminders r
    where r.status in ('pending', 'failed')
      and coalesce(r.next_attempt_at, r.remind_at) <= statement_timestamp()
      and r.task_id is not null
    order by coalesce(r.next_attempt_at, r.remind_at)
    for update skip locked
    limit least(greatest(p_limit, 1), 50)
  ), claimed as (
    update public.task_reminders r
    set status = 'processing', locked_at = statement_timestamp(),
        attempt_count = r.attempt_count + 1, last_error = null
    from candidates c where r.id = c.id
    returning r.*
  )
  select c.id, c.recipient_user_id, p.notification_email, p.display_name,
    p.timezone, t.title, coalesce(t.start_at, t.start_date),
    coalesce(t.due_at, t.due_date), c.remind_at, c.attempt_count
  from claimed c
  join public.tasks t on t.id = c.task_id and t.deleted_at is null
  join public.profiles p on p.id = c.recipient_user_id
    and p.notification_email is not null
    and p.notification_email_verified_at is not null
    and p.email_notifications_enabled;
end;
$$;

create function public.mark_task_reminder_sent(p_reminder_id uuid)
returns void language sql security definer set search_path = pg_catalog as $$
  update public.task_reminders set status = 'sent', sent_at = statement_timestamp(),
    locked_at = null, next_attempt_at = null, last_error = null
  where id = p_reminder_id and status = 'processing';
$$;

create function public.mark_task_reminder_failed(p_reminder_id uuid, p_error text)
returns void language sql security definer set search_path = pg_catalog as $$
  update public.task_reminders
  set status = 'failed', locked_at = null,
    next_attempt_at = case when attempt_count >= 5 then null
      else statement_timestamp() + pg_catalog.make_interval(mins => (pg_catalog.power(2, attempt_count)::integer)) end,
    last_error = pg_catalog.left(coalesce(p_error, 'Email delivery failed'), 1000)
  where id = p_reminder_id and status = 'processing';
$$;

create function public.release_dry_run_task_reminder(p_reminder_id uuid)
returns void language sql security definer set search_path = pg_catalog as $$
  update public.task_reminders set status = 'pending', locked_at = null,
    attempt_count = greatest(attempt_count - 1, 0),
    next_attempt_at = statement_timestamp() + interval '5 minutes'
  where id = p_reminder_id and status = 'processing';
$$;

revoke all on function public.issue_notification_email_verification(text) from public, anon, authenticated;
grant execute on function public.issue_notification_email_verification(text) to authenticated;
revoke all on function public.consume_notification_email_verification(text, text) from public, anon, authenticated;
revoke all on function public.claim_due_task_reminders(integer) from public, anon, authenticated;
revoke all on function public.mark_task_reminder_sent(uuid) from public, anon, authenticated;
revoke all on function public.mark_task_reminder_failed(uuid, text) from public, anon, authenticated;
revoke all on function public.release_dry_run_task_reminder(uuid) from public, anon, authenticated;
grant execute on function public.consume_notification_email_verification(text, text) to service_role;
grant execute on function public.claim_due_task_reminders(integer) to service_role;
grant execute on function public.mark_task_reminder_sent(uuid) to service_role;
grant execute on function public.mark_task_reminder_failed(uuid, text) to service_role;
grant execute on function public.release_dry_run_task_reminder(uuid) to service_role;

notify pgrst, 'reload schema';
