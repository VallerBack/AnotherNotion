import { cleanup, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthApp } from '../App'
import type {
  AuthChange,
  AuthGateway,
  AuthSession,
  UserProfile,
  WorkspaceMembership,
} from './auth-gateway'

const session = {
  access_token: 'publishable-session-token',
  expires_at: 4_102_444_800,
  user: { id: 'user-1', email: 'member@example.test' },
} as AuthSession

class MockAuthGateway implements AuthGateway {
  currentSession: AuthSession | null = null
  profile: UserProfile = {
    id: 'user-1',
    displayName: '测试成员',
    timezone: 'Asia/Shanghai',
    mustChangePassword: false,
  }
  memberships: WorkspaceMembership[] = []
  signInError: Error | null = null
  private listener: ((change: AuthChange) => void) | null = null

  getSession = vi.fn(async () => this.currentSession)
  signIn = vi.fn(async () => {
    if (this.signInError) throw this.signInError
    this.currentSession = session
    return session
  })
  signOut = vi.fn(async () => {
    this.currentSession = null
  })
  updatePassword = vi.fn(async () => undefined)
  updateProfile = vi.fn(async () => undefined)
  loadProfile = vi.fn(async (userId: string) => ({ ...this.profile, id: userId }))
  loadMemberships = vi.fn(async () => this.memberships)
  loadTaskCount = vi.fn(async () => 3)

  onAuthStateChange(listener: (change: AuthChange) => void) {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }

  emit(change: AuthChange) {
    this.listener?.(change)
  }
}

const membership: WorkspaceMembership = {
  workspaceId: 'workspace-1',
  workspaceName: '产品小组',
}

afterEach(() => {
  cleanup()
  window.location.hash = ''
})

async function logIn(gateway: MockAuthGateway) {
  const user = userEvent.setup()
  await screen.findByRole('heading', { name: 'AnotherNotion' })
  await user.type(screen.getByLabelText('邮箱'), 'member@example.test')
  await user.type(screen.getByLabelText('密码'), 'correct-password')
  await user.click(screen.getByRole('button', { name: '登录' }))
  return gateway
}

describe('认证访问控制', () => {
  it('未登录不能进入受保护应用', async () => {
    window.location.hash = '#/settings/password'
    const gateway = new MockAuthGateway()
    render(<AuthApp gateway={gateway} />)

    expect(await screen.findByRole('button', { name: '登录' })).toBeInTheDocument()
    expect(screen.queryByText('修改密码')).not.toBeInTheDocument()
    expect(gateway.loadTaskCount).not.toHaveBeenCalled()
  })

  it('邮箱密码登录成功后加载 profile、membership 和工作区', async () => {
    const gateway = new MockAuthGateway()
    gateway.memberships = [membership]
    render(<AuthApp gateway={gateway} />)
    await logIn(gateway)

    expect(await screen.findByRole('heading', { name: '产品小组' })).toBeInTheDocument()
    expect(gateway.signIn).toHaveBeenCalledWith(
      'member@example.test',
      'correct-password',
    )
    expect(gateway.loadProfile).toHaveBeenCalledWith('user-1')
    expect(gateway.loadMemberships).toHaveBeenCalledWith('user-1')
    await waitFor(() => expect(gateway.loadTaskCount).toHaveBeenCalledWith('workspace-1'))
  })

  it('错误密码显示明确提示', async () => {
    const gateway = new MockAuthGateway()
    gateway.signInError = new Error('Invalid login credentials')
    render(<AuthApp gateway={gateway} />)
    await logIn(gateway)

    expect(await screen.findByRole('alert')).toHaveTextContent('邮箱或密码错误')
    expect(gateway.loadProfile).not.toHaveBeenCalled()
  })

  it('TOKEN_REFRESHED 静默更新 session，不重新进入全屏加载或重复初始化账户', async () => {
    const gateway = new MockAuthGateway()
    gateway.currentSession = session
    gateway.memberships = [membership]
    render(<AuthApp gateway={gateway} />)

    expect(await screen.findByRole('heading', { name: '产品小组' })).toBeInTheDocument()
    gateway.emit({
      event: 'TOKEN_REFRESHED',
      session: { ...session, access_token: 'refreshed-session-token' },
    })

    await waitFor(() => expect(gateway.loadProfile).toHaveBeenCalledTimes(1))
    expect(gateway.loadMemberships).toHaveBeenCalledTimes(1)
    expect(gateway.getSession).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('正在恢复登录状态…')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '产品小组' })).toBeInTheDocument()
  })

  it('相同用户的重复 SIGNED_IN 静默更新且不重新 hydrate', async () => {
    const gateway = new MockAuthGateway()
    gateway.currentSession = session
    gateway.memberships = [membership]
    render(<AuthApp gateway={gateway} />)
    await screen.findByRole('heading', { name: '产品小组' })

    gateway.emit({
      event: 'SIGNED_IN',
      session: { ...session, access_token: 'focus-restored-session-token' },
    })

    await waitFor(() => expect(screen.queryByText('正在恢复登录状态…')).not.toBeInTheDocument())
    expect(screen.getByRole('heading', { name: '产品小组' })).toBeInTheDocument()
    expect(gateway.loadProfile).toHaveBeenCalledTimes(1)
    expect(gateway.loadMemberships).toHaveBeenCalledTimes(1)
  })

  it('不同 user.id 的 SIGNED_IN 会重新加载对应账户', async () => {
    const gateway = new MockAuthGateway()
    gateway.currentSession = session
    gateway.memberships = [membership]
    render(<AuthApp gateway={gateway} />)
    await screen.findByRole('heading', { name: '产品小组' })

    gateway.emit({
      event: 'SIGNED_IN',
      session: {
        ...session,
        access_token: 'different-user-session-token',
        user: { ...session.user, id: 'user-2' },
      },
    })

    await waitFor(() => expect(gateway.loadProfile).toHaveBeenCalledWith('user-2'))
    expect(gateway.loadMemberships).toHaveBeenCalledWith('user-2')
    expect(gateway.loadProfile).toHaveBeenCalledTimes(2)
  })

  it('从未登录状态真正登录仍初始化 profile 和 membership', async () => {
    const gateway = new MockAuthGateway()
    gateway.memberships = [membership]
    render(<AuthApp gateway={gateway} />)
    await logIn(gateway)

    expect(await screen.findByRole('heading', { name: '产品小组' })).toBeInTheDocument()
    expect(gateway.loadProfile).toHaveBeenCalledTimes(1)
    expect(gateway.loadMemberships).toHaveBeenCalledTimes(1)
  })

  it('无 membership 时显示等待状态且绝不加载任务', async () => {
    const gateway = new MockAuthGateway()
    gateway.currentSession = session
    render(<AuthApp gateway={gateway} />)

    expect(await screen.findByText('等待管理员添加')).toBeInTheDocument()
    expect(gateway.loadTaskCount).not.toHaveBeenCalled()
  })

  it('会话过期后立即返回登录页面', async () => {
    const gateway = new MockAuthGateway()
    gateway.currentSession = session
    gateway.memberships = [membership]
    render(<AuthApp gateway={gateway} />)
    await screen.findByRole('heading', { name: '产品小组' })

    gateway.emit({ event: 'SIGNED_OUT', session: null })

    expect(await screen.findByText('会话已过期，请重新登录。')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '产品小组' })).not.toBeInTheDocument()
  })

  it('登录用户可以修改密码和退出登录', async () => {
    const gateway = new MockAuthGateway()
    gateway.currentSession = session
    gateway.memberships = [membership]
    render(<AuthApp gateway={gateway} />)
    const user = userEvent.setup()
    await screen.findByRole('heading', { name: '产品小组' })

    await user.click(screen.getByRole('link', { name: '设置' }))
    await user.type(screen.getByLabelText('新密码'), 'new-password')
    await user.type(screen.getByLabelText('确认新密码'), 'new-password')
    await user.click(screen.getByRole('button', { name: '更新密码' }))
    expect(await screen.findByText('密码已更新。')).toBeInTheDocument()
    expect(gateway.updatePassword).toHaveBeenCalledWith('new-password')

    await user.click(screen.getByRole('button', { name: '退出登录' }))
    expect(await screen.findByRole('button', { name: '登录' })).toBeInTheDocument()
    expect(gateway.signOut).toHaveBeenCalledOnce()
  })

  it('临时密码账户在修改密码前不能进入工作区', async () => {
    const gateway = new MockAuthGateway()
    gateway.currentSession = session
    gateway.memberships = [membership]
    gateway.profile = { ...gateway.profile, mustChangePassword: true }
    render(<AuthApp gateway={gateway} />)

    expect(await screen.findByRole('heading', { name: '首次登录，请先修改密码' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '产品小组' })).not.toBeInTheDocument()
  })

  it('设置页隐藏旧邮件配置并显示频道提醒说明', async () => {
    window.location.hash = '#/settings'
    const gateway = new MockAuthGateway()
    gateway.currentSession = session
    gateway.memberships = [membership]
    render(<AuthApp gateway={gateway} />)
    expect(await screen.findByText(/频道提醒由外部机器人定时读取/)).toBeInTheDocument()
    expect(screen.queryByLabelText('通知邮箱')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '发送验证邮件' })).not.toBeInTheDocument()
  })
})
