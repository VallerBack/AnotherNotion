import { DateTime } from 'luxon'

export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

export function timezoneLabel(timezone: string) {
  if (timezone === 'Asia/Shanghai') return '北京时间 UTC+8'
  const offset = DateTime.now().setZone(timezone).toFormat('ZZ')
  return `${timezone} UTC${offset}`
}

export function utcToZonedInput(value: string | null, timezone = DEFAULT_TIMEZONE) {
  if (!value) return ''
  const dateTime = DateTime.fromISO(value, { setZone: true }).setZone(timezone)
  return dateTime.isValid ? dateTime.toFormat("yyyy-MM-dd'T'HH:mm") : ''
}

export function zonedInputToUtc(value: string, timezone = DEFAULT_TIMEZONE) {
  if (!value) return null
  const dateTime = DateTime.fromFormat(value, "yyyy-MM-dd'T'HH:mm", { zone: timezone })
  return dateTime.isValid ? dateTime.toUTC().toISO() : null
}
