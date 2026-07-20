create or replace function public.soft_delete_task(p_task_id uuid)
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
    and t.deleted_at is null
    and private.is_workspace_member(t.workspace_id);

  if v_workspace_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Active task not found or workspace access denied';
  end if;

  update public.tasks
  set deleted_at = statement_timestamp(),
      deleted_by = auth.uid()
  where id = p_task_id;
end;
$$;

revoke all on function public.soft_delete_task(uuid)
  from public, anon, authenticated;
grant execute on function public.soft_delete_task(uuid) to authenticated;

notify pgrst, 'reload schema';
