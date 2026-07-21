import { describe, expect, it } from 'vitest'
import { formatFeedItem, markdownToPlainText, neutralizeMentions, normalizeAppUrl, safeFormatFeedItem, toShanghaiIso } from '../../supabase/functions/reminder-feed/format'
import { constantTimeTokenEqual } from '../../supabase/functions/reminder-feed/token'
import { createReminderFeedHandler } from '../../supabase/functions/reminder-feed/handler'

const base = {
  reminder_id: '11111111-1111-1111-1111-111111111111', task_id: '22222222-2222-2222-2222-222222222222',
  task_title: '发布任务', description_md: '**说明**', task_status: 'in_progress' as const,
  task_priority: 'medium' as const, deadline_at: '2026-07-23T10:00:00Z', creator_name: '创建者',
  assignee_names: ['甲', '乙'], remind_at: '2026-07-23T09:00:00Z',
}

describe('频道提醒 JSON 格式', () => {
  it('输出北京时间、负责人数组、任务 URL 和纯文字', () => {
    const item = formatFeedItem(base, 'https://vallerback.github.io/AnotherNotion/')
    expect(item.deadline).toBe('2026-07-23T18:00:00+08:00')
    expect(item.remindAt).toBe('2026-07-23T17:00:00+08:00')
    expect(item.modsInvolved).toEqual(['甲', '乙'])
    expect(item.url).toContain('/AnotherNotion/#/tasks/22222222-2222-2222-2222-222222222222')
    expect(item.content).toContain('状态：进行中')
  })
  it('无负责人和截止时间保持明确的 JSON 类型', () => {
    const item = formatFeedItem({ ...base, assignee_names: [], deadline_at: null }, 'https://example.test/app')
    expect(item.modsInvolved).toEqual([]); expect(item.deadline).toBeNull()
  })
  it('清理 Markdown、HTML 和危险提及并截断长内容', () => {
    expect(markdownToPlainText('**hi** <script>x</script> [link](https://x)')).not.toContain('<script>')
    expect(neutralizeMentions('@everyone @here <@123>')).not.toContain('@everyone')
    const item = formatFeedItem({ ...base, description_md: `@everyone ${'x'.repeat(4000)}` }, 'https://example.test')
    expect(item.content.length).toBeLessThanOrEqual(1800); expect(item.content).not.toContain('@everyone')
  })
  it('UTC 跨日转换为 UTC+08:00', () => {
    expect(toShanghaiIso('2026-07-22T18:30:00Z')).toBe('2026-07-23T02:30:00+08:00')
  })
  it('feed token 使用固定摘要比较并拒绝错误值', async () => {
    await expect(constantTimeTokenEqual('correct-token', 'correct-token')).resolves.toBe(true)
    await expect(constantTimeTokenEqual('wrong-token', 'correct-token')).resolves.toBe(false)
    await expect(constantTimeTokenEqual('', 'correct-token')).resolves.toBe(false)
  })
  it('规范化 APP_URL 并保持 HashRouter 详情地址', () => {
    expect(normalizeAppUrl('https://example.test/AnotherNotion///')).toBe('https://example.test/AnotherNotion')
    expect(normalizeAppUrl('https://example.test/AnotherNotion/#/settings')).toBe('https://example.test/AnotherNotion')
    expect(normalizeAppUrl('javascript:alert(1)')).toBe('https://vallerback.github.io/AnotherNotion')
  })
  it('单条异常记录使用安全降级格式而不吞掉已领取提醒', () => {
    const broken = { ...base, task_title: null } as unknown as typeof base
    const item = safeFormatFeedItem(broken, 'https://example.test/app/')
    expect(item.id).toBe(base.reminder_id)
    expect(item.content).toContain('查看详情：https://example.test/app/#/tasks/')
    expect(item.content.length).toBeLessThanOrEqual(1800)
  })
  it('只有正确 token 的 GET 才会领取，OPTIONS 和 POST 不领取', async () => {
    let claims = 0
    const handler = createReminderFeedHandler({
      expectedToken: 'secret', appUrl: 'https://example.test/app', log: () => undefined,
      claim: async () => { claims += 1; return [] },
    })
    expect((await handler(new Request('https://feed.test'))).status).toBe(401)
    expect((await handler(new Request('https://feed.test', { headers: { 'X-Feed-Token': 'wrong' } }))).status).toBe(401)
    expect((await handler(new Request('https://feed.test', { method: 'OPTIONS' }))).status).toBe(204)
    expect((await handler(new Request('https://feed.test', { method: 'POST', headers: { 'X-Feed-Token': 'secret' } }))).status).toBe(405)
    const response = await handler(new Request('https://feed.test', { headers: { 'X-Feed-Token': 'secret' } }))
    expect(response.status).toBe(200); expect(await response.json()).toEqual([])
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(claims).toBe(1)
  })
})
