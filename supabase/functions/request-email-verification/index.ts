import { corsHeaders, json } from '../_shared/cors.ts'
import { randomToken, sha256 } from '../_shared/crypto.ts'
import { EmailDeliveryError, escapeHtml, sendEmail } from '../_shared/brevo.ts'
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
    const membership = await supabase.from('workspace_members').select('workspace_id').eq('user_id', user.id).limit(1).maybeSingle()
    if (membership.error || !membership.data) return json({ error: '需要工作区成员身份。' }, 403)
    console.info(JSON.stringify({ event: 'verification_email_requested', status: 202, category: 'request_validated' }))
    const token = randomToken(32)
    const tokenHash = await sha256(token)
    const { data: email, error } = await supabase.rpc('issue_notification_email_verification', { p_token_hash: tokenHash })
    if (error) {
      if (error.message.includes('RATE_LIMIT')) return json({ error: '发送过于频繁，请稍后再试。', code: 'RATE_LIMIT' }, 429)
      if (error.message.includes('not configured')) return json({ error: '请先设置通知邮箱。' }, 400)
      throw error
    }
    const appUrl = Deno.env.get('APP_URL')
    if (!appUrl) throw new Error('Missing APP_URL')
    const verifyUrl = `${appUrl.replace(/\/$/, '')}/#/verify-notification-email?token=${encodeURIComponent(token)}`
    const safeUrl = escapeHtml(verifyUrl)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email as string)) {
      await supabase.rpc('cancel_notification_email_verification_issue', { p_token_hash: tokenHash })
      return json({ error: '邮箱地址格式错误。', code: 'INVALID_EMAIL' }, 400)
    }
    try { const delivery = await sendEmail({
      to: { email: email as string }, subject: '验证 AnotherNotion 通知邮箱',
      textContent: `请在30分钟内打开此链接验证通知邮箱：${verifyUrl}`,
      htmlContent: `<p>请在30分钟内验证你的 AnotherNotion 通知邮箱。</p><p><a href="${safeUrl}">验证通知邮箱</a></p>`,
      logContext: { userId: user.id },
    })
      if (delivery.dryRun) {
        await supabase.rpc('cancel_notification_email_verification_issue', { p_token_hash: tokenHash })
        return json({ sent: false, dryRun: true, status: 200, category: 'dry_run' })
      }
      if (!delivery.messageId) {
        await supabase.rpc('cancel_notification_email_verification_issue', { p_token_hash: tokenHash })
        return json({ error: '邮件服务没有确认投递。', code: 'MISSING_MESSAGE_ID', sent: false, dryRun: false }, 502)
      }
    } catch (deliveryError) {
      await supabase.rpc('cancel_notification_email_verification_issue', { p_token_hash: tokenHash })
      if (deliveryError instanceof EmailDeliveryError) {
        const unavailable = ['provider_auth', 'provider_unavailable'].includes(deliveryError.category)
        return json({ error: unavailable ? '邮件服务暂时不可用。' : '邮件服务未接受发送请求。', code: deliveryError.category }, 503)
      }
      throw deliveryError
    }
    console.info(JSON.stringify({ event: 'verification_email_accepted', status: 202, category: 'accepted' }))
    return json({ sent: true, dryRun: false, status: 202, category: 'accepted' }, 202)
  } catch (error) {
    console.error(JSON.stringify({ event: 'verification_request_failed', message: error instanceof Error ? error.message : 'unknown' }))
    return json({ error: '无法发送验证邮件，请稍后再试。' }, 500)
  }
})
