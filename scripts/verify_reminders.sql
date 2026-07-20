select
  r.id,
  r.task_id,
  t.title as task_title,
  p.display_name as recipient_display_name,
  r.remind_at,
  r.status,
  r.attempt_count,
  r.sent_at,
  r.last_error,
  r.created_at
from public.task_reminders r
left join public.tasks t on t.id = r.task_id
join public.profiles p on p.id = r.recipient_user_id
order by r.created_at desc
limit 50;
