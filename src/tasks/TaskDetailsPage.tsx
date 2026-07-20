import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/auth-context'
import { DEFAULT_TIMEZONE, formatInTimezone, timezoneLabel } from '../lib/datetime'
import type {
  TaskRecord,
  TaskReminder,
  TaskRepository,
  WorkspaceLabel,
  WorkspaceMember,
} from './task-repository'

type TaskDetailLocationState = {
  from?: string
  scrollY?: number
  cachedTask?: TaskRecord
}

const statusLabels = { todo: '待处理', in_progress: '进行中', done: '已完成' } as const
const priorityLabels = { low: '低', medium: '中', high: '高', urgent: '紧急' } as const
const scheduleLabels = { none: '无日期', all_day: '全天任务', timed: '精确时间' } as const

function validReturnPath(value: string | undefined) {
  return value && /^\/(today|calendar|tasks|my-tasks|trash|labels)(?:[/?]|$)/.test(value)
    ? value
    : '/tasks'
}

export function TaskDetailsPage({ repository }: { repository: TaskRepository }) {
  const { taskId } = useParams<{ taskId: string }>()
  const { profile, memberships } = useAuth()
  const workspace = memberships[0]
  const location = useLocation()
  const navigate = useNavigate()
  const locationState = location.state as TaskDetailLocationState | null
  const candidateTask = locationState?.cachedTask
  let cachedTask: TaskRecord | null = null
  if (candidateTask && candidateTask.id === taskId && candidateTask.workspaceId === workspace.workspaceId) {
    cachedTask = candidateTask
  }
  const [task, setTask] = useState<TaskRecord | null>(cachedTask)
  const [labels, setLabels] = useState<WorkspaceLabel[]>([])
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [reminders, setReminders] = useState<TaskReminder[]>([])
  const [loading, setLoading] = useState(!cachedTask)
  const [error, setError] = useState<string | null>(null)
  const timezone = profile?.timezone ?? DEFAULT_TIMEZONE

  const load = useCallback(async (active: () => boolean, background = false) => {
    if (!taskId) return
    if (!background) setLoading(true)
    try {
      const nextTask = await repository.getTask(workspace.workspaceId, taskId)
      if (!active()) return
      if (!nextTask) {
        setTask(null)
        setError('任务不存在、已被永久删除，或你没有权限查看。')
        return
      }
      setTask(nextTask)
      const [nextLabels, nextMembers, nextReminders] = await Promise.all([
        repository.listLabels(workspace.workspaceId),
        repository.listMembers(workspace.workspaceId),
        repository.listTaskReminders(workspace.workspaceId, taskId),
      ])
      if (!active()) return
      setLabels(nextLabels)
      setMembers(nextMembers)
      setReminders(nextReminders)
      setError(null)
    } catch (reason) {
      if (!active()) return
      setError(reason instanceof Error ? reason.message : '加载任务详情失败。')
    } finally {
      if (active()) setLoading(false)
    }
  }, [repository, taskId, workspace.workspaceId])

  useEffect(() => {
    let active = true
    const isActive = () => active
    void load(isActive, Boolean(cachedTask))
    const unsubscribe = repository.subscribeWorkspace?.(workspace.workspaceId, () => {
      void load(isActive, true)
    })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [cachedTask, load, repository, workspace.workspaceId])

  const memberNames = useMemo(
    () => new Map(members.map((member) => [member.userId, member.displayName])),
    [members],
  )
  const labelNames = useMemo(
    () => task?.labelIds.map((id) => labels.find((label) => label.id === id)?.name).filter(Boolean) as string[] ?? [],
    [labels, task?.labelIds],
  )
  const activeReminders = reminders.filter((reminder) => ['pending', 'processing', 'failed'].includes(reminder.status))

  function goBack() {
    const target = validReturnPath(locationState?.from)
    navigate(target, { replace: true })
    if ((locationState?.scrollY ?? 0) > 0) {
      requestAnimationFrame(() => window.scrollTo({ top: locationState!.scrollY, behavior: 'auto' }))
    }
  }

  if (loading && !task) {
    return <section className="content-panel" aria-busy="true"><p className="empty-state">正在加载任务详情…</p></section>
  }

  if (!task) {
    return <section className="content-panel task-detail-error">
      <button className="button" onClick={goBack}>← 返回</button>
      <div className="notice notice--error" role="alert">{error ?? '任务不存在或无法访问。'}</div>
    </section>
  }

  return <section className="content-panel task-detail" aria-label="任务详情">
    <button className="button task-detail__back" onClick={goBack}>← 返回</button>
    {error && <div className="notice notice--error" role="alert">{error} 当前仍显示最近一次成功加载的详情。</div>}
    <div className="section-heading">
      <div><p className="eyebrow">只读任务详情</p><h2>{task.title}</h2></div>
      {task.deletedAt && <span className="status-pill status--cancelled">位于回收站</span>}
    </div>
    <dl className="task-detail__grid">
      <div><dt>状态</dt><dd>{statusLabels[task.status]}</dd></div>
      <div><dt>优先级</dt><dd>{priorityLabels[task.priority]}</dd></div>
      <div><dt>负责人</dt><dd>{task.assigneeId ? memberNames.get(task.assigneeId) ?? '未知成员' : '未分配负责人'}</dd></div>
      <div><dt>标签</dt><dd>{labelNames.length > 0 ? labelNames.join('、') : '没有标签'}</dd></div>
      <div><dt>日期类型</dt><dd>{scheduleLabels[task.scheduleKind]}</dd></div>
      <div><dt>开始时间</dt><dd>{task.scheduleKind === 'all_day' ? task.startDate ?? '未设置' : formatInTimezone(task.startAt, timezone)}</dd></div>
      <div><dt>截止时间</dt><dd>{task.scheduleKind === 'all_day' ? task.dueDate ?? '未设置' : formatInTimezone(task.dueAt, timezone)}</dd></div>
      <div><dt>显示时区</dt><dd>{timezoneLabel(timezone)}</dd></div>
      <div><dt>创建者</dt><dd>{task.createdBy ? memberNames.get(task.createdBy) ?? '未知成员' : '历史任务未记录'}</dd></div>
      <div><dt>创建时间</dt><dd>{formatInTimezone(task.createdAt, timezone)}</dd></div>
      <div><dt>最后更新时间</dt><dd>{formatInTimezone(task.updatedAt, timezone)}</dd></div>
      <div><dt>回收站状态</dt><dd>{task.deletedAt ? `已移入（${formatInTimezone(task.deletedAt, timezone)}）` : '不在回收站'}</dd></div>
    </dl>
    <section className="task-detail__section">
      <h3>说明</h3>
      {task.descriptionMd
        ? <pre className="markdown-source">{task.descriptionMd}</pre>
        : <p className="muted">没有任务说明。</p>}
    </section>
    <section className="task-detail__section">
      <h3>邮件提醒</h3>
      <p>{activeReminders.length > 0 ? '已启用' : '未启用或没有待发送提醒'}</p>
      {reminders.length === 0 ? <p className="muted">没有提醒记录。</p> : <ul className="task-detail__reminders">
        {reminders.map((reminder) => <li key={reminder.id}>
          <span>{formatInTimezone(reminder.remindAt, timezone)}</span>
          <span>{memberNames.get(reminder.recipientUserId) ?? '未知成员'}</span>
          <span>{reminder.status}</span>
        </li>)}
      </ul>}
    </section>
  </section>
}
