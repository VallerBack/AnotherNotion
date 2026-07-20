import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '../types/database'
import { SupabaseAuthGateway } from './auth-gateway'

function gatewayWith(response: unknown) {
  const invoke = vi.fn(async () => response)
  const client = { functions: { invoke } } as unknown as SupabaseClient<Database>
  return { gateway: new SupabaseAuthGateway(client), invoke }
}

describe('通知邮箱函数响应协议', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  it('明确 await invoke，且只有 sent=true 才成功', async () => {
    const { gateway, invoke } = gatewayWith({ data: { sent: true, dryRun: false, status: 202 }, error: null })
    await expect(gateway.requestNotificationEmailVerification()).resolves.toEqual({ sent: true, dryRun: false })
    expect(invoke).toHaveBeenCalledWith('request-email-verification', { body: {} })
  })

  it('data=null 或 sent=false 不能成功', async () => {
    await expect(gatewayWith({ data: null, error: null }).gateway.requestNotificationEmailVerification()).rejects.toThrow('未确认实际投递')
    await expect(gatewayWith({ data: { sent: false, dryRun: false }, error: null }).gateway.requestNotificationEmailVerification()).rejects.toThrow('未确认实际投递')
  })

  it('dryRun 返回模拟发送而不伪装成功', async () => {
    await expect(gatewayWith({ data: { sent: false, dryRun: true, status: 200 }, error: null }).gateway.requestNotificationEmailVerification())
      .resolves.toEqual({ sent: false, dryRun: true })
  })

  it.each([[401, '登录状态已失效'], [404, '尚未部署'], [429, '发送过于频繁'], [500, '暂时不可用']])(
    'HTTP %s 转换为中文错误', async (status, message) => {
      const error = { context: new Response(null, { status }) }
      await expect(gatewayWith({ data: null, error }).gateway.requestNotificationEmailVerification()).rejects.toThrow(message)
    },
  )
})
