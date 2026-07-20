import { corsHeaders, json } from '../_shared/cors.ts'
import { randomToken, sha256 } from '../_shared/crypto.ts'
import { escapeHtml, sendEmail } from '../_shared/brevo.ts'
import { userClient } from '../_shared/supabase.ts'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const authorization = request.headers.get('authorization')
  if (!authorization) return json({ error: 'Authentication required' }, 401)
  try {
    const supabase = userClient(authorization)
    const { data: { user }, error: userError } = await supabase.auth.getUser()
    if (userError || !user) return json({ error: 'Authentication required' }, 401)
    const token = randomToken(32)
    const tokenHash = await sha256(token)
    const { data: email, error } = await supabase.rpc('issue_notification_email_verification', { p_token_hash: tokenHash })
    if (error) {
      if (error.message.includes('RATE_LIMIT')) return json({ error: '请求过于频繁，请稍后再试。' }, 429)
      if (error.message.includes('not configured')) return json({ error: '请先设置通知邮箱。' }, 400)
      throw error
    }
    const appUrl = Deno.env.get('APP_URL')
    if (!appUrl) throw new Error('Missing APP_URL')
    const verifyUrl = `${appUrl.replace(/\/$/, '')}/#/verify-notification-email?token=${encodeURIComponent(token)}`
    const safeUrl = escapeHtml(verifyUrl)
    await sendEmail({
      to: { email: email as string }, subject: '验证 AnotherNotion 通知邮箱',
      textContent: `请在30分钟内打开此链接验证通知邮箱：${verifyUrl}`,
      htmlContent: `<p>请在30分钟内验证你的 AnotherNotion 通知邮箱。</p><p><a href="${safeUrl}">验证通知邮箱</a></p>`,
      logContext: { userId: user.id },
    })
    return json({ message: '如果通知邮箱有效，验证邮件将很快送达。' })
  } catch (error) {
    console.error(JSON.stringify({ event: 'verification_request_failed', message: error instanceof Error ? error.message : 'unknown' }))
    return json({ error: '无法发送验证邮件，请稍后再试。' }, 500)
  }
})

