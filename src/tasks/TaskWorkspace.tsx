/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { DateTime } from 'luxon'
import { useAuth } from '../auth/auth-context'
import type {
  TaskComment,
  TaskDraft,
  TaskRecord,
  TaskRepository,
  TaskView,
  WorkspaceLabel,
  WorkspaceMember,
} from './task-repository'

export const emptyDraft: TaskDraft = {
  title: '',
  descriptionMd: '',
  status: 'todo',
  priority: 'medium',
  assigneeId: null,
  scheduleKind: 'none',
  startDate: null,
  startAt: null,
  dueDate: null,
  dueAt: null,
  labelIds: [],
}

const viewTitles: Record<TaskView, string> = {
  today: 'Today',
  calendar: 'Calendar',
  all: 'All Tasks',
  mine: 'My Tasks',
  trash: 'Trash',
}

function toLocalDateTime(value: string | null, timezone: string) {
  if (!value) return ''
  return DateTime.fromISO(value).setZone(timezone).toFormat("yyyy-MM-dd'T'HH:mm")
}

function fromLocalDateTime(value: string, timezone: string) {
  return value ? DateTime.fromFormat(value, "yyyy-MM-dd'T'HH:mm", { zone: timezone }).toUTC().toISO() : null
}

export function taskToDraft(task: TaskRecord): TaskDraft {
  return {
    title: task.title,
    descriptionMd: task.descriptionMd,
    status: task.status,
    priority: task.priority,
    assigneeId: task.assigneeId,
    scheduleKind: task.scheduleKind,
    startDate: task.startDate,
    startAt: task.startAt,
    dueDate: task.dueDate,
    dueAt: task.dueAt,
    labelIds: task.labelIds,
  }
}

function formatSchedule(task: TaskRecord, timezone: string) {
  if (task.scheduleKind === 'all_day') {
    return [task.startDate, task.dueDate].filter(Boolean).join(' → ') || '全天'
  }
  if (task.scheduleKind === 'timed') {
    return [task.startAt, task.dueAt]
      .filter(Boolean)
      .map((value) => DateTime.fromISO(value!).setZone(timezone).toLocaleString(DateTime.DATETIME_MED))
      .join(' → ')
  }
  return '无日期'
}

export function TaskEditor({
  task,
  initialDraft,
  labels,
  members,
  onSave,
  onCancel,
}: {
  task: TaskRecord | null
  initialDraft?: TaskDraft
  labels: WorkspaceLabel[]
  members: WorkspaceMember[]
  onSave(draft: TaskDraft): Promise<void>
  onCancel(): void
}) {
  const { profile } = useAuth()
  const timezone = profile?.timezone ?? 'UTC'
  const [draft, setDraft] = useState<TaskDraft>(() =>
    task ? taskToDraft(task) : initialDraft ?? emptyDraft,
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onSave(draft)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存任务失败')
    } finally {
      setSaving(false)
    }
  }

  function toggleLabel(labelId: string) {
    setDraft((current) => ({
      ...current,
      labelIds: current.labelIds.includes(labelId)
        ? current.labelIds.filter((id) => id !== labelId)
        : [...current.labelIds, labelId],
    }))
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="task-editor" role="dialog" aria-modal="true" aria-labelledby="task-editor-title">
        <div className="section-heading">
          <h2 id="task-editor-title">{task ? '编辑任务' : '创建任务'}</h2>
          <button className="icon-button" onClick={onCancel} aria-label="关闭">×</button>
        </div>
        {error && <div className="notice notice--error" role="alert">{error}</div>}
        <form className="form task-form" onSubmit={submit}>
          <label className="field--wide">标题
            <input required maxLength={300} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          </label>
          <label className="field--wide">Markdown 说明
            <textarea rows={6} value={draft.descriptionMd} onChange={(event) => setDraft({ ...draft, descriptionMd: event.target.value })} />
          </label>
          <label>状态
            <select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as TaskDraft['status'] })}>
              <option value="todo">Todo</option>
              <option value="in_progress">In Progress</option>
              <option value="done">Done</option>
            </select>
          </label>
          <label>优先级
            <select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value as TaskDraft['priority'] })}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
          <label>负责人
            <select value={draft.assigneeId ?? ''} onChange={(event) => setDraft({ ...draft, assigneeId: event.target.value || null })}>
              <option value="">未分配</option>
              {members.map((member) => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}
            </select>
          </label>
          <label>日期类型
            <select
              value={draft.scheduleKind}
              onChange={(event) => setDraft({
                ...draft,
                scheduleKind: event.target.value as TaskDraft['scheduleKind'],
                startDate: null,
                startAt: null,
                dueDate: null,
                dueAt: null,
              })}
            >
              <option value="none">无日期</option>
              <option value="all_day">全天任务</option>
              <option value="timed">精确时间</option>
            </select>
          </label>
          {draft.scheduleKind === 'all_day' && <>
            <label>开始日期
              <input type="date" value={draft.startDate ?? ''} onChange={(event) => setDraft({ ...draft, startDate: event.target.value || null })} />
            </label>
            <label>截止日期
              <input type="date" value={draft.dueDate ?? ''} onChange={(event) => setDraft({ ...draft, dueDate: event.target.value || null })} />
            </label>
          </>}
          {draft.scheduleKind === 'timed' && <>
            <label>开始时间
              <input type="datetime-local" value={toLocalDateTime(draft.startAt, timezone)} onChange={(event) => setDraft({ ...draft, startAt: fromLocalDateTime(event.target.value, timezone) })} />
            </label>
            <label>截止时间
              <input type="datetime-local" value={toLocalDateTime(draft.dueAt, timezone)} onChange={(event) => setDraft({ ...draft, dueAt: fromLocalDateTime(event.target.value, timezone) })} />
            </label>
          </>}
          <fieldset className="field--wide label-picker">
            <legend>标签</legend>
            {labels.length === 0 ? <span className="muted">尚无标签</span> : labels.map((label) => (
              <label key={label.id}>
                <input type="checkbox" checked={draft.labelIds.includes(label.id)} onChange={() => toggleLabel(label.id)} />
                <span className="label-dot" style={{ backgroundColor: label.color }} />{label.name}
              </label>
            ))}
          </fieldset>
          <div className="actions field--wide">
            <button className="button button--primary" disabled={saving}>{saving ? '保存中…' : '保存任务'}</button>
            <button type="button" className="button" onClick={onCancel}>取消</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function Comments({ repository, task }: { repository: TaskRepository; task: TaskRecord }) {
  const { session } = useAuth()
  const [comments, setComments] = useState<TaskComment[]>([])
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setComments(await repository.listComments(task.workspaceId, task.id))
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '加载评论失败')
    }
  }, [repository, task.id, task.workspaceId])

  useEffect(() => { void load() }, [load])
  useEffect(() => repository.subscribeWorkspace?.(task.workspaceId, () => { void load() }), [load, repository, task.workspaceId])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!session || !body.trim()) return
    try {
      await repository.addComment(task.workspaceId, task.id, session.user.id, body)
      setBody('')
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '发表评论失败')
    }
  }

  async function editComment(comment: TaskComment) {
    const nextBody = window.prompt('编辑评论', comment.bodyMd)
    if (nextBody === null || !nextBody.trim()) return
    try {
      await repository.updateComment(comment.id, nextBody)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '编辑评论失败')
    }
  }

  async function removeComment(commentId: string) {
    try {
      await repository.deleteComment(commentId)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除评论失败')
    }
  }

  return <div className="comments">
    <h3>评论</h3>
    {error && <div className="notice notice--error" role="alert">{error}</div>}
    {comments.length === 0 ? <p className="muted">还没有评论。</p> : comments.map((comment) => (
      <article key={comment.id} className="comment">
        <strong>{comment.authorName}</strong><p>{comment.bodyMd}</p>
        <div className="task-actions">
          <button className="link-button" onClick={() => void editComment(comment)}>编辑评论</button>
          <button className="link-button" onClick={() => void removeComment(comment.id)}>删除评论</button>
        </div>
      </article>
    ))}
    <form className="comment-form" onSubmit={submit}>
      <textarea aria-label="添加评论" required value={body} onChange={(event) => setBody(event.target.value)} />
      <button className="button">评论</button>
    </form>
  </div>
}

export function TaskBoard({ repository, view }: { repository: TaskRepository; view: TaskView }) {
  const { session, profile, memberships } = useAuth()
  const workspace = memberships[0]
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [labels, setLabels] = useState<WorkspaceLabel[]>([])
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<TaskRecord | 'new' | null>(null)
  const [selected, setSelected] = useState<TaskRecord | null>(null)

  const load = useCallback(async () => {
    if (!session) return
    setLoading(true)
    try {
      const [nextTasks, nextLabels, nextMembers] = await Promise.all([
        repository.listTasks(workspace.workspaceId, session.user.id, view, profile?.timezone ?? 'UTC'),
        repository.listLabels(workspace.workspaceId),
        repository.listMembers(workspace.workspaceId),
      ])
      setTasks(nextTasks)
      setLabels(nextLabels)
      setMembers(nextMembers)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '加载任务失败')
    } finally {
      setLoading(false)
    }
  }, [profile?.timezone, repository, session, view, workspace.workspaceId])

  useEffect(() => { void load() }, [load])
  useEffect(() => repository.subscribeWorkspace?.(workspace.workspaceId, () => { void load() }), [load, repository, workspace.workspaceId])

  async function save(draft: TaskDraft) {
    if (!session) return
    if (editing === 'new') await repository.createTask(workspace.workspaceId, session.user.id, draft)
    else if (editing) await repository.updateTask(editing.id, draft)
    setEditing(null)
    await load()
  }

  async function mutate(action: () => Promise<void>) {
    try {
      await action()
      setSelected(null)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败')
    }
  }

  const sortedTasks = useMemo(() => [...tasks].sort((a, b) => (a.dueAt ?? a.dueDate ?? '').localeCompare(b.dueAt ?? b.dueDate ?? '')), [tasks])

  return <section className="content-panel">
    <div className="section-heading">
      <div><p className="eyebrow">{workspace.workspaceName}</p><h2>{viewTitles[view]}</h2></div>
      {view !== 'trash' && <button className="button button--primary" onClick={() => setEditing('new')}>创建任务</button>}
    </div>
    {error && <div className="notice notice--error" role="alert">{error}<button className="link-button" onClick={() => void load()}>重试</button></div>}
    {loading ? <p className="empty-state" aria-busy="true">正在加载任务…</p> : sortedTasks.length === 0 ? (
      <p className="empty-state">{view === 'trash' ? '回收站是空的。' : '这里还没有任务。'}</p>
    ) : <div className="task-list">{sortedTasks.map((task) => (
      <article key={task.id} className={`task-card priority--${task.priority}`}>
        <button className="task-main" onClick={() => setSelected(task)}>
          <span className={`status-pill status--${task.status}`}>{task.status.replace('_', ' ')}</span>
          <strong>{task.title}</strong>
          <span className="muted">{formatSchedule(task, profile?.timezone ?? 'UTC')}</span>
          <span className="priority-text">{task.priority}</span>
        </button>
        <div className="task-actions">
          {view === 'trash' ? <>
            <button className="button" onClick={() => void mutate(() => repository.restoreTask(task.id))}>恢复</button>
            <button className="button button--danger" onClick={() => void mutate(() => repository.permanentlyDeleteTask(task.id))}>永久删除</button>
          </> : <>
            {task.status !== 'done' && <button className="button" onClick={() => void mutate(() => repository.updateTask(task.id, { ...taskToDraft(task), status: 'done' }))}>完成</button>}
            <button className="button" onClick={() => setEditing(task)}>编辑</button>
            <button className="button" onClick={() => void mutate(() => repository.softDeleteTask(task.id))}>移到回收站</button>
          </>}
        </div>
      </article>
    ))}</div>}
    {editing && <TaskEditor task={editing === 'new' ? null : editing} labels={labels} members={members} onSave={save} onCancel={() => setEditing(null)} />}
    {selected && view !== 'trash' && <aside className="detail-drawer">
      <button className="icon-button" aria-label="关闭详情" onClick={() => setSelected(null)}>×</button>
      <h2>{selected.title}</h2>
      <pre className="markdown-source">{selected.descriptionMd || '暂无说明'}</pre>
      <Comments repository={repository} task={selected} />
    </aside>}
  </section>
}

export function LabelsPage({ repository }: { repository: TaskRepository }) {
  const { session, memberships } = useAuth()
  const workspace = memberships[0]
  const [labels, setLabels] = useState<WorkspaceLabel[]>([])
  const [name, setName] = useState('')
  const [color, setColor] = useState('#6B7280')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setLabels(await repository.listLabels(workspace.workspaceId)); setError(null) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '加载标签失败') }
  }, [repository, workspace.workspaceId])
  useEffect(() => { void load() }, [load])
  useEffect(() => repository.subscribeWorkspace?.(workspace.workspaceId, () => { void load() }), [load, repository, workspace.workspaceId])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!session) return
    try {
      await repository.createLabel(workspace.workspaceId, session.user.id, name, color)
      setName('')
      await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '创建标签失败') }
  }

  async function editLabel(label: WorkspaceLabel) {
    const nextName = window.prompt('编辑标签名称', label.name)
    if (nextName === null || !nextName.trim()) return
    try { await repository.updateLabel(label.id, nextName, label.color); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : '编辑标签失败') }
  }

  async function removeLabel(labelId: string) {
    try { await repository.deleteLabel(labelId); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : '删除标签失败') }
  }

  return <section className="content-panel"><p className="eyebrow">ORGANIZE</p><h2>Labels</h2>
    {error && <div className="notice notice--error" role="alert">{error}</div>}
    <form className="inline-form" onSubmit={submit}>
      <input aria-label="标签名称" required maxLength={50} value={name} onChange={(event) => setName(event.target.value)} />
      <input aria-label="标签颜色" type="color" value={color} onChange={(event) => setColor(event.target.value)} />
      <button className="button button--primary">创建标签</button>
    </form>
    <div className="label-list">{labels.length === 0 ? <p className="empty-state">尚无标签。</p> : labels.map((label) => <span key={label.id} className="label-chip">
      <i style={{ background: label.color }} />{label.name}
      <button className="link-button" onClick={() => void editLabel(label)}>编辑</button>
      <button className="link-button" onClick={() => void removeLabel(label.id)}>删除</button>
    </span>)}</div>
  </section>
}
