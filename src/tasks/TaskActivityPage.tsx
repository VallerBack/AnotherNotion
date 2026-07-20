import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/auth-context'
import { Comments, Reminders } from './TaskWorkspace'
import type { TaskRecord, TaskRepository } from './task-repository'

type ActivityState = { from?: string; scrollY?: number; cachedTask?: TaskRecord }

export function TaskActivityPage({ repository }: { repository: TaskRepository }) {
  const { taskId } = useParams<{ taskId: string }>()
  const { memberships } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const state = location.state as ActivityState | null
  const candidate = state?.cachedTask
  const cached: TaskRecord | null = candidate && candidate.id === taskId ? candidate : null
  const [task, setTask] = useState<TaskRecord | null>(cached)
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const next = taskId ? await repository.getTask(memberships[0].workspaceId, taskId) : null
        if (active) { setTask(next); setError(next ? null : '任务不存在、已删除或无权访问。') }
      } catch { if (active) setError('暂时无法加载提醒与评论，请稍后重试。') }
      finally { if (active) setLoading(false) }
    }
    void load()
    const unsubscribe = repository.subscribeWorkspace?.(memberships[0].workspaceId, () => { void load() })
    return () => { active = false; unsubscribe?.() }
  }, [memberships, repository, taskId])

  const back = () => navigate(state?.from && /^\/(today|calendar|tasks|my-tasks|trash|labels)/.test(state.from) ? state.from : '/tasks', { replace: true })
  if (loading && !task) return <section className="content-panel" aria-busy="true">正在加载提醒与评论…</section>
  if (!task) return <section className="content-panel"><button className="button" onClick={back}>← 返回</button><div role="alert" className="notice notice--error">{error}</div></section>
  return <section className="content-panel task-activity">
    <button className="button" onClick={back}>← 返回</button>
    <div className="section-heading"><div><p className="eyebrow">任务活动</p><h2>{task.title}</h2></div></div>
    {error && <div role="alert" className="notice notice--error">{error} 当前显示最近数据。</div>}
    <nav className="detail-tabs" aria-label="任务页面">
      <Link to={`/tasks/${task.id}`} state={state}>任务详情</Link>
      <Link className="active" to={`/tasks/${task.id}/activity`} state={state}>提醒与评论</Link>
    </nav>
    <Reminders repository={repository} task={task} />
    <Comments repository={repository} task={task} />
  </section>
}
