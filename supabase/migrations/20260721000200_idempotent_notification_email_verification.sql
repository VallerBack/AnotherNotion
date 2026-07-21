create function public.consume_notification_email_verification_v2(
  p_token_hash text,
  p_attempt_key text
)
returns table (
  verified boolean,
  user_id uuid,
  error_code text,
  already_verified boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_token public.notification_email_verification_tokens%rowtype;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' or length(p_attempt_key) < 32 then
    return query select false, null::uuid, 'invalid'::text, false;
    return;
  end if;

  select * into v_token
  from public.notification_email_verification_tokens
  where token_hash = p_token_hash
  for update;

  if found and v_token.used_at is not null then
    if v_token.invalidated_at is null and exists (
      select 1
      from public.profiles p
      where p.id = v_token.user_id
        and p.notification_email = v_token.notification_email
        and p.notification_email_verified_at is not null
    ) then
      return query select true, v_token.user_id, null::text, true;
    else
      return query select false, null::uuid, 'used'::text, false;
    end if;
    return;
  end if;

  delete from public.notification_email_verification_attempts
  where attempted_at < statement_timestamp() - interval '1 day';
  insert into public.notification_email_verification_attempts (attempt_key)
  values (p_attempt_key);
  if (
    select count(*) from public.notification_email_verification_attempts
    where attempt_key = p_attempt_key
      and attempted_at > statement_timestamp() - interval '10 minutes'
  ) > 20 then
    return query select false, null::uuid, 'rate_limited'::text, false;
    return;
  end if;

  if v_token.id is null then
    return query select false, null::uuid, 'invalid'::text, false;
    return;
  end if;
  if v_token.invalidated_at is not null then
    return query select false, null::uuid, 'invalidated'::text, false;
    return;
  end if;
  if v_token.expires_at <= statement_timestamp() then
    return query select false, null::uuid, 'expired'::text, false;
    return;
  end if;

  update public.profiles
  set notification_email_verified_at = statement_timestamp()
  where id = v_token.user_id
    and notification_email = v_token.notification_email;
  if not found then
    return query select false, null::uuid, 'email_changed'::text, false;
    return;
  end if;

  update public.notification_email_verification_tokens
  set used_at = statement_timestamp()
  where id = v_token.id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Verification token disappeared';
  end if;

  return query select true, v_token.user_id, null::text, false;
end;
$$;

revoke all on function public.consume_notification_email_verification_v2(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_notification_email_verification_v2(text, text)
  to service_role;

notify pgrst, 'reload schema';
