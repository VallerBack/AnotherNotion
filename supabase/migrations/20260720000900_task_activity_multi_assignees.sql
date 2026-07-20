-- Task activity metadata and multi-assignee compatibility layer.

create table public.task_assignees (
  task_id uuid not null references public.tasks (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  assigned_by uuid not null references public.profiles (id) on delete restrict,
  assigned_at timestamptz not null default statement_timestamp(),
  primary key (task_id, user_id)
);
create index task_assignees_workspace_user_idx on public.task_assignees (workspace_id, user_id, task_id);

insert into public.task_assignees (task_id, user_id, workspace_id, assigned_by, assigned_at)
select id, assignee_id, workspace_id, created_by, created_at
from public.tasks where assignee_id is not null
on conflict (task_id, user_id) do nothing;

create function private.validate_task_assignee_link()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  if not exists (select 1 from public.tasks t where t.id = new.task_id and t.workspace_id = new.workspace_id)
    or not exists (select 1 from public.workspace_members wm where wm.workspace_id = new.workspace_id and wm.user_id = new.user_id)
    or not exists (select 1 from public.workspace_members wm where wm.workspace_id = new.workspace_id and wm.user_id = new.assigned_by)
  then raise exception using errcode = '23514', message = 'Task assignees must be workspace members'; end if;
  return new;
end; $$;
create trigger task_assignees_validate before insert or update on public.task_assignees
for each row execute function private.validate_task_assignee_link();

create function private.sync_legacy_task_assignee()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  delete from public.task_assignees where task_id = new.id;
  if new.assignee_id is not null then
    insert into public.task_assignees (task_id, user_id, workspace_id, assigned_by)
    values (new.id, new.assignee_id, new.workspace_id, auth.uid());
  end if;
  return new;
end; $$;
create trigger tasks_sync_legacy_assignee after insert or update of assignee_id on public.tasks
for each row execute function private.sync_legacy_task_assignee();

alter table public.task_assignees enable row level security;
alter table public.task_assignees force row level security;
create policy task_assignees_select_member on public.task_assignees for select to authenticated
using (private.is_workspace_member(workspace_id));
create policy task_assignees_insert_member on public.task_assignees for insert to authenticated
with check (private.is_workspace_member(workspace_id) and assigned_by = auth.uid());
create policy task_assignees_delete_member on public.task_assignees for delete to authenticated
using (private.is_workspace_member(workspace_id));
revoke all on public.task_assignees from public, anon, authenticated;
grant select, delete on public.task_assignees to authenticated;
grant insert (task_id, user_id, workspace_id, assigned_by) on public.task_assignees to authenticated;

alter table public.comments add column if not exists updated_by uuid references public.profiles (id) on delete set null;
alter table public.comments drop constraint if exists comments_body_check;
alter table public.comments add constraint comments_body_check
  check (body_md = btrim(body_md) and char_length(body_md) between 1 and 5000);
create function private.set_comment_update_audit()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin new.updated_by := auth.uid(); return new; end; $$;
create trigger comments_set_update_audit before update of body_md on public.comments
for each row execute function private.set_comment_update_audit();
grant select (updated_by) on public.comments to authenticated;

create function public.create_task_with_reminders_v2(
  p_workspace_id uuid, p_task jsonb, p_label_ids uuid[], p_assignee_ids uuid[],
  p_recipient_user_ids uuid[], p_remind_at timestamptz
) returns uuid language plpgsql security definer set search_path = pg_catalog as $$
declare v_task_id uuid; v_assignee uuid;
begin
  if exists (select 1 from unnest(coalesce(p_assignee_ids, array[]::uuid[])) a
    where not exists (select 1 from public.workspace_members wm where wm.workspace_id=p_workspace_id and wm.user_id=a))
  then raise exception using errcode='23514', message='Every assignee must be a workspace member'; end if;
  p_task := jsonb_set(p_task, '{assignee_id}', coalesce(to_jsonb(p_assignee_ids[1]), 'null'::jsonb), true);
  v_task_id := public.create_task_with_reminders(p_workspace_id,p_task,p_label_ids,p_recipient_user_ids,p_remind_at);
  delete from public.task_assignees where task_id=v_task_id;
  foreach v_assignee in array coalesce(p_assignee_ids,array[]::uuid[]) loop
    insert into public.task_assignees values (v_task_id,v_assignee,p_workspace_id,auth.uid(),statement_timestamp());
  end loop;
  return v_task_id;
end; $$;

create function public.update_task_with_reminders_v2(
  p_task_id uuid, p_task jsonb, p_label_ids uuid[], p_assignee_ids uuid[],
  p_recipient_user_ids uuid[], p_remind_at timestamptz
) returns void language plpgsql security definer set search_path = pg_catalog as $$
declare v_workspace_id uuid; v_assignee uuid;
begin
  select workspace_id into v_workspace_id from public.tasks where id=p_task_id and private.is_workspace_member(workspace_id);
  if v_workspace_id is null then raise exception using errcode='42501', message='Workspace membership required'; end if;
  if exists (select 1 from unnest(coalesce(p_assignee_ids,array[]::uuid[])) a
    where not exists (select 1 from public.workspace_members wm where wm.workspace_id=v_workspace_id and wm.user_id=a))
  then raise exception using errcode='23514', message='Every assignee must be a workspace member'; end if;
  p_task := jsonb_set(p_task, '{assignee_id}', coalesce(to_jsonb(p_assignee_ids[1]), 'null'::jsonb), true);
  perform public.update_task_with_reminders(p_task_id,p_task,p_label_ids,p_recipient_user_ids,p_remind_at);
  update public.tasks set assignee_id=p_assignee_ids[1] where id=p_task_id;
  delete from public.task_assignees where task_id=p_task_id;
  foreach v_assignee in array coalesce(p_assignee_ids,array[]::uuid[]) loop
    insert into public.task_assignees values (p_task_id,v_assignee,v_workspace_id,auth.uid(),statement_timestamp());
  end loop;
end; $$;

revoke all on function public.create_task_with_reminders_v2(uuid,jsonb,uuid[],uuid[],uuid[],timestamptz) from public,anon,authenticated;
revoke all on function public.update_task_with_reminders_v2(uuid,jsonb,uuid[],uuid[],uuid[],timestamptz) from public,anon,authenticated;
grant execute on function public.create_task_with_reminders_v2(uuid,jsonb,uuid[],uuid[],uuid[],timestamptz) to authenticated;
grant execute on function public.update_task_with_reminders_v2(uuid,jsonb,uuid[],uuid[],uuid[],timestamptz) to authenticated;

create function public.set_task_assignees(p_task_id uuid, p_assignee_ids uuid[])
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare v_workspace_id uuid; v_assignee uuid;
begin
  select workspace_id into v_workspace_id from public.tasks where id=p_task_id and private.is_workspace_member(workspace_id);
  if v_workspace_id is null then raise exception using errcode='42501', message='Workspace membership required'; end if;
  if exists (select 1 from unnest(coalesce(p_assignee_ids,array[]::uuid[])) a where not exists
    (select 1 from public.workspace_members wm where wm.workspace_id=v_workspace_id and wm.user_id=a))
  then raise exception using errcode='23514', message='Every assignee must be a workspace member'; end if;
  update public.tasks set assignee_id=p_assignee_ids[1] where id=p_task_id;
  delete from public.task_assignees where task_id=p_task_id;
  foreach v_assignee in array coalesce(p_assignee_ids,array[]::uuid[]) loop
    insert into public.task_assignees values (p_task_id,v_assignee,v_workspace_id,auth.uid(),statement_timestamp());
  end loop;
end; $$;
revoke all on function public.set_task_assignees(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.set_task_assignees(uuid,uuid[]) to authenticated;

create function public.cancel_notification_email_verification_issue(p_token_hash text)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception using errcode='42501', message='Authentication required'; end if;
  delete from public.notification_email_verification_tokens
  where user_id=v_user_id and token_hash=p_token_hash and used_at is null;
  update public.notification_email_verification_tokens set invalidated_at=null
  where id=(select id from public.notification_email_verification_tokens
    where user_id=v_user_id and used_at is null and expires_at>statement_timestamp()
    order by created_at desc limit 1);
end; $$;
revoke all on function public.cancel_notification_email_verification_issue(text) from public,anon,authenticated;
grant execute on function public.cancel_notification_email_verification_issue(text) to authenticated;

alter table public.task_assignees replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.task_assignees;
exception when duplicate_object then null; end $$;
notify pgrst, 'reload schema';
