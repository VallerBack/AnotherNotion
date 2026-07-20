-- Run once from a trusted Supabase SQL session after replacing the quoted
-- email placeholder below. Re-running the script is safe.

begin;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('anothernotion:bootstrap-owner', 0)
);

do $$
declare
  v_email text := 'OWNER_EMAIL';
  v_user_id uuid;
  v_workspace_id uuid;
  v_workspace_creator uuid;
  v_workspace_count integer;
begin
  select u.id
  into v_user_id
  from auth.users as u
  where pg_catalog.lower(u.email) = pg_catalog.lower(v_email);

  if v_user_id is null then
    raise exception using
      errcode = 'P0002',
      message = pg_catalog.format(
        'No auth.users account exists for email %L',
        v_email
      );
  end if;

  if not exists (
    select 1
    from public.profiles as p
    where p.id = v_user_id
  ) then
    raise exception using
      errcode = 'P0002',
      message = pg_catalog.format(
        'The auth user %s has no matching public.profiles row',
        v_user_id
      );
  end if;

  select pg_catalog.count(*)
  into v_workspace_count
  from public.workspaces as w
  where w.name = 'AnotherNotion';

  if v_workspace_count > 1 then
    raise exception using
      errcode = 'P0001',
      message = 'Multiple workspaces named AnotherNotion already exist; resolve them before bootstrapping';
  end if;

  if v_workspace_count = 0 then
    insert into public.workspaces (name, created_by)
    values ('AnotherNotion', v_user_id)
    returning id, created_by
    into v_workspace_id, v_workspace_creator;
  else
    select w.id, w.created_by
    into v_workspace_id, v_workspace_creator
    from public.workspaces as w
    where w.name = 'AnotherNotion';

    if v_workspace_creator <> v_user_id then
      raise exception using
        errcode = '42501',
        message = 'The existing AnotherNotion workspace was created by a different user';
    end if;
  end if;

  if exists (
    select 1
    from public.workspace_members as wm
    where wm.workspace_id = v_workspace_id
      and wm.role = 'owner'::public.workspace_role
      and wm.user_id <> v_user_id
  ) then
    raise exception using
      errcode = '42501',
      message = 'The AnotherNotion workspace already has a different owner';
  end if;

  insert into public.workspace_members (
    workspace_id,
    user_id,
    role,
    added_by
  )
  values (
    v_workspace_id,
    v_user_id,
    'owner'::public.workspace_role,
    v_user_id
  )
  on conflict (workspace_id, user_id) do update
  set role = excluded.role,
      added_by = excluded.added_by;
end;
$$;

commit;

select
  w.name as workspace_name,
  u.email as user_email,
  wm.role
from public.workspaces as w
join public.workspace_members as wm on wm.workspace_id = w.id
join auth.users as u on u.id = wm.user_id
where w.name = 'AnotherNotion'
  and wm.role = 'owner'::public.workspace_role;
