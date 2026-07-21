import { corsHeaders, json } from '../_shared/cors.ts'
import { sha256 } from '../_shared/crypto.ts'
import { serviceClient } from '../_shared/supabase.ts'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405)
  try {
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {}
    const token = new URL(request.url).searchParams.get('token') ?? (body as { token?: string }).token
    if (!token || token.length < 40 || token.length > 200) return json({ error: '验证链接无效。' }, 400)
    const tokenHash = await sha256(token)
    const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    const attemptKey = await sha256(`${forwarded}:${request.headers.get('user-agent') ?? ''}`)
    const { data, error } = await serviceClient().rpc('consume_notification_email_verification_v2', {
      p_token_hash: tokenHash, p_attempt_key: attemptKey,
    })
    if (error) throw error
    const result = data?.[0] as { verified: boolean; error_code: string | null; already_verified: boolean } | undefined
    if (result?.verified) {
      return json({ verified: true, alreadyVerified: result.already_verified === true })
    }
    const messages: Record<string, string> = {
      expired: '验证链接已过期，请重新发送。', used: '验证链接已经使用，但通知邮箱未完成验证。',
      invalidated: '已有更新的验证邮件，请使用最新邮件。', email_changed: '通知邮箱已变更，请重新发送验证邮件。',
      rate_limited: '验证尝试过多，请稍后再试。', invalid: '验证链接无效。',
    }
    return json({ error: messages[result?.error_code ?? 'invalid'] ?? messages.invalid }, result?.error_code === 'rate_limited' ? 429 : 400)
  } catch (error) {
    console.error(JSON.stringify({ event: 'notification_email_verification_failed', message: error instanceof Error ? error.message : 'unknown' }))
    return json({ error: '暂时无法验证通知邮箱。' }, 500)
  }
})
