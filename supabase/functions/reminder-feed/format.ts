export type ClaimedChannelReminder = {
  reminder_id: string
  task_id: string
  task_title: string
  description_md: string
  task_status: 'todo' | 'in_progress' | 'done'
  task_priority: 'low' | 'medium' | 'high' | 'urgent'
  deadline_at: string | null
  creator_name: string
  assignee_names: string[] | null
  remind_at: string
}

const statusLabels = { todo: '待办', in_progress: '进行中', done: '已完成' } as const
const priorityLabels = { low: '低', medium: '中', high: '高', urgent: '紧急' } as const

export function neutralizeMentions(value: string) {
  return value
    .replace(/@(everyone|here)/gi, '@\u200b$1')
    .replace(/<@([!&]?)(\d+)>/g, '<@\u200b$1$2>')
}

export function markdownToPlainText(value: string) {
  return neutralizeMentions(value)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/[~*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function toShanghaiIso(value: string | null) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return `${shifted.toISOString().slice(0, 19)}+08:00`
}

function displayShanghai(value: string | null) {
  const iso = toShanghaiIso(value)
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}（北京时间）` : '未设置'
}

export function formatFeedItem(row: ClaimedChannelReminder, appUrl: string) {
  const mods = [...new Set(row.assignee_names ?? [])].map(neutralizeMentions)
  const title = neutralizeMentions(row.task_title.trim())
  const details = markdownToPlainText(row.description_md).slice(0, 400)
  const url = `${normalizeAppUrl(appUrl)}/#/tasks/${encodeURIComponent(row.task_id)}`
  const lines = [
    '【AnotherNotion 任务提醒】',
    `任务：${title}`,
    `负责人：${mods.length ? mods.join('、') : '未分配负责人'}`,
    `状态：${statusLabels[row.task_status]}`,
    `优先级：${priorityLabels[row.task_priority]}`,
    `截止：${displayShanghai(row.deadline_at)}`,
    details ? `说明：${details}` : '',
  ].filter(Boolean)
  const urlLine = `查看详情：${url}`
  const available = Math.max(0, 1800 - urlLine.length - 1)
  let prefix = lines.join('\n')
  if (prefix.length > available) prefix = `${prefix.slice(0, Math.max(0, available - 1))}…`
  const content = `${prefix}\n${urlLine}`
  return {
    id: row.reminder_id,
    name: title,
    content,
    deadline: toShanghaiIso(row.deadline_at),
    author: neutralizeMentions(row.creator_name || '历史任务未记录'),
    modsInvolved: mods,
    remindAt: toShanghaiIso(row.remind_at)!,
    url,
  }
}

export function normalizeAppUrl(value: string) {
  const withoutHash = value.trim().replace(/\/?#.*$/, '')
  const candidate = withoutHash.replace(/\/+$/, '')
  try {
    const parsed = new URL(candidate)
    if (!['http:', 'https:'].includes(parsed.protocol) || candidate.length > 500) throw new Error('Invalid APP_URL')
    return candidate
  } catch {
    return 'https://vallerback.github.io/AnotherNotion'
  }
}

export function safeFormatFeedItem(row: ClaimedChannelReminder, appUrl: string) {
  try {
    return formatFeedItem(row, appUrl)
  } catch {
    const url = `${normalizeAppUrl(appUrl)}/#/tasks/${encodeURIComponent(String(row.task_id ?? ''))}`
    const remindAt = toShanghaiIso(row.remind_at) ?? '1970-01-01T08:00:00+08:00'
    const name = neutralizeMentions(String(row.task_title ?? '未命名任务')).slice(0, 300)
    const urlLine = `查看详情：${url}`
    const prefix = `【AnotherNotion 任务提醒】\n任务：${name}\n提醒内容生成异常，请打开任务详情确认。`
    const available = Math.max(0, 1800 - urlLine.length - 1)
    const content = `${prefix.slice(0, available)}\n${urlLine}`
    return {
      id: String(row.reminder_id ?? ''), name, content, deadline: null,
      author: '历史任务未记录', modsInvolved: [], remindAt, url,
    }
  }
}
