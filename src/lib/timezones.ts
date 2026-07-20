import { DateTime } from 'luxon'

export const DEFAULT_CURATED_TIMEZONE = 'Asia/Shanghai'

const zones: Array<[string, string]> = [
  ['Asia/Shanghai','UTC+08:00 — 北京 / 上海'], ['Asia/Tokyo','UTC+09:00 — 东京 / 首尔'],
  ['Australia/Sydney','UTC+10:00 — 悉尼'], ['Pacific/Noumea','UTC+11:00 — 努美阿'],
  ['Pacific/Auckland','UTC+12:00 — 奥克兰'], ['Pacific/Apia','UTC+13:00 — 阿皮亚'], ['Pacific/Kiritimati','UTC+14:00 — 基里蒂马蒂'],
  ['Etc/GMT+12','UTC-12:00 — 贝克岛'], ['Pacific/Pago_Pago','UTC-11:00 — 帕果帕果'],
  ['Pacific/Honolulu','UTC-10:00 — 火奴鲁鲁'], ['America/Anchorage','UTC-09:00 — 安克雷奇'],
  ['America/Los_Angeles','UTC-08:00 — 洛杉矶'], ['America/Denver','UTC-07:00 — 丹佛'],
  ['America/Chicago','UTC-06:00 — 芝加哥'], ['America/New_York','UTC-05:00 — 纽约'],
  ['America/Halifax','UTC-04:00 — 哈利法克斯'], ['America/Sao_Paulo','UTC-03:00 — 圣保罗'],
  ['America/Noronha','UTC-02:00 — 费尔南多迪诺罗尼亚'], ['Atlantic/Azores','UTC-01:00 — 亚速尔'],
  ['Europe/London','UTC+00:00 — 伦敦'], ['Europe/Paris','UTC+01:00 — 巴黎'],
  ['Europe/Athens','UTC+02:00 — 雅典'], ['Europe/Moscow','UTC+03:00 — 莫斯科'],
  ['Asia/Dubai','UTC+04:00 — 迪拜'], ['Asia/Karachi','UTC+05:00 — 卡拉奇'],
  ['Asia/Dhaka','UTC+06:00 — 达卡'], ['Asia/Bangkok','UTC+07:00 — 曼谷'],
]

export const CURATED_TIMEZONES = zones.map(([value, label]) => ({ value, label }))

export function timezoneOptions(current: string) {
  return CURATED_TIMEZONES.some((zone) => zone.value === current)
    ? CURATED_TIMEZONES
    : [{ value: current, label: `${current}（现有时区）` }, ...CURATED_TIMEZONES]
}

export function offsetForZone(zone: string, iso: string) {
  return DateTime.fromISO(iso, { zone }).toFormat('ZZ')
}
