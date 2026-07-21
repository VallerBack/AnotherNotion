-- Channel reminder feed. The legacy per-recipient email queue and its history
-- remain intact; new application writes use this task-level export queue.

create type public.channel_reminder_status as enum (
  'pending', 'exported', 'cancelled', 'failed'
);

create table public.channel_reminders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  task_id uuid not null references public.tasks (id) on delete cascade,
  remind_at timestamptz not null,
  status public.channel_reminder_status not null default 'pending',
  exported_at timestamptz,
  export_attempt_count integer not null default 0 check (export_attempt_count >= 0),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint channel_reminders_task_time_unique unique (task_id, remind_at),
  constraint channel_reminders_export_state_check check (
    (status = 'exported' and exported_at is not null)
    or (status <> 'exported')
  )
);

create index channel_reminders_due_idx
  on public.channel_reminders (remind_at, id) where status = 'pending';
create index channel_reminders_workspace_task_idx
  on public.channel_reminders (workspace_id, task_id, remind_at);

create trigger channel_reminders_set_updated_at
before update on public.channel_reminders
for each row execute function private.set_updated_at();

alter table public.channel_reminders enable row level security;
alter table public.channel_reminders force row level security;
create policy channel_reminders_select_member on public.channel_reminders
for select to authenticated using (private.is_workspace_member(workspace_id));

revoke all on public.channel_reminders from public, anon, authenticated;
grant select on public.channel_reminders to authenticated;

create function public.set_task_channel_reminder(p_task_id uuid, p_remind_at timestamptz)
returns uuid language plpgsql security definer set search_path = pg_catalog as $$
declare v_workspace_id uuid; v_id uuid;
begin
  if p_remind_at is null or p_remind_at <= statement_timestamp() then
    raise exception using errcode='22023', message='Reminder time must be in the future';
  end if;
  select workspace_id into v_workspace_id from public.tasks
  where id=p_task_id and deleted_at is null and status <> 'done'
    and private.is_workspace_member(workspace_id) for update;
  if v_workspace_id is null then
    raise exception using errcode='P0002', message='Task not found or workspace access denied';
  end if;
  insert into public.channel_reminders(workspace_id,task_id,remind_at,created_by)
  values(v_workspace_id,p_task_id,p_remind_at,auth.uid())
  on conflict(task_id,remind_at) do update set
    status=case when public.channel_reminders.status='exported'
      then public.channel_reminders.status else 'pending'::public.channel_reminder_status end,
    exported_at=case when public.channel_reminders.status='exported'
      then public.channel_reminders.exported_at else null end
  returning id into v_id;
  return v_id;
end $$;

create function public.cancel_channel_reminder(p_reminder_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog as $$
begin
  update public.channel_reminders set status='cancelled'
  where id=p_reminder_id and status in ('pending','failed')
    and private.is_workspace_member(workspace_id);
  if not found then raise exception using errcode='P0002', message='Reminder cannot be cancelled'; end if;
end $$;

create function public.reschedule_channel_reminder(p_reminder_id uuid,p_remind_at timestamptz)
returns void language plpgsql security definer set search_path = pg_catalog as $$
begin
  if p_remind_at is null or p_remind_at <= statement_timestamp() then
    raise exception using errcode='22023', message='Reminder time must be in the future';
  end if;
  update public.channel_reminders r set remind_at=p_remind_at,
    status=case when r.status='exported' then r.status else 'pending'::public.channel_reminder_status end,
    exported_at=case when r.status='exported' then r.exported_at else null end
  where r.id=p_reminder_id and r.status in ('pending','failed','cancelled','exported')
    and private.is_workspace_member(r.workspace_id)
    and exists(select 1 from public.tasks t where t.id=r.task_id and t.deleted_at is null and t.status<>'done');
  if not found then raise exception using errcode='P0002', message='Reminder cannot be rescheduled'; end if;
end $$;

create function public.reexport_channel_reminder(p_reminder_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare v_id uuid;
begin
  select r.id into v_id from public.channel_reminders r
  where r.id=p_reminder_id and r.status in ('exported','failed')
    and private.is_workspace_member(r.workspace_id)
    and exists(select 1 from public.tasks t where t.id=r.task_id and t.deleted_at is null and t.status<>'done')
  for update;
  if v_id is null then raise exception using errcode='P0002', message='Reminder cannot be re-exported'; end if;
  update public.channel_reminders set status='pending',exported_at=null where id=v_id;
end $$;

create function public.create_task_with_channel_reminder_v2(
  p_workspace_id uuid,p_task jsonb,p_label_ids uuid[],p_assignee_ids uuid[],p_remind_at timestamptz
) returns uuid language plpgsql security definer set search_path = pg_catalog as $$
declare v_task_id uuid;
begin
  v_task_id:=public.create_task_with_reminders_v2(
    p_workspace_id,p_task,p_label_ids,p_assignee_ids,array[]::uuid[],null);
  if p_remind_at is not null then perform public.set_task_channel_reminder(v_task_id,p_remind_at); end if;
  return v_task_id;
end $$;

create function public.update_task_with_channel_reminder_v2(
  p_task_id uuid,p_task jsonb,p_label_ids uuid[],p_assignee_ids uuid[],p_remind_at timestamptz
) returns void language plpgsql security definer set search_path = pg_catalog as $$
declare v_workspace_id uuid;
begin
  select workspace_id into v_workspace_id from public.tasks
    where id=p_task_id and private.is_workspace_member(workspace_id) for update;
  if v_workspace_id is null then raise exception using errcode='42501',message='Workspace membership required'; end if;
  perform public.update_task_with_reminders_v2(
    p_task_id,p_task,p_label_ids,p_assignee_ids,array[]::uuid[],null);
  update public.channel_reminders set status='cancelled'
    where task_id=p_task_id and status in ('pending','failed')
      and (p_remind_at is null or remind_at<>p_remind_at);
  if p_remind_at is not null then perform public.set_task_channel_reminder(p_task_id,p_remind_at); end if;
end $$;

create function public.claim_due_channel_reminders(p_limit integer default 20)
returns table(
  reminder_id uuid, task_id uuid, task_title text, description_md text, task_status public.task_status,
  task_priority public.task_priority, deadline_at timestamptz, creator_name text,
  assignee_names text[], remind_at timestamptz
) language plpgsql security definer set search_path = pg_catalog as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode='42501', message='Service role required';
  end if;
  return query
  with claimed as (
    select r.id from public.channel_reminders r join public.tasks t on t.id=r.task_id
    where r.status='pending' and r.remind_at<=statement_timestamp()
      and t.deleted_at is null and t.status<>'done'
    order by r.remind_at,r.id for update of r skip locked limit least(greatest(p_limit,0),20)
  ), updated as (
    update public.channel_reminders r set status='exported',exported_at=statement_timestamp(),
      export_attempt_count=r.export_attempt_count+1
    from claimed c where r.id=c.id returning r.*
  )
  select u.id,t.id,t.title,t.description_md,t.status,t.priority,
    case when t.schedule_kind='timed' then coalesce(t.due_at,t.start_at)
      when t.schedule_kind='all_day' then
        (coalesce(t.due_date,t.start_date)::date::timestamp at time zone 'Asia/Shanghai') else null end,
    coalesce(p.display_name,'历史任务未记录'),
    coalesce((select array_agg(ap.display_name order by ta.assigned_at,ap.display_name)
      from public.task_assignees ta join public.profiles ap on ap.id=ta.user_id where ta.task_id=t.id),array[]::text[]),
    u.remind_at
  from updated u join public.tasks t on t.id=u.task_id
  left join public.profiles p on p.id=t.created_by order by u.remind_at,u.id;
end $$;

create function private.cancel_channel_reminders_for_task()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  if (old.deleted_at is null and new.deleted_at is not null)
     or (old.status <> 'done' and new.status = 'done') then
    update public.channel_reminders set status='cancelled'
    where task_id=new.id and status in ('pending','failed');
  end if;
  return new;
end $$;
create trigger tasks_cancel_channel_reminders
before update of deleted_at,status on public.tasks
for each row execute function private.cancel_channel_reminders_for_task();

-- Deliberately do not migrate legacy email reminders. Even a pending row can be
-- an expired/manual test, and the feed has no acknowledgement channel. Members
-- must explicitly create a channel reminder in the new UI.

revoke all on function public.set_task_channel_reminder(uuid,timestamptz) from public,anon,authenticated;
revoke all on function public.cancel_channel_reminder(uuid) from public,anon,authenticated;
revoke all on function public.reschedule_channel_reminder(uuid,timestamptz) from public,anon,authenticated;
revoke all on function public.reexport_channel_reminder(uuid) from public,anon,authenticated;
revoke all on function public.claim_due_channel_reminders(integer) from public,anon,authenticated;
revoke all on function public.create_task_with_channel_reminder_v2(uuid,jsonb,uuid[],uuid[],timestamptz) from public,anon,authenticated;
revoke all on function public.update_task_with_channel_reminder_v2(uuid,jsonb,uuid[],uuid[],timestamptz) from public,anon,authenticated;
grant execute on function public.set_task_channel_reminder(uuid,timestamptz) to authenticated;
grant execute on function public.cancel_channel_reminder(uuid) to authenticated;
grant execute on function public.reschedule_channel_reminder(uuid,timestamptz) to authenticated;
grant execute on function public.reexport_channel_reminder(uuid) to authenticated;
grant execute on function public.claim_due_channel_reminders(integer) to service_role;
grant execute on function public.create_task_with_channel_reminder_v2(uuid,jsonb,uuid[],uuid[],timestamptz) to authenticated;
grant execute on function public.update_task_with_channel_reminder_v2(uuid,jsonb,uuid[],uuid[],timestamptz) to authenticated;

alter table public.channel_reminders replica identity full;
do $$ begin alter publication supabase_realtime add table public.channel_reminders;
exception when duplicate_object then null; end $$;
notify pgrst,'reload schema';
