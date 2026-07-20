export function getAuthErrorMessage(error: unknown, action = '请求') {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  if (
    normalized.includes('invalid login credentials') ||
    normalized.includes('invalid credentials')
  ) {
    return '邮箱或密码错误，请重试。'
  }
  if (
    normalized.includes('fetch') ||
    normalized.includes('network') ||
    normalized.includes('failed to connect')
  ) {
    return '网络连接失败，请检查网络后重试。'
  }
  return `${action}失败：${message}`
}
