-- AnotherNotion initial schema. Apply locally with `supabase db reset` before remote review.

create schema if not exists private;
revoke all on schema private from public, anon;

create type public.workspace_role as enum ('owner', 'member');
create type public.task_status as enum ('todo', 'in_progress', 'done');
create type public.task_priority as enum ('low', 'medium', 'high', 'urgent');
create type public.task_schedule_kind as enum ('none', 'all_day', 'timed');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_check
    check (display_name = btrim(display_name) and char_length(display_name) between 1 and 80)
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_name_check
    check (name = btrim(name) and char_length(name) between 1 and 100)
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.workspace_role not null,
  joined_at timestamptz not null default now(),
  added_by uuid references public.profiles (id) on delete set null,
  primary key (workspace_id, user_id)
);

create unique index workspace_members_one_owner_idx
  on public.workspace_members (workspace_id)
  where role = 'owner';
create index workspace_members_user_workspace_idx
  on public.workspace_members (user_id, workspace_id);

create function private.is_workspace_member(
  p_workspace_id uuid,
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from public.workspace_members as wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = p_user_id
  );
$$;

create function private.is_workspace_owner(
  p_workspace_id uuid,
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from public.workspace_members as wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = p_user_id
      and wm.role = 'owner'
  );
$$;

create function private.shares_workspace_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select p_user_id = auth.uid()
    or exists (
      select 1
      from public.workspace_members as mine
      join public.workspace_members as theirs
        on theirs.workspace_id = mine.workspace_id
      where mine.user_id = auth.uid()
        and theirs.user_id = p_user_id
    );
$$;

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null,
  description_md text not null default '',
  status public.task_status not null default 'todo',
  priority public.task_priority not null default 'medium',
  assignee_id uuid references public.profiles (id) on delete set null,
  schedule_kind public.task_schedule_kind not null default 'none',
  due_date date,
  due_at timestamptz,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles (id) on delete set null,
  constraint tasks_title_check
    check (title = btrim(title) and char_length(title) between 1 and 300),
  constraint tasks_schedule_check check (
    (schedule_kind = 'none' and due_date is null and due_at is null)
    or (schedule_kind = 'all_day' and due_date is not null and due_at is null)
    or (schedule_kind = 'timed' and due_date is null and due_at is not null)
  ),
  constraint tasks_deleted_by_check check (
    (deleted_at is null and deleted_by is null)
    or (deleted_at is not null and deleted_by is not null)
  )
);

create table public.labels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  color text not null,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint labels_name_check
    check (name = btrim(name) and char_length(name) between 1 and 50),
  constraint labels_color_check check (color ~ '^#[0-9A-Fa-f]{6}$'),
  unique (id, workspace_id)
);

create unique index labels_workspace_lower_name_idx
  on public.labels (workspace_id, lower(name));

create table public.task_labels (
  task_id uuid not null references public.tasks (id) on delete cascade,
  label_id uuid not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, label_id),
  foreign key (label_id, workspace_id)
    references public.labels (id, workspace_id) on delete cascade
);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  task_id uuid not null references public.tasks (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete restrict,
  body_md text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint comments_body_check
    check (body_md = btrim(body_md) and char_length(body_md) between 1 and 10000)
);

create index tasks_workspace_idx on public.tasks (workspace_id);
create index tasks_workspace_assignee_idx on public.tasks (workspace_id, assignee_id);
create index tasks_workspace_due_at_idx on public.tasks (workspace_id, due_at)
  where schedule_kind = 'timed' and deleted_at is null;
create index tasks_workspace_due_date_idx on public.tasks (workspace_id, due_date)
  where schedule_kind = 'all_day' and deleted_at is null;
create index tasks_workspace_status_idx on public.tasks (workspace_id, status)
  where deleted_at is null;
create index tasks_workspace_deleted_idx on public.tasks (workspace_id, deleted_at)
  where deleted_at is not null;
create index labels_workspace_idx on public.labels (workspace_id);
create index task_labels_workspace_task_idx on public.task_labels (workspace_id, task_id);
create index comments_workspace_task_created_idx
  on public.comments (workspace_id, task_id, created_at);

create function private.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  new.updated_at := statement_timestamp();
  return new;
end;
$$;

create function private.validate_profile_timezone()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if not exists (
    select 1 from pg_catalog.pg_timezone_names where name = new.timezone
  ) then
    raise exception using
      errcode = '22023',
      message = format('Invalid IANA timezone: %s', new.timezone);
  end if;
  return new;
end;
$$;

create function private.validate_task_assignee()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.assignee_id is not null and not exists (
    select 1 from public.workspace_members as wm
    where wm.workspace_id = new.workspace_id and wm.user_id = new.assignee_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Task assignee must be a member of the task workspace';
  end if;
  return new;
end;
$$;

create function private.validate_task_label_workspace()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if not exists (
    select 1 from public.tasks as t
    where t.id = new.task_id and t.workspace_id = new.workspace_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Task and label must belong to the same workspace';
  end if;
  return new;
end;
$$;

create function private.validate_comment_workspace()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if not exists (
    select 1 from public.tasks as t
    where t.id = new.task_id and t.workspace_id = new.workspace_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Comment and task must belong to the same workspace';
  end if;
  return new;
end;
$$;

create function private.set_task_deletion_audit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    new.deleted_by := auth.uid();
  elsif old.deleted_at is not null and new.deleted_at is null then
    new.deleted_by := null;
  elsif new.deleted_at is not distinct from old.deleted_at then
    new.deleted_by := old.deleted_by;
  end if;
  return new;
end;
$$;

create trigger profiles_validate_timezone
before insert or update of timezone on public.profiles
for each row execute function private.validate_profile_timezone();
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function private.set_updated_at();
create trigger workspaces_set_updated_at before update on public.workspaces
for each row execute function private.set_updated_at();
create trigger labels_set_updated_at before update on public.labels
for each row execute function private.set_updated_at();
create trigger comments_set_updated_at before update on public.comments
for each row execute function private.set_updated_at();
create trigger tasks_set_updated_at before update on public.tasks
for each row execute function private.set_updated_at();
create trigger tasks_validate_assignee
before insert or update of workspace_id, assignee_id on public.tasks
for each row execute function private.validate_task_assignee();
create trigger tasks_set_deletion_audit
before update of deleted_at, deleted_by on public.tasks
for each row execute function private.set_task_deletion_audit();
create trigger task_labels_validate_workspace
before insert or update on public.task_labels
for each row execute function private.validate_task_label_workspace();
create trigger comments_validate_workspace
before insert or update of workspace_id, task_id on public.comments
for each row execute function private.validate_comment_workspace();

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_display_name text;
begin
  v_display_name := left(
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'New user'
    ),
    80
  );

  insert into public.profiles (id, display_name, timezone)
  values (new.id, v_display_name, 'UTC');
  return new;
exception when others then
  raise exception using
    errcode = 'P0001',
    message = format('Profile creation failed for auth user %s: %s', new.id, sqlerrm);
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create function public.create_workspace(p_name text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_name text := btrim(p_name);
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if char_length(v_name) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Workspace name must contain 1 to 100 characters';
  end if;

  insert into public.workspaces (name, created_by)
  values (v_name, v_user_id)
  returning id into v_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role, added_by)
  values (v_workspace_id, v_user_id, 'owner', v_user_id);
  return v_workspace_id;
end;
$$;

create function public.add_workspace_member(p_workspace_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_caller uuid := auth.uid();
  v_count integer;
begin
  if not private.is_workspace_owner(p_workspace_id, v_caller) then
    raise exception using errcode = '42501', message = 'Only the workspace owner can add members';
  end if;

  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Workspace not found';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception using errcode = 'P0002', message = 'Member profile not found';
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

create function public.remove_workspace_member(p_workspace_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if not private.is_workspace_owner(p_workspace_id, auth.uid()) then
    raise exception using errcode = '42501', message = 'Only the workspace owner can remove members';
  end if;
  if exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = p_user_id and role = 'owner'
  ) then
    raise exception using errcode = '23514', message = 'The workspace owner cannot be removed';
  end if;

  update public.tasks set assignee_id = null
  where workspace_id = p_workspace_id and assignee_id = p_user_id;
  delete from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id and role = 'member';
end;
$$;

create function public.transfer_workspace_ownership(p_workspace_id uuid, p_new_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_current_owner uuid := auth.uid();
begin
  if not private.is_workspace_owner(p_workspace_id, v_current_owner) then
    raise exception using errcode = '42501', message = 'Only the current owner can transfer ownership';
  end if;
  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = p_new_owner_id and role = 'member'
  ) then
    raise exception using errcode = '23514', message = 'The new owner must already be a workspace member';
  end if;

  update public.workspace_members set role = 'member'
  where workspace_id = p_workspace_id and user_id = v_current_owner;
  update public.workspace_members set role = 'owner'
  where workspace_id = p_workspace_id and user_id = p_new_owner_id;
end;
$$;

create function public.list_deleted_tasks(p_workspace_id uuid)
returns setof public.tasks
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select t.*
  from public.tasks as t
  where t.workspace_id = p_workspace_id
    and t.deleted_at is not null
    and private.is_workspace_member(p_workspace_id)
  order by t.deleted_at desc;
$$;

create function public.restore_task(p_task_id uuid)
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
    raise exception using errcode = 'P0002', message = 'Deleted task not found or access denied';
  end if;

  update public.tasks
  set deleted_at = null
  where id = p_task_id;
end;
$$;

alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.workspaces enable row level security;
alter table public.workspaces force row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_members force row level security;
alter table public.tasks enable row level security;
alter table public.tasks force row level security;
alter table public.labels enable row level security;
alter table public.labels force row level security;
alter table public.task_labels enable row level security;
alter table public.task_labels force row level security;
alter table public.comments enable row level security;
alter table public.comments force row level security;

create policy profiles_select_shared on public.profiles for select to authenticated
using (private.shares_workspace_with(id));
create policy profiles_update_self on public.profiles for update to authenticated
using (id = auth.uid()) with check (id = auth.uid());

create policy workspaces_select_member on public.workspaces for select to authenticated
using (private.is_workspace_member(id));
create policy workspaces_update_owner on public.workspaces for update to authenticated
using (private.is_workspace_owner(id)) with check (private.is_workspace_owner(id));

create policy workspace_members_select_member on public.workspace_members for select to authenticated
using (private.is_workspace_member(workspace_id));

create policy tasks_select_member on public.tasks for select to authenticated
using (private.is_workspace_member(workspace_id) and deleted_at is null);
create policy tasks_insert_member on public.tasks for insert to authenticated
with check (private.is_workspace_member(workspace_id) and created_by = auth.uid());
create policy tasks_update_member on public.tasks for update to authenticated
using (private.is_workspace_member(workspace_id) and deleted_at is null)
with check (private.is_workspace_member(workspace_id));

create policy labels_select_member on public.labels for select to authenticated
using (private.is_workspace_member(workspace_id));
create policy labels_insert_member on public.labels for insert to authenticated
with check (private.is_workspace_member(workspace_id) and created_by = auth.uid());
create policy labels_update_member on public.labels for update to authenticated
using (private.is_workspace_member(workspace_id))
with check (private.is_workspace_member(workspace_id));
create policy labels_delete_member on public.labels for delete to authenticated
using (private.is_workspace_member(workspace_id));

create policy task_labels_select_member on public.task_labels for select to authenticated
using (
  private.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.tasks as t
    where t.id = task_labels.task_id
      and t.workspace_id = task_labels.workspace_id
      and t.deleted_at is null
  )
);
create policy task_labels_insert_member on public.task_labels for insert to authenticated
with check (
  private.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.tasks as t
    where t.id = task_labels.task_id
      and t.workspace_id = task_labels.workspace_id
      and t.deleted_at is null
  )
);
create policy task_labels_delete_member on public.task_labels for delete to authenticated
using (
  private.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.tasks as t
    where t.id = task_labels.task_id
      and t.workspace_id = task_labels.workspace_id
      and t.deleted_at is null
  )
);

create policy comments_select_member on public.comments for select to authenticated
using (
  private.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.tasks as t
    where t.id = comments.task_id
      and t.workspace_id = comments.workspace_id
      and t.deleted_at is null
  )
);
create policy comments_insert_member on public.comments for insert to authenticated
with check (
  private.is_workspace_member(workspace_id)
  and author_id = auth.uid()
  and exists (
    select 1 from public.tasks as t
    where t.id = comments.task_id
      and t.workspace_id = comments.workspace_id
      and t.deleted_at is null
  )
);
create policy comments_update_author on public.comments for update to authenticated
using (
  private.is_workspace_member(workspace_id)
  and author_id = auth.uid()
  and exists (
    select 1 from public.tasks as t
    where t.id = comments.task_id
      and t.workspace_id = comments.workspace_id
      and t.deleted_at is null
  )
)
with check (
  private.is_workspace_member(workspace_id)
  and author_id = auth.uid()
  and exists (
    select 1 from public.tasks as t
    where t.id = comments.task_id
      and t.workspace_id = comments.workspace_id
      and t.deleted_at is null
  )
);
create policy comments_delete_author on public.comments for delete to authenticated
using (
  private.is_workspace_member(workspace_id)
  and author_id = auth.uid()
  and exists (
    select 1 from public.tasks as t
    where t.id = comments.task_id
      and t.workspace_id = comments.workspace_id
      and t.deleted_at is null
  )
);

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

grant usage on schema public, private to authenticated;
grant select on public.profiles, public.workspaces, public.workspace_members,
  public.tasks, public.labels, public.task_labels, public.comments to authenticated;
grant update (display_name, timezone) on public.profiles to authenticated;
grant update (name) on public.workspaces to authenticated;
grant insert (workspace_id, title, description_md, status, priority, assignee_id,
  schedule_kind, due_date, due_at, created_by)
  on public.tasks to authenticated;
grant update (title, description_md, status, priority, assignee_id,
  schedule_kind, due_date, due_at, deleted_at)
  on public.tasks to authenticated;
grant insert (workspace_id, name, color, created_by) on public.labels to authenticated;
grant update (name, color) on public.labels to authenticated;
grant delete on public.labels to authenticated;
grant insert (task_id, label_id, workspace_id), delete on public.task_labels to authenticated;
grant insert (workspace_id, task_id, author_id, body_md) on public.comments to authenticated;
grant update (body_md) on public.comments to authenticated;
grant delete on public.comments to authenticated;

grant execute on function private.is_workspace_member(uuid, uuid) to authenticated;
grant execute on function private.is_workspace_owner(uuid, uuid) to authenticated;
grant execute on function private.shares_workspace_with(uuid) to authenticated;
grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.add_workspace_member(uuid, uuid) to authenticated;
grant execute on function public.remove_workspace_member(uuid, uuid) to authenticated;
grant execute on function public.transfer_workspace_ownership(uuid, uuid) to authenticated;
grant execute on function public.list_deleted_tasks(uuid) to authenticated;
grant execute on function public.restore_task(uuid) to authenticated;

comment on table public.tasks is 'Workspace tasks; deleted_at implements the recycle bin.';
comment on function public.transfer_workspace_ownership(uuid, uuid)
  is 'Atomically transfers the single owner role to an existing member.';
