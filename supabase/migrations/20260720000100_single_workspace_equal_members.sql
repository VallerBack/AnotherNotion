-- Convert authorization to a single-workspace, equal-member model.
-- The role column remains for data compatibility but is not consulted.

do $$
begin
  if (select count(*) from public.workspaces) > 1 then
    raise exception using
      errcode = '23514',
      message = 'Single-workspace migration requires at most one existing workspace';
  end if;
end;
$$;

create unique index if not exists workspaces_singleton_idx
  on public.workspaces ((true));

drop index if exists public.workspace_members_one_owner_idx;

create or replace function public.create_workspace(p_name text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  select wm.workspace_id into v_workspace_id
  from public.workspace_members as wm
  where wm.user_id = v_user_id
  limit 1;

  if v_workspace_id is null then
    raise exception using
      errcode = '42501',
      message = 'Workspace membership required; initialize the single workspace administratively';
  end if;

  perform p_name;
  return v_workspace_id;
end;
$$;

create or replace function public.add_workspace_member(
  p_workspace_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_caller uuid := auth.uid();
  v_count integer;
begin
  if not private.is_workspace_member(p_workspace_id, v_caller) then
    raise exception using errcode = '42501', message = 'Workspace membership required';
  end if;

  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Workspace not found';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception using errcode = 'P0002', message = 'Member profile not found';
  end if;
  if exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = p_user_id
  ) then
    return;
  end if;

  select count(*) into v_count
  from public.workspace_members where workspace_id = p_workspace_id;
  if v_count >= 10 then
    raise exception using errcode = '23514', message = 'A workspace can have at most 10 members';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role, added_by)
  values (p_workspace_id, p_user_id, 'member', v_caller);
end;
$$;

create or replace function public.remove_workspace_member(
  p_workspace_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_count integer;
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception using errcode = '42501', message = 'Workspace membership required';
  end if;
  if not exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = p_user_id
  ) then
    return;
  end if;

  perform 1 from public.workspaces where id = p_workspace_id for update;
  select count(*) into v_count
  from public.workspace_members where workspace_id = p_workspace_id;
  if v_count <= 1 then
    raise exception using
      errcode = '23514',
      message = 'The final workspace membership cannot be removed';
  end if;

  update public.tasks set assignee_id = null
  where workspace_id = p_workspace_id and assignee_id = p_user_id;
  delete from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id;
end;
$$;

revoke execute on function public.transfer_workspace_ownership(uuid, uuid)
  from public, anon, authenticated;

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
    and private.is_workspace_member(t.workspace_id);

  if v_workspace_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Deleted task not found or workspace access denied';
  end if;

  delete from public.tasks where id = p_task_id;
end;
$$;

drop policy if exists workspaces_update_owner on public.workspaces;
drop policy if exists workspaces_update_member on public.workspaces;
create policy workspaces_update_member
on public.workspaces
for update
to authenticated
using (private.is_workspace_member(id))
with check (private.is_workspace_member(id));

drop policy if exists comments_update_author on public.comments;
drop policy if exists comments_delete_author on public.comments;
drop policy if exists comments_update_member on public.comments;
drop policy if exists comments_delete_member on public.comments;

create policy comments_update_member
on public.comments
for update
to authenticated
using (
  private.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.tasks as t
    where t.id = comments.task_id
      and t.workspace_id = comments.workspace_id
      and t.deleted_at is null
  )
)
with check (
  private.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.tasks as t
    where t.id = comments.task_id
      and t.workspace_id = comments.workspace_id
      and t.deleted_at is null
  )
);

create policy comments_delete_member
on public.comments
for delete
to authenticated
using (
  private.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.tasks as t
    where t.id = comments.task_id
      and t.workspace_id = comments.workspace_id
      and t.deleted_at is null
  )
);

grant execute on function public.add_workspace_member(uuid, uuid) to authenticated;
grant execute on function public.remove_workspace_member(uuid, uuid) to authenticated;
grant execute on function public.permanently_delete_task(uuid) to authenticated;

drop function public.transfer_workspace_ownership(uuid, uuid);
drop function private.is_workspace_owner(uuid, uuid);

notify pgrst, 'reload schema';
