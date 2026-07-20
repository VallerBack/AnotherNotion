alter table public.tasks
  add column start_date date,
  add column start_at timestamptz;

alter table public.tasks drop constraint tasks_schedule_check;
alter table public.tasks add constraint tasks_schedule_check check (
  (
    schedule_kind = 'none'
    and start_date is null
    and start_at is null
    and due_date is null
    and due_at is null
  )
  or (
    schedule_kind = 'all_day'
    and start_at is null
    and due_at is null
    and (start_date is not null or due_date is not null)
    and (start_date is null or due_date is null or start_date <= due_date)
  )
  or (
    schedule_kind = 'timed'
    and start_date is null
    and due_date is null
    and (start_at is not null or due_at is not null)
    and (start_at is null or due_at is null or start_at <= due_at)
  )
);

create index tasks_workspace_start_at_idx on public.tasks (workspace_id, start_at)
  where schedule_kind = 'timed' and deleted_at is null;
create index tasks_workspace_start_date_idx on public.tasks (workspace_id, start_date)
  where schedule_kind = 'all_day' and deleted_at is null;

grant insert (start_date, start_at) on public.tasks to authenticated;
grant update (start_date, start_at) on public.tasks to authenticated;

create function public.permanently_delete_task(p_task_id uuid)
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
    and private.is_workspace_owner(t.workspace_id);

  if v_workspace_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Deleted task not found or owner access denied';
  end if;

  delete from public.tasks where id = p_task_id;
end;
$$;

revoke all on function public.permanently_delete_task(uuid) from public, anon;
grant execute on function public.permanently_delete_task(uuid) to authenticated;
