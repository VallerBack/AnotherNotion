export type EmailMessage = {
  to: { email: string; name?: string }
  subject: string
  textContent: string
  htmlContent: string
  idempotencyKey?: string
  logContext: { userId: string; reminderId?: string }
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]!)
}

export class EmailDeliveryError extends Error {
  constructor(public status: number, public category: string, public messageId?: string) {
    super('Email provider rejected the request')
  }
}

export async function sendEmail(message: EmailMessage) {
  const dryRun = Deno.env.get('EMAIL_DRY_RUN')?.toLowerCase() === 'true'
  if (dryRun) {
    console.info(JSON.stringify({ event: 'email_dry_run', ...message.logContext }))
    return { dryRun: true }
  }
  const apiKey = Deno.env.get('BREVO_API_KEY')
  const senderEmail = Deno.env.get('BREVO_SENDER_EMAIL')
  const senderName = Deno.env.get('BREVO_SENDER_NAME')
  const replyToEmail = Deno.env.get('BREVO_REPLY_TO_EMAIL')
  if (!apiKey || !senderEmail || !senderName || !replyToEmail) {
    throw new Error('Email provider configuration is incomplete')
  }
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      replyTo: { email: replyToEmail },
      to: [message.to], subject: message.subject,
      textContent: message.textContent, htmlContent: message.htmlContent,
      ...(message.idempotencyKey ? { headers: { 'Idempotency-Key': message.idempotencyKey } } : {}),
    }),
  })
  const result = await response.json().catch(() => ({})) as { messageId?: string; code?: string }
  if (!response.ok) {
    const category = response.status === 429 ? 'rate_limited'
      : response.status === 401 || response.status === 403 ? 'provider_auth'
      : response.status >= 500 ? 'provider_unavailable'
      : result.code === 'invalid_parameter' ? 'invalid_recipient_or_sender' : 'provider_rejected'
    console.error(JSON.stringify({ event: 'brevo_request_rejected', status: response.status, messageId: result.messageId ?? null, category }))
    throw new EmailDeliveryError(response.status, category, result.messageId)
  }
  console.info(JSON.stringify({ event: 'brevo_request_accepted', status: response.status, messageId: result.messageId ?? null, category: 'accepted' }))
  return { dryRun: false, messageId: result.messageId }
}
