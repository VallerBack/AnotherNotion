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
  if (!response.ok) throw new Error(`Brevo request failed with status ${response.status}`)
  return { dryRun: false }
}

