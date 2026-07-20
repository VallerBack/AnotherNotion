-- Bootstrap Staff101 through Staff110 into the existing AnotherNotion workspace.
-- Accounts are matched case-insensitively by the local part of auth.users.email.
-- Run only from a trusted SQL session. This script never modifies auth.users.

begin;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('anothernotion:bootstrap-staff', 0)
);

do $$
declare
  v_workspace_id uuid;
  v_workspace_count integer;
  v_staff_number integer;
  v_display_name text;
  v_user_id uuid;
  v_user_count integer;
begin
  select pg_catalog.count(*)
  into v_workspace_count
  from public.workspaces as w
  where w.name = 'AnotherNotion';

  if v_workspace_count = 0 then
    raise exception using
      errcode = 'P0002',
      message = 'Workspace named AnotherNotion does not exist';
  elsif v_workspace_count > 1 then
    raise exception using
      errcode = 'P0001',
      message = 'Multiple workspaces named AnotherNotion exist; refusing to choose one';
  end if;

  select w.id
  into v_workspace_id
  from public.workspaces as w
  where w.name = 'AnotherNotion';

  for v_staff_number in 101..110 loop
    v_display_name := pg_catalog.format('Staff%s', v_staff_number);

    select pg_catalog.count(*)
    into v_user_count
    from auth.users as u
    where pg_catalog.lower(pg_catalog.split_part(u.email, '@', 1)) =
      pg_catalog.lower(v_display_name);

    if v_user_count = 0 then
      raise exception using
        errcode = 'P0002',
        message = pg_catalog.format(
          'Required auth.users account %s was not found by email local part',
          v_display_name
        );
    elsif v_user_count > 1 then
      raise exception using
        errcode = '21000',
        message = pg_catalog.format(
          'Multiple auth.users emails have local part %s; use unique staff emails before bootstrapping',
          v_display_name
        );
    end if;

    select u.id
    into v_user_id
    from auth.users as u
    where pg_catalog.lower(pg_catalog.split_part(u.email, '@', 1)) =
      pg_catalog.lower(v_display_name);

    insert into public.profiles (
      id,
      display_name,
      timezone,
      must_change_password
    )
    values (
      v_user_id,
      v_display_name,
      'UTC',
      true
    )
    on conflict (id) do update
    set display_name = excluded.display_name,
        must_change_password = true;

    insert into public.workspace_members (
      workspace_id,
      user_id,
      role,
      added_by
    )
    values (
      v_workspace_id,
      v_user_id,
      'member'::public.workspace_role,
      null
    )
    on conflict (workspace_id, user_id) do update
    set role = excluded.role;
  end loop;
end;
$$;

commit;

select
  u.email as login_email,
  p.display_name,
  w.name as workspace_name,
  wm.role as membership_role,
  wm.joined_at,
  p.must_change_password
from public.workspaces as w
join public.workspace_members as wm
  on wm.workspace_id = w.id
join public.profiles as p
  on p.id = wm.user_id
join auth.users as u
  on u.id = wm.user_id
where w.name = 'AnotherNotion'
  and pg_catalog.lower(pg_catalog.split_part(u.email, '@', 1)) in (
    'staff101', 'staff102', 'staff103', 'staff104', 'staff105',
    'staff106', 'staff107', 'staff108', 'staff109', 'staff110'
  )
order by p.display_name;
