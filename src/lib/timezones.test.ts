import { describe, expect, it } from 'vitest'
import { CURATED_TIMEZONES, DEFAULT_CURATED_TIMEZONE, offsetForZone, timezoneOptions } from './timezones'

describe('精简时区列表', () => {
  it('北京时间为首项并覆盖 UTC-12 至 UTC+14', () => {
    expect(DEFAULT_CURATED_TIMEZONE).toBe('Asia/Shanghai')
    expect(CURATED_TIMEZONES[0].label).toContain('UTC+08:00')
    expect(CURATED_TIMEZONES.some((item) => item.label.startsWith('UTC-12:00'))).toBe(true)
    expect(CURATED_TIMEZONES.some((item) => item.label.startsWith('UTC+14:00'))).toBe(true)
  })
  it('保留不在列表中的旧值', () => expect(timezoneOptions('Asia/Kolkata')[0]).toEqual({ value: 'Asia/Kolkata', label: 'Asia/Kolkata（现有时区）' }))
  it('IANA 时区保留夏令时差异', () => expect(offsetForZone('America/New_York', '2026-01-15T12:00:00Z')).not.toBe(offsetForZone('America/New_York', '2026-07-15T12:00:00Z')))
})
