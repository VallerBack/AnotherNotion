import { corsHeaders, json } from '../_shared/cors.ts'
import { secureEqual } from '../_shared/crypto.ts'
import { escapeHtml, sendEmail } from '../_shared/brevo.ts'
import { serviceClient } from '../_shared/supabase.ts'

type ClaimedReminder = {
  reminder_id: string; recipient_user_id: string; recipient_email: string; recipient_name: string
  recipient_timezone: string; task_title: string; task_start_at: string | null
  task_due_at: string | null; remind_at: string; attempt_count: number
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const expected = Deno.env.get('CRON_SECRET') ?? ''
  const provided = request.headers.get('x-cron-secret') ?? ''
  if (!expected || !secureEqual(expected, provided)) return json({ error: 'Unauthorized' }, 401)

  const supabase = serviceClient()
  const dryRun = Deno.env.get('EMAIL_DRY_RUN')?.toLowerCase() === 'true'
  const summary = { claimed: 0, sent: 0, failed: 0, skipped: 0, dryRun }
  const { data, error } = await supabase.rpc('claim_due_task_reminders', { p_limit: 50 })
  if (error) return json({ error: 'Unable to claim reminders' }, 500)
  const reminders = (data ?? []) as ClaimedReminder[]
  summary.claimed = reminders.length

  for (const reminder of reminders) {
    try {
      const zone = reminder.recipient_timezone || 'UTC'
      const format = (value: string | null) => value
        ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(new Date(value))
        : '未设置'
      const appUrl = Deno.env.get('APP_URL')
      if (!appUrl) throw new Error('Missing APP_URL')
      const safeTitle = escapeHtml(reminder.task_title)
      const safeName = escapeHtml(reminder.recipient_name)
      const safeUrl = escapeHtml(appUrl)
      const result = await sendEmail({
        to: { email: reminder.recipient_email, name: reminder.recipient_name },
        subject: `任务提醒：${reminder.task_title}`,
        textContent: `你好，${reminder.recipient_name}\n任务：${reminder.task_title}\n开始：${format(reminder.task_start_at)}\n截止：${format(reminder.task_due_at)}\n提醒：${format(reminder.remind_at)}\n${appUrl}`,
        htmlContent: `<p>你好，${safeName}</p><p>任务：<strong>${safeTitle}</strong></p><p>开始：${escapeHtml(format(reminder.task_start_at))}<br>截止：${escapeHtml(format(reminder.task_due_at))}<br>提醒：${escapeHtml(format(reminder.remind_at))}</p><p><a href="${safeUrl}">打开 AnotherNotion</a></p>`,
        idempotencyKey: reminder.reminder_id,
        logContext: { userId: reminder.recipient_user_id, reminderId: reminder.reminder_id },
      })
      if (result.dryRun) {
        const { error: releaseError } = await supabase.rpc('release_dry_run_task_reminder', { p_reminder_id: reminder.reminder_id })
        if (releaseError) throw releaseError
        summary.skipped += 1
      } else {
        const { error: sentError } = await supabase.rpc('mark_task_reminder_sent', { p_reminder_id: reminder.reminder_id })
        if (sentError) throw sentError
        summary.sent += 1
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Email delivery failed'
      const { error: failureError } = await supabase.rpc('mark_task_reminder_failed', { p_reminder_id: reminder.reminder_id, p_error: message })
      summary.failed += 1
      console.error(JSON.stringify({ event: failureError ? 'reminder_state_update_failed' : 'reminder_delivery_failed', reminderId: reminder.reminder_id, userId: reminder.recipient_user_id }))
    }
  }
  return json(summary)
})
