-- ONE-TIME ADMIN TEMPLATE. Run only in a trusted SQL session after replacing placeholders.
-- Do not ship this file to a client and do not add a real email address to version control.
-- Preferred path for new data: authenticated clients call public.create_workspace(name).

begin;

do $$
declare
  v_owner_id uuid;
  v_workspace_id uuid := '00000000-0000-0000-0000-000000000000';
begin
  select id into v_owner_id
  from auth.users
  where email = 'owner@example.invalid'; -- Replace locally; never commit the real email.

  if v_owner_id is null then
    raise exception 'Owner auth user was not found';
  end if;
  if not exists (select 1 from public.workspaces where id = v_workspace_id) then
    raise exception 'Target workspace was not found';
  end if;
  if exists (select 1 from public.workspace_members where workspace_id = v_workspace_id) then
    raise exception 'Workspace already has members; aborting one-time initialization';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role, added_by)
  values (v_workspace_id, v_owner_id, 'owner', v_owner_id);
end;
$$;

commit;
