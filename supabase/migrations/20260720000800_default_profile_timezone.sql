-- New profiles default to Beijing time. Existing user-selected timezones are preserved.

alter table public.profiles
  alter column timezone set default 'Asia/Shanghai';

create or replace function public.handle_new_user()
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
  values (new.id, v_display_name, 'Asia/Shanghai');
  return new;
exception when others then
  raise exception using
    errcode = 'P0001',
    message = format('Profile creation failed for auth user %s: %s', new.id, sqlerrm);
end;
$$;

notify pgrst, 'reload schema';
