-- Keep this migration idempotent so environments whose task-module migration
-- already added the column remain unchanged.
alter table public.tasks
  add column if not exists start_at timestamptz;

grant insert (start_at) on public.tasks to authenticated;
grant update (start_at) on public.tasks to authenticated;

-- Ask PostgREST to refresh its schema cache after the migration commits.
notify pgrst, 'reload schema';
