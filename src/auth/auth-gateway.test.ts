import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import type { Database } from '../types/database'
import { SupabaseAuthGateway } from './auth-gateway'

describe('profile gateway', () => {
  it('只向自己的 profile 提交 display_name 和 timezone', async () => {
    const eq = vi.fn(async () => ({ error: null }))
    const update = vi.fn((values: Record<string, string>) => {
      void values
      return { eq }
    })
    const from = vi.fn(() => ({ update }))
    const gateway = new SupabaseAuthGateway({ from } as unknown as SupabaseClient<Database>)

    await gateway.updateProfile('user-1', {
      displayName: '  测试成员  ',
      timezone: 'Asia/Shanghai',
    })

    expect(from).toHaveBeenCalledWith('profiles')
    expect(update).toHaveBeenCalledWith({
      display_name: '测试成员',
      timezone: 'Asia/Shanghai',
    })
    expect(eq).toHaveBeenCalledWith('id', 'user-1')
    expect(Object.keys(update.mock.calls[0][0])).toEqual(['display_name', 'timezone'])
  })

  it('修改密码后调用受保护 RPC 清除 must_change_password', async () => {
    const updateUser = vi.fn(async () => ({ error: null }))
    const rpc = vi.fn(async () => ({ error: null }))
    const gateway = new SupabaseAuthGateway({ auth: { updateUser }, rpc } as unknown as SupabaseClient<Database>)

    await gateway.updatePassword('new-password')

    expect(updateUser).toHaveBeenCalledWith({ password: 'new-password' })
    expect(rpc).toHaveBeenCalledWith('complete_password_change')
  })
})
