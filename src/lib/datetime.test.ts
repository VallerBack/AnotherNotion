import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TIMEZONE,
  timezoneLabel,
  utcToZonedInput,
  zonedInputToUtc,
  formatInTimezone,
} from './datetime'

describe('timezone conversion', () => {
  it('uses Asia/Shanghai as the application default', () => {
    expect(DEFAULT_TIMEZONE).toBe('Asia/Shanghai')
    expect(timezoneLabel(DEFAULT_TIMEZONE)).toBe('北京时间 UTC+8')
  })

  it('converts Beijing input to UTC before crossing to the previous date', () => {
    expect(zonedInputToUtc('2026-07-20T00:30', 'Asia/Shanghai'))
      .toBe('2026-07-19T16:30:00.000Z')
  })

  it('renders UTC in the selected timezone after crossing to the next date', () => {
    expect(utcToZonedInput('2026-07-20T23:30:00.000Z', 'Asia/Tokyo'))
      .toBe('2026-07-21T08:30')
  })

  it('round-trips a daylight-saving timezone using its IANA rules', () => {
    const utc = zonedInputToUtc('2026-12-31T20:15', 'America/New_York')
    expect(utc).toBe('2027-01-01T01:15:00.000Z')
    expect(utcToZonedInput(utc, 'America/New_York')).toBe('2026-12-31T20:15')
  })

  it('formats stored UTC timestamps in the account timezone', () => {
    expect(formatInTimezone('2026-07-20T16:30:00.000Z', 'Asia/Shanghai'))
      .toContain('2026')
    expect(formatInTimezone(null, 'Asia/Shanghai')).toBe('未设置')
  })
})
