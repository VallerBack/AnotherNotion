import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/auth-context'
import { Comments, Reminders } from './TaskWorkspace'
import type { TaskRecord, TaskRepository } from './task-repository'

type ActivityState = {
  from?: string
  scrollY?: number
  cachedTask?: TaskRecord
  previousState?: ActivityState | null
}

function validReturnPath(value: string | undefined) {
  return value && /^\/(today|calendar|tasks|my-tasks|trash|labels)(?:[/?]|$)/.test(value)
    ? value
    : '/tasks'
}

export function TaskActivityPage({ repository }: { repository: TaskRepository }) {
  const { taskId } = useParams<{ taskId: string }>()
  const { memberships } = useAuth()
  const workspaceId = memberships[0]?.workspaceId
  const location = useLocation()
  const navigate = useNavigate()
  const state = location.state as ActivityState | null
  const candidate = state?.cachedTask
  const cached: TaskRecord | null = candidate && candidate.id === taskId ? candidate : null
  const [task, setTask] = useState<TaskRecord | null>(cached)
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)
  const hasLoaded = useRef(Boolean(cached))
  const loadRequestId = useRef(0)

  const load = useCallback(async (active: () => boolean, background = false) => {
    const requestId = ++loadRequestId.current
    if (!workspaceId || !taskId) {
      if (active()) { setTask(null); setError('任务链接不完整。'); setLoading(false) }
      return
    }
    if (!background && !hasLoaded.current) setLoading(true)
    try {
      const next = await repository.getTask(workspaceId, taskId)
      if (!active() || requestId !== loadRequestId.current) return
      setTask(next)
      setError(next ? null : '任务不存在、已永久删除或无权访问。')
      hasLoaded.current = true
    } catch {
      if (active() && requestId === loadRequestId.current) setError('暂时无法加载提醒与评论。当前内容将保留，请稍后重试。')
    } finally {
      if (active() && requestId === loadRequestId.current) setLoading(false)
    }
  }, [repository, taskId, workspaceId])

  useEffect(() => {
    let active = true
    const isActive = () => active
    void load(isActive, hasLoaded.current)
    const unsubscribe = workspaceId
      ? repository.subscribeWorkspace?.(workspaceId, () => { void load(isActive, true) })
      : undefined
    return () => { active = false; loadRequestId.current += 1; unsubscribe?.() }
  }, [load, repository, workspaceId])

  const back = () => {
    navigate(validReturnPath(state?.from), { replace: true, state: state?.previousState ?? null })
    if ((state?.scrollY ?? 0) > 0) {
      requestAnimationFrame(() => window.scrollTo({ top: state!.scrollY, behavior: 'auto' }))
    }
  }
  if (loading && !task) return <section className="content-panel" aria-busy="true">正在加载提醒与评论…</section>
  if (!task) return <section className="content-panel"><button className="button" onClick={back}>← 返回</button><div role="alert" className="notice notice--error">{error}</div></section>
  return <section className="content-panel task-activity">
    <button className="button" onClick={back}>← 返回</button>
    <div className="section-heading"><div><p className="eyebrow">任务活动</p><h2>{task.title}</h2></div></div>
    {error && <div role="alert" className="notice notice--error">{error} 当前显示最近数据。</div>}
    <nav className="detail-tabs" aria-label="任务页面">
      <Link to={`/tasks/${task.id}`} state={state?.previousState ?? state}>任务详情</Link>
      <Link className="active" to={`/tasks/${task.id}/activity`} state={state}>提醒与评论</Link>
    </nav>
    {task.deletedAt && <div className="notice">该任务位于回收站。可以查看历史提醒和评论，但不能新增或修改内容。</div>}
    <Reminders repository={repository} task={task} readOnly={Boolean(task.deletedAt)} />
    <Comments repository={repository} task={task} readOnly={Boolean(task.deletedAt)} />
  </section>
}
