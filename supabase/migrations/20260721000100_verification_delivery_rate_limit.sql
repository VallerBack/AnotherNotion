alter table public.notification_email_verification_tokens
  add column delivery_accepted_at timestamptz;

create index notification_email_verification_delivery_rate_idx
  on public.notification_email_verification_tokens (user_id, delivery_accepted_at desc)
  where delivery_accepted_at is not null;

create or replace function public.issue_notification_email_verification(p_token_hash text)
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
  from public.profiles as p
  where p.id = v_user_id;

  if v_email is null then
    raise exception using errcode = '22023', message = 'Notification email is not configured';
  end if;

  -- Failed and dry-run issues are removed by the Edge Function, so this still
  -- prevents double-clicks while not consuming the hourly delivery allowance.
  if exists (
    select 1
    from public.notification_email_verification_tokens
    where user_id = v_user_id
      and created_at > statement_timestamp() - interval '1 minute'
  ) then
    raise exception using errcode = 'P0001',
      message = 'RATE_LIMIT_MINUTE: wait one minute before requesting another email';
  end if;

  -- Only mail explicitly accepted by Brevo consumes the hourly allowance.
  if (
    select count(*)
    from public.notification_email_verification_tokens
    where user_id = v_user_id
      and delivery_accepted_at > statement_timestamp() - interval '1 hour'
  ) >= 5 then
    raise exception using errcode = 'P0001',
      message = 'RATE_LIMIT_HOUR: hourly verification email limit reached';
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

create function public.mark_notification_email_verification_delivered(p_token_hash text)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  update public.notification_email_verification_tokens
  set delivery_accepted_at = statement_timestamp()
  where user_id = v_user_id
    and token_hash = p_token_hash
    and used_at is null
    and invalidated_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'Verification token not found';
  end if;
end;
$$;

revoke all on function public.mark_notification_email_verification_delivered(text)
  from public, anon, authenticated;
grant execute on function public.mark_notification_email_verification_delivered(text)
  to authenticated;

notify pgrst, 'reload schema';
