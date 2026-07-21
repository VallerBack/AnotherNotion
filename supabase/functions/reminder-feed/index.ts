import { serviceClient } from '../_shared/supabase.ts'
import type { ClaimedChannelReminder } from './format.ts'
import { createReminderFeedHandler } from './handler.ts'

const handler = createReminderFeedHandler({
  expectedToken: Deno.env.get('REMINDER_FEED_TOKEN') ?? '',
  appUrl: Deno.env.get('APP_URL') ?? 'https://vallerback.github.io/AnotherNotion',
  async claim() {
    const { data, error } = await serviceClient().rpc('claim_due_channel_reminders', { p_limit: 20 })
    if (error) throw error
    return (data ?? []) as ClaimedChannelReminder[]
  },
  log(event, count) {
    const entry = JSON.stringify({ event, ...(count === undefined ? {} : { count }) })
    if (event.endsWith('failed')) console.error(entry)
    else if (event.endsWith('unauthorized')) console.warn(entry)
    else console.info(entry)
  },
})

Deno.serve(handler)
