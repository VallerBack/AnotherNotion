import { cleanup, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthApp } from '../App'
import type { AuthChange, AuthGateway, AuthSession } from '../auth/auth-gateway'
import type {
  TaskDraft,
  TaskRecord,
  TaskRepository,
  TaskView,
} from './task-repository'

const session = {
  access_token: 'session-token',
  user: { id: 'user-1', email: 'member@example.test' },
} as AuthSession

class AuthMock implements AuthGateway {
  role: 'owner' | 'member' = 'member'
  getSession = vi.fn(async () => session)
  onAuthStateChange(listener: (change: AuthChange) => void) { void listener; return () => undefined }
  signIn = vi.fn(async () => session)
  signOut = vi.fn(async () => undefined)
  updatePassword = vi.fn(async () => undefined)
  loadProfile = vi.fn(async () => ({ id: 'user-1', displayName: '成员', timezone: 'UTC' }))
  loadMemberships = vi.fn(async () => [{ workspaceId: 'workspace-1', workspaceName: 'AnotherNotion', role: this.role }])
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
  scheduleKind: 'none',
  startDate: null,
  startAt: null,
  dueDate: null,
  dueAt: null,
  deletedAt: null,
  labelIds: [],
}

class TaskRepositoryMock implements TaskRepository {
  tasks: TaskRecord[] = []
  error: Error | null = null
  listTasks = vi.fn(async (workspaceId: string, userId: string, view: TaskView) => {
    void workspaceId
    void userId
    void view
    if (this.error) throw this.error
    return this.tasks
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
  listLabels = vi.fn(async () => [])
  createLabel = vi.fn(async () => undefined)
  listMembers = vi.fn(async () => [{ userId: 'user-1', displayName: '成员', role: 'member' as const }])
  listComments = vi.fn(async () => [])
  addComment = vi.fn(async () => undefined)
}

afterEach(() => {
  cleanup()
  window.location.hash = ''
})

describe('核心任务模块', () => {
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
    await user.click(await screen.findByRole('button', { name: '永久删除' }))
    await waitFor(() => expect(memberRepository.permanentlyDeleteTask).toHaveBeenCalledWith('task-1'))
  })

  it('显示 RLS 权限错误并提供重试入口', async () => {
    const repository = new TaskRepositoryMock()
    repository.error = new Error('没有权限执行此操作，请重新登录或联系工作区 owner。')
    render(<AuthApp gateway={new AuthMock()} taskRepository={repository} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('没有权限执行此操作')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})
