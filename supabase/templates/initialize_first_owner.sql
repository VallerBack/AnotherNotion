-- ONE-TIME ADMIN TEMPLATE
-- Run only in a trusted SQL session after choosing ONE identity placeholder below.
-- Never commit a real email address or a service-role key.

begin;

-- Serialize repeated/concurrent executions of this initialization template.
select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('anothernotion:first-owner-initialization', 0)
);

do $$
declare
  -- Option A: replace OWNER_EMAIL_PLACEHOLDER with the auth user's email.
  v_owner_email text := 'OWNER_EMAIL_PLACEHOLDER';

  -- Option B: replace NULL with the quoted auth user UUID, for example:
  -- v_owner_user_id uuid := '00000000-0000-0000-0000-000000000000';
  -- UUID takes precedence when both values are supplied.
  v_owner_user_id uuid := null;

  v_owner_id uuid;
  v_workspace_id uuid;
  v_workspace_creator uuid;
  v_workspace_count integer;
  v_member_count integer;
begin
  if v_owner_user_id is not null then
    select u.id into v_owner_id
    from auth.users as u
    where u.id = v_owner_user_id;
  elsif v_owner_email <> 'OWNER_EMAIL_PLACEHOLDER' then
    select u.id into v_owner_id
    from auth.users as u
    where pg_catalog.lower(u.email) = pg_catalog.lower(v_owner_email);
  else
    raise exception
      'Replace OWNER_EMAIL_PLACEHOLDER or set v_owner_user_id before running this template';
  end if;

  if v_owner_id is null then
    raise exception 'The selected auth.users account was not found';
  end if;

  if not exists (select 1 from public.profiles as p where p.id = v_owner_id) then
    raise exception
      'The selected auth user has no public.profiles row; fix profile creation before initialization';
  end if;

  select count(*) into v_workspace_count
  from public.workspaces as w
  where w.name = 'AnotherNotion';

  if v_workspace_count > 1 then
    raise exception
      'More than one workspace named AnotherNotion exists; resolve duplicates before initialization';
  end if;

  if v_workspace_count = 0 then
    insert into public.workspaces (name, created_by)
    values ('AnotherNotion', v_owner_id)
    returning id, created_by into v_workspace_id, v_workspace_creator;
  else
    select w.id, w.created_by into v_workspace_id, v_workspace_creator
    from public.workspaces as w
    where w.name = 'AnotherNotion';

    if v_workspace_creator <> v_owner_id then
      raise exception
        'The existing AnotherNotion workspace belongs to another creator; refusing to take it over';
    end if;
  end if;

  select count(*) into v_member_count
  from public.workspace_members as wm
  where wm.workspace_id = v_workspace_id;

  if v_member_count >= 10 and not exists (
    select 1
    from public.workspace_members as wm
    where wm.workspace_id = v_workspace_id and wm.user_id = v_owner_id
  ) then
    raise exception 'The AnotherNotion workspace already has 10 members';
  end if;

  insert into public.workspace_members (
    workspace_id,
    user_id,
    role,
    added_by
  )
  values (
    v_workspace_id,
    v_owner_id,
    'member',
    v_owner_id
  )
  on conflict (workspace_id, user_id) do update
  set role = 'member';

  raise notice 'AnotherNotion owner initialization complete. Workspace ID: %, owner user ID: %',
    v_workspace_id,
    v_owner_id;
end;
$$;

commit;
