import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthApp } from '../App'
import type { AuthChange, AuthGateway, AuthSession } from '../auth/auth-gateway'
import type {
  TaskDraft,
  TaskRecord,
  TaskRepository,
  TaskView,
  WorkspaceLabel,
} from './task-repository'

const session = {
  access_token: 'session-token',
  user: { id: 'user-1', email: 'member@example.test' },
} as AuthSession

class AuthMock implements AuthGateway {
  private listener: ((change: AuthChange) => void) | null = null
  getSession = vi.fn(async () => session)
  onAuthStateChange(listener: (change: AuthChange) => void) {
    this.listener = listener
    return () => { this.listener = null }
  }
  emit(change: AuthChange) { this.listener?.(change) }
  signIn = vi.fn(async () => session)
  signOut = vi.fn(async () => undefined)
  updatePassword = vi.fn(async () => undefined)
  updateProfile = vi.fn(async () => undefined)
  requestNotificationEmailVerification = vi.fn(async () => ({ sent: true, dryRun: false }))
  verifyNotificationEmail = vi.fn(async () => undefined)
  loadProfile = vi.fn(async () => ({
    id: 'user-1', displayName: '成员', timezone: 'UTC',
    notificationEmail: null, notificationEmailVerifiedAt: null,
    emailNotificationsEnabled: false, mustChangePassword: false,
  }))
  loadMemberships = vi.fn(async () => [{ workspaceId: 'workspace-1', workspaceName: 'AnotherNotion' }])
  loadTaskCount = vi.fn(async () => 0)
}

const task: TaskRecord = {
  id: 'task-1',
  workspaceId: 'workspace-1',
  title: '准备发布',
  descriptionMd: '**检查清单**',
  status: 'todo',
  priority: 'high',
  assigneeId: 'user-1',
  assigneeIds: ['user-1'],
  scheduleKind: 'none',
  startDate: null,
  startAt: null,
  dueDate: null,
  dueAt: null,
  createdBy: 'user-1',
  createdAt: '2026-07-19T16:00:00.000Z',
  updatedAt: '2026-07-20T01:00:00.000Z',
  deletedAt: null,
  labelIds: [],
}

class TaskRepositoryMock implements TaskRepository {
  tasks: TaskRecord[] = []
  reminders = [] as Awaited<ReturnType<TaskRepository['listTaskReminders']>>
  reminderRecipients = [{ userId: 'user-1', displayName: '成员', canReceiveEmail: true }]
  labels = [] as WorkspaceLabel[]
  members = [{ userId: 'user-1', displayName: '成员' }]
  error: Error | null = null
  listTasks = vi.fn(async (workspaceId: string, userId: string, view: TaskView) => {
    void workspaceId
    void userId
    void view
    if (this.error) throw this.error
    return this.tasks
  })
  getTask = vi.fn(async (_workspaceId: string, taskId: string) => {
    if (this.error) throw this.error
    return this.tasks.find((item) => item.id === taskId) ?? null
  })
  createTask = vi.fn(async (workspaceId: string, userId: string, draft: TaskDraft) => {
    void workspaceId
    void userId
    return { ...task, ...draft }
  })
  updateTask = vi.fn(async () => undefined)
  softDeleteTask = vi.fn(async () => undefined)
  restoreTask = vi.fn(async () => undefined)
  permanentlyDeleteTask = vi.fn(async () => undefined)
  listLabels = vi.fn(async () => this.labels)
  createLabel = vi.fn(async () => undefined)
  updateLabel = vi.fn(async () => undefined)
  deleteLabel = vi.fn(async () => undefined)
  listMembers = vi.fn(async () => this.members)
  listComments = vi.fn(async () => [])
  addComment = vi.fn(async () => undefined)
  updateComment = vi.fn(async () => undefined)
  deleteComment = vi.fn(async () => undefined)
  listEligibleReminderRecipients = vi.fn(async () => this.reminderRecipients)
  listTaskReminders = vi.fn(async () => this.reminders)
  createTaskReminders = vi.fn(async () => undefined)
  cancelTaskReminder = vi.fn(async () => undefined)
  rescheduleTaskReminder = vi.fn(async () => undefined)
}

beforeEach(() => {
  vi.spyOn(window, 'alert').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  window.location.hash = ''
  vi.restoreAllMocks()
})

describe('核心任务模块', () => {
  it('点击任务主体进入只读详情并显示实际字段、创建者、标签和提醒', async () => {
    window.location.hash = '#/tasks'
    const repository = new TaskRepositoryMock()
    repository.tasks = [{
      ...task,
      descriptionMd: '# 发布说明',
      scheduleKind: 'timed',
      startAt: '2026-07-20T01:00:00.000Z',
      dueAt: '2026-07-20T02:00:00.000Z',
      labelIds: ['label-1'],
    }]
    repository.labels = [{ id: 'label-1', name: '发布', color: '#ef4444' }]
    repository.reminders = [{
      id: 'reminder-1', taskId: 'task-1', recipientUserId: 'user-1',
      remindAt: '2026-07-20T00:30:00.000Z', status: 'pending',
      attemptCount: 0, sentAt: null, lastError: null,
      createdAt: '2026-07-19T00:00:00.000Z',
    }]
    render(<AuthApp gateway={new AuthMock()} taskRepository={repository} />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('link', { name: '查看任务：准备发布' }))

    expect(await screen.findByRole('heading', { name: '准备发布' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/tasks/task-1')
    expect(screen.getByRole('heading', { name: '发布说明' })).toBeInTheDocument()
    expect(screen.getByText('发布')).toBeInTheDocument()
    expect(screen.getAllByText('成员').length).toBeGreaterThan(0)
    expect(screen.getAllByText('2026年7月20日 01:00').length).toBeGreaterThan(0)
    expect(screen.getByText('2026年7月20日 02:00')).toBeInTheDocument()
    expect(screen.getByText('已启用')).toBeInTheDocument()
    expect(screen.getByText('2026年7月19日 16:00')).toBeInTheDocument()
  })

  it('历史任务没有 created_by 时明确显示未记录', async () => {
    window.location.hash = '#/tasks/task-1'
    const repository = new TaskRepositoryMock()
    repository.tasks = [{ ...task, createdBy: null }]
    render(<AuthApp gateway={new AuthMock()} taskRepository={repository} />)

    expect(await screen.findByText('历史任务未记录')).toBeInTheDocument()
  })

  it('返回按钮回到进入前页面，直接打开详情时回到全部任务', async () => {
    window.location.hash = '#/today'
    const repository = new TaskRepositoryMock()
    repository.tasks = [task]
    const user = userEvent.setup()
    const view = render(<AuthApp gateway={new AuthMock()} taskRepository={repository} />)

    await user.click(await screen.findByRole('link', { name: '查看任务：准备发布' }))
    await user.click(await screen.findByRole('button', { name: '← 返回' }))
    expect(await screen.findByRole('heading', { name: '今日任务' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/today')

    view.unmount()
    window.location.hash = '#/tasks/task-1'
    render(<AuthApp gateway={new AuthMock()} taskRepository={repository} />)
    await user.click(await screen.findByRole('button', { name: '← 返回' }))
    expect(await screen.findByRole('heading', { name: '全部任务' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/tasks')
  })

  it('从回收站进入详情后返回回收站', async () => {
    window.location.hash = '#/trash'
    const repository = new TaskRepositoryMock()
    repository.tasks = [{ ...task, deletedAt: '2026-07-20T03:00:00.000Z' }]
    render(<AuthApp gateway={new AuthMock()} taskRepository={repository} />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('link', { name: '查看任务：准备发布' }))
    expect(await screen.findByText('位于回收站')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '← 返回' }))
    expect(await screen.findByRole('heading', { name: '回收站' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/trash')
  })

  it('从带标签筛选的日历进入详情后保留筛选来源', async () => {
    window.location.hash = '#/calendar?label=label-1'
    const repository = new TaskRepositoryMock()
    repository.labels = [{ id: 'label-1', name: '发布', color: '#ef4444' }]
    repository.tasks = [{
      ...task,
      scheduleKind: 'timed',
      startAt: '2026-07-20T01:00:00.000Z',
      dueAt: '2026-07-20T02:00:00.000Z',
      labelIds: ['label-1'],
    }]
    render(<AuthApp gateway={new AuthMock()} taskRepository={repository} />)
    const user = userEvent.setup()

    fireEvent.click(await screen.findByRole('link', { name: '查看任务：准备发布' }))
    expect(await screen.findByRole('heading', { name: '准备发布' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '← 返回' }))

    expect(await screen.findByRole('heading', { name: '日历' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/calendar?label=label-1')
    expect(screen.getByLabelText('标签')).toHaveValue('label-1')
  })

  it('任务不存在或查询失败时显示中文提示和返回按钮', async () => {
    window.location.hash = '#/tasks/missing-task'
    const repository = new TaskRepositoryMock()
    const view = render(<AuthApp gateway={new AuthMock()} taskRepository={repository} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('任务不存在')
    expect(screen.getByRole('button', { name: '← 返回' })).toBeInTheDocument()

    view.unmount()
    const failingRepository = new TaskRepositoryMock()
    failingRepository.error = new Error('网络连接失败，请稍后重试。')
    render(<AuthApp gateway={new AuthMock()} taskRepository={failingRepository} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('网络连接失败')
    expect(screen.getByRole('button', { name: '← 返回' })).toBeInTheDocument()
  })

  it('重复认证事件不会卸载直接刷新打开的详情页', async () => {
    window.location.hash = '#/tasks/task-1'
    const auth = new AuthMock()
    const repository = new TaskRepositoryMock()
    repository.tasks = [task]
    render(<AuthApp gateway={auth} taskRepository={repository} />)
    await screen.findByRole('heading', { name: '准备发布' })

    auth.emit({ event: 'SIGNED_IN', session: { ...session, access_token: 'same-user-token' } })

    expect(screen.queryByText('正在恢复登录状态…')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '准备发布' })).toBeInTheDocument()
    expect(screen.getByLabelText('主导航')).toBeInTheDocument()
    expect(auth.loadProfile).toHaveBeenCalledTimes(1)
  })

  it('侧栏路由导航不触发整页重载或重新初始化认证', async () => {
    const auth = new AuthMock()
    const repository = new TaskRepositoryMock()
    render(<AuthApp gateway={auth} taskRepository={repository} />)
    const user = userEvent.setup()
    const beforeUnload = vi.fn()
    window.addEventListener('beforeunload', beforeUnload)

    expect(await screen.findByRole('heading', { name: '今日任务' })).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: '全部任务' }))

    expect(await screen.findByRole('heading', { name: '全部任务' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/tasks')
    expect(auth.getSession).toHaveBeenCalledTimes(1)
    expect(beforeUnload).not.toHaveBeenCalled()
    window.removeEventListener('beforeunload', beforeUnload)
  })

  it('visibilitychange 不清空当前任务、页面状态或触发全量重载', async () => {
    window.location.hash = '#/tasks'
    const repository = new TaskRepositoryMock()
    repository.tasks = [task]
    render(<AuthApp gateway={new AuthMock()} taskRepository={repository} />)

    expect(await screen.findByText('准备发布')).toBeInTheDocument()
    document.dispatchEvent(new Event('visibilitychange'))

    expect(screen.getByText('准备发布')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '全部任务' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/tasks')
    expect(repository.listTasks).toHaveBeenCalledTimes(1)
  })

  it('标签页重新获得焦点并收到重复 SIGNED_IN 时保持布局、侧栏和当前页面', async () => {
    window.location.hash = '#/tasks'
    const auth = new AuthMock()
    const repository = new TaskRepositoryMock()
    repository.tasks = [task]
    render(<AuthApp gateway={auth} taskRepository={repository} />)
    await screen.findByText('准备发布')

    window.dispatchEvent(new Event('focus'))
    auth.emit({
      event: 'SIGNED_IN',
      session: { ...session, access_token: 'focus-restored-session-token' },
    })

    await waitFor(() => expect(screen.queryByText('正在恢复登录状态…')).not.toBeInTheDocument())
    expect(screen.getByLabelText('主导航')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '全部任务' })).toBeInTheDocument()
    expect(screen.getByText('准备发布')).toBeInTheDocument()
    expect(auth.getSession).toHaveBeenCalledTimes(1)
    expect(auth.loadProfile).toHaveBeenCalledTimes(1)
    expect(repository.listTasks).toHaveBeenCalledTimes(1)
  })

  it('创建任务时仅由认证上下文注入 workspace 和用户 ID', async () => {
    const auth = new AuthMock()
    const repository = new TaskRepositoryMock()
    render(<AuthApp gateway={auth} taskRepository={repository} />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: '创建任务' }))
    await user.type(screen.getByLabelText('标题'), '新任务')
    await user.click(screen.getByRole('button', { name: '保存任务' }))

    await waitFor(() => expect(repository.createTask).toHaveBeenCalledOnce())
    const [workspaceId, userId, draft] = repository.createTask.mock.calls[0]
    expect(workspaceId).toBe('workspace-1')
    expect(userId).toBe('user-1')
    expect(draft.title).toBe('新任务')
    expect(draft).not.toHaveProperty('workspace_id')
    expect(draft).not.toHaveProperty('created_by')
    expect(draft).not.toHaveProperty('author_id')
  })

  it('前端不按角色隐藏恢复或永久删除操作', async () => {
    window.location.hash = '#/trash'
    const memberAuth = new AuthMock()
    const memberRepository = new TaskRepositoryMock()
    memberRepository.tasks = [{ ...task, deletedAt: new Date().toISOString() }]
    render(<AuthApp gateway={memberAuth} taskRepository={memberRepository} />)
    const user = userEvent.setup()

    expect(await screen.findByRole('button', { name: '恢复' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '永久删除' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(memberRepository.restoreTask).toHaveBeenCalledWith('task-1'))
    await user.click(await screen.findByRole('button', { name: '永久删除' }))
    await waitFor(() => expect(memberRepository.permanentlyDeleteTask).toHaveBeenCalledWith('task-1'))
  })

  it('普通工作区成员可以完成、编辑和回收任意任务', async () => {
    window.location.hash = '#/tasks'
    const repository = new TaskRepositoryMock()
    repository.tasks = [task]
    render(<AuthApp gateway={new AuthMock()} taskRepository={repository} />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: '完成' }))
    await waitFor(() => expect(repository.updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'done' }),
    ))
    expect(window.location.hash).toBe('#/tasks')

    await user.click(screen.getByRole('button', { name: '编辑' }))
    expect(window.location.hash).toBe('#/tasks')
    const title = screen.getByLabelText('标题')
    await user.clear(title)
    await user.type(title, '更新后的任务')
    await user.click(screen.getByRole('button', { name: '保存任务' }))
    await waitFor(() => expect(repository.updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ title: '更新后的任务' }),
      expect.objectContaining({ enabled: false }),
    ))

    await user.click(screen.getByRole('button', { name: '移到回收站' }))
    await waitFor(() => expect(repository.softDeleteTask).toHaveBeenCalledWith('task-1'))
    expect(window.location.hash).toBe('#/tasks')
  })

  it('显示 RLS 权限错误并提供重试入口', async () => {
    const repository = new TaskRepositoryMock()
    repository.error = new Error('没有权限执行此操作，请重新登录或确认你仍属于该工作区。')
    render(<AuthApp gateway={new AuthMock()} taskRepository={repository} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('没有权限执行此操作')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('工作区成员可以为多个合格收件人创建 UTC 邮件提醒', async () => {
    window.location.hash = '#/tasks'
    const repository = new TaskRepositoryMock()
    repository.tasks = [task]
    render(<AuthApp gateway={new AuthMock()} taskRepository={repository} />)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('link', { name: '提醒与评论' }))
    expect(await screen.findByRole('heading', { name: '准备发布' })).toBeInTheDocument()
    await user.type(screen.getByLabelText(/提醒时间/), '2030-01-02T03:04')
    await user.click(screen.getByRole('checkbox', { name: /成员/ }))
    await user.click(screen.getByRole('button', { name: '创建提醒' }))

    await waitFor(() => expect(repository.createTaskReminders).toHaveBeenCalledWith(
      'task-1', ['user-1'], '2030-01-02T03:04:00.000Z',
    ))
  })

  it('无日期任务不能启用提醒，邮箱未就绪成员不可选择', async () => {
    const repository = new TaskRepositoryMock()
    repository.reminderRecipients = [{ userId: 'user-2', displayName: '未验证成员', canReceiveEmail: false }]
    render(<AuthApp gateway={new AuthMock()} taskRepository={repository} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '创建任务' }))

    expect(screen.getByRole('checkbox', { name: '启用邮件提醒' })).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('日期类型'), 'timed')
    await user.click(screen.getByRole('checkbox', { name: '启用邮件提醒' }))
    expect(screen.getByRole('checkbox', { name: /未验证成员/ })).toBeDisabled()
    expect(screen.queryByText(/@/)).not.toBeInTheDocument()
  })

  it('创建任务时为多个收件人提交同一个 UTC 提醒时刻', async () => {
    const repository = new TaskRepositoryMock()
    repository.reminderRecipients = [
      { userId: 'user-1', displayName: '成员', canReceiveEmail: true },
      { userId: 'user-2', displayName: '成员二', canReceiveEmail: true },
    ]
    render(<AuthApp gateway={new AuthMock()} taskRepository={repository} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '创建任务' }))
    await user.type(screen.getByLabelText('标题'), '提醒任务')
    await user.selectOptions(screen.getByLabelText('日期类型'), 'timed')
    await user.type(screen.getByLabelText('开始时间'), '2030-01-02T03:04')
    await user.click(screen.getByRole('checkbox', { name: '启用邮件提醒' }))
    await user.selectOptions(screen.getByLabelText(/提醒时间/), 'one_hour')
    await user.click(screen.getByRole('checkbox', { name: /成员二/ }))
    await user.click(screen.getByRole('button', { name: '保存任务' }))

    await waitFor(() => expect(repository.createTask).toHaveBeenCalledWith(
      'workspace-1', 'user-1', expect.objectContaining({ title: '提醒任务' }),
      { enabled: true, recipientUserIds: ['user-1', 'user-2'], remindAt: '2030-01-02T02:04:00.000Z' },
    ))
  })
})
