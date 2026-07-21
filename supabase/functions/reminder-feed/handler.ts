import { safeFormatFeedItem, type ClaimedChannelReminder } from './format.ts'
import { constantTimeTokenEqual } from './token.ts'

export const feedResponseHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

type FeedDependencies = {
  expectedToken: string
  appUrl: string
  claim(): Promise<ClaimedChannelReminder[]>
  log(event: string, count?: number): void
}

export function createReminderFeedHandler(dependencies: FeedDependencies) {
  return async (request: Request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: feedResponseHeaders })
    if (request.method !== 'GET') return new Response(JSON.stringify([]), { status: 405, headers: feedResponseHeaders })
    const received = request.headers.get('X-Feed-Token') ?? ''
    if (!dependencies.expectedToken || !received || !(await constantTimeTokenEqual(received, dependencies.expectedToken))) {
      dependencies.log('reminder_feed_unauthorized')
      return new Response(JSON.stringify([]), { status: 401, headers: feedResponseHeaders })
    }
    try {
      const rows = await dependencies.claim()
      const items = rows.map((row) => safeFormatFeedItem(row, dependencies.appUrl))
      dependencies.log('reminder_feed_exported', items.length)
      return new Response(JSON.stringify(items), { status: 200, headers: feedResponseHeaders })
    } catch {
      dependencies.log('reminder_feed_failed')
      return new Response(JSON.stringify([]), { status: 500, headers: feedResponseHeaders })
    }
  }
}
