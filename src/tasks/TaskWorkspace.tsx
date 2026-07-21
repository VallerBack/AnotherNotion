/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { DateTime } from 'luxon'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/auth-context'
import { DEFAULT_TIMEZONE, timezoneLabel, utcToZonedInput, zonedInputToUtc } from '../lib/datetime'
import { Markdown } from '../components/Markdown'
import { REMINDER_STATUS_LABELS, TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from './task-labels'
import type {
  TaskComment,
  TaskReminder,
  TaskReminderDraft,
  ReminderRecipient,
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
  assigneeIds: [],
  scheduleKind: 'none',
  startDate: null,
  startAt: null,
  dueDate: null,
  dueAt: null,
  labelIds: [],
}

const viewTitles: Record<TaskView, string> = {
  today: '今日任务',
  calendar: '日历',
  all: '全部任务',
  mine: '我的任务',
  trash: '回收站',
}

export function taskToDraft(task: TaskRecord): TaskDraft {
  return {
    title: task.title,
    descriptionMd: task.descriptionMd,
    status: task.status,
    priority: task.priority,
    assigneeId: task.assigneeId,
    assigneeIds: task.assigneeIds,
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
  reminderRecipients,
  repository,
  workspaceId,
  onSave,
  onCancel,
}: {
  task: TaskRecord | null
  initialDraft?: TaskDraft
  labels: WorkspaceLabel[]
  members: WorkspaceMember[]
  reminderRecipients: ReminderRecipient[]
  repository: TaskRepository
  workspaceId: string
  onSave(draft: TaskDraft, reminder: TaskReminderDraft): Promise<void>
  onCancel(): void
}) {
  const { profile, session } = useAuth()
  const location = useLocation()
  const timezone = profile?.timezone ?? DEFAULT_TIMEZONE
  const [draft, setDraft] = useState<TaskDraft>(() =>
    task ? taskToDraft(task) : initialDraft ?? emptyDraft,
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [reminderEnabled, setReminderEnabled] = useState(false)
  const [reminderOption, setReminderOption] = useState('start')
  const [customReminderAt, setCustomReminderAt] = useState('')
  const [recipientIds, setRecipientIds] = useState<string[]>([])
  const eligibleReminderRecipients = useMemo(
    () => reminderRecipients.filter((recipient) => recipient.canReceiveEmail),
    [reminderRecipients],
  )

  useEffect(() => {
    if (!task) return
    let active = true
    void repository.listTaskReminders(workspaceId, task.id).then((reminders) => {
      const pending = reminders.filter((reminder) => ['pending', 'failed'].includes(reminder.status))
      if (!active || pending.length === 0) return
      setReminderEnabled(true)
      setReminderOption('custom')
      setCustomReminderAt(utcToZonedInput(pending[0].remindAt, timezone))
      const eligibleIds = new Set(eligibleReminderRecipients.map((recipient) => recipient.userId))
      setRecipientIds([...new Set(pending.map((reminder) => reminder.recipientUserId).filter((id) => eligibleIds.has(id)))])
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : '加载提醒失败') })
    return () => { active = false }
  }, [eligibleReminderRecipients, repository, task, timezone, workspaceId])

  useEffect(() => {
    if (recipientIds.length > 0) return
    const preferred = draft.assigneeIds[0] ?? session?.user.id
    if (preferred && eligibleReminderRecipients.some((recipient) => recipient.userId === preferred)) {
      setRecipientIds([preferred])
    }
  }, [draft.assigneeIds, eligibleReminderRecipients, recipientIds.length, session?.user.id])

  function reminderAnchor() {
    if (draft.scheduleKind === 'timed') return draft.startAt ?? draft.dueAt
    const date = draft.startDate ?? draft.dueDate
    return date ? DateTime.fromISO(date, { zone: timezone }).startOf('day').toUTC().toISO() : null
  }

  function buildReminder(): TaskReminderDraft {
    if (!reminderEnabled) return { enabled: false, recipientUserIds: [], remindAt: null }
    const anchorValue = reminderAnchor()
    if (!anchorValue) throw new Error('请先设置任务开始或截止时间。')
    if (recipientIds.length === 0) throw new Error('请选择至少一位邮箱已就绪的收件人。')
    const offsets: Record<string, number> = { start: 0, ten_minutes: 10, one_hour: 60, one_day: 1440 }
    const remindAt = reminderOption === 'custom'
      ? zonedInputToUtc(customReminderAt, timezone)
      : DateTime.fromISO(anchorValue).minus({ minutes: offsets[reminderOption] }).toUTC().toISO()
    if (!remindAt) throw new Error('请选择有效的提醒时间。')
    if (DateTime.fromISO(remindAt) > DateTime.fromISO(anchorValue)) throw new Error('提醒时间不能晚于任务时间。')
    return { enabled: true, recipientUserIds: recipientIds, remindAt }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onSave(draft, buildReminder())
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

  function toggleAssignee(userId: string) {
    setDraft((current) => {
      const assigneeIds = current.assigneeIds.includes(userId)
        ? current.assigneeIds.filter((id) => id !== userId) : [...current.assigneeIds, userId]
      return { ...current, assigneeIds, assigneeId: assigneeIds[0] ?? null }
    })
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="task-editor" role="dialog" aria-modal="true" aria-labelledby="task-editor-title">
        <div className="section-heading">
          <h2 id="task-editor-title">{task ? '编辑任务' : '创建任务'}</h2>
          <div className="task-actions">{task && <Link className="button" to={`/tasks/${task.id}/activity`} state={{ from: `${location.pathname}${location.search}`, scrollY: window.scrollY, cachedTask: task }}>提醒与评论</Link>}<button className="icon-button" onClick={onCancel} aria-label="关闭">×</button></div>
        </div>
        {error && <div className="notice notice--error" role="alert">{error}</div>}
        <form className="form task-form" onSubmit={submit}>
          <label className="field--wide">标题
            <input required maxLength={300} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          </label>
          <label className="field--wide">Markdown 说明
            <textarea rows={6} value={draft.descriptionMd} onChange={(event) => setDraft({ ...draft, descriptionMd: event.target.value })} />
          </label>
          <section className="field--wide markdown-preview" aria-label="说明预览"><strong>预览</strong><Markdown>{draft.descriptionMd}</Markdown></section>
          <label>状态
            <select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as TaskDraft['status'] })}>
              {Object.entries(TASK_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>优先级
            <select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value as TaskDraft['priority'] })}>
              {Object.entries(TASK_PRIORITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <fieldset className="assignee-picker"><legend>负责人</legend>
            {members.map((member) => <label key={member.userId} className="checkbox-row"><input type="checkbox" checked={draft.assigneeIds.includes(member.userId)} onChange={() => toggleAssignee(member.userId)} />{member.displayName}</label>)}
            {draft.assigneeIds.length === 0 && <span className="muted">无负责人</span>}
            <div className="chip-list">{draft.assigneeIds.map((id) => <span className="chip" key={id}>{members.find((m) => m.userId === id)?.displayName ?? '成员'}</span>)}</div>
          </fieldset>
          <label>日期类型
            <select
              value={draft.scheduleKind}
              onChange={(event) => {
                const scheduleKind = event.target.value as TaskDraft['scheduleKind']
                setDraft({
                  ...draft,
                  scheduleKind,
                  startDate: null,
                  startAt: null,
                  dueDate: null,
                  dueAt: null,
                })
                if (scheduleKind === 'none') setReminderEnabled(false)
              }}
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
              <input type="datetime-local" value={utcToZonedInput(draft.startAt, timezone)} onChange={(event) => setDraft({ ...draft, startAt: zonedInputToUtc(event.target.value, timezone) })} />
            </label>
            <label>截止时间
              <input type="datetime-local" value={utcToZonedInput(draft.dueAt, timezone)} onChange={(event) => setDraft({ ...draft, dueAt: zonedInputToUtc(event.target.value, timezone) })} />
            </label>
          </>}
          <fieldset className="field--wide reminder-editor">
            <legend>邮件提醒</legend>
            <label className="reminder-toggle-row">
              <span><strong>启用邮件提醒</strong><small>按所选时区发送给指定成员</small></span>
              <input type="checkbox" aria-label="启用邮件提醒" checked={reminderEnabled} disabled={draft.scheduleKind === 'none'} onChange={(event) => setReminderEnabled(event.target.checked)} />
            </label>
            {draft.scheduleKind === 'none' && <span className="muted">无日期任务不能启用提醒。</span>}
            {reminderEnabled && <>
              <label>提醒时间（{timezoneLabel(timezone)}）
                <select value={reminderOption} onChange={(event) => setReminderOption(event.target.value)}>
                  <option value="start">任务开始时</option><option value="ten_minutes">提前10分钟</option>
                  <option value="one_hour">提前1小时</option><option value="one_day">提前1天</option>
                  <option value="custom">自定义日期时间</option>
                </select>
              </label>
              {reminderOption === 'custom' && <label>自定义提醒时间
                <input type="datetime-local" value={customReminderAt} onChange={(event) => setCustomReminderAt(event.target.value)} />
              </label>}
              <div className="reminder-recipient-picker"><strong>收件人</strong>
                {draft.assigneeIds.length > 0 && <button type="button" className="link-button" onClick={() => setRecipientIds(draft.assigneeIds.filter((id) => eligibleReminderRecipients.some((recipient) => recipient.userId === id)))}>选择全部负责人</button>}
                {eligibleReminderRecipients.map((recipient) => <label key={recipient.userId} className="checkbox-row">
                  <input type="checkbox" checked={recipientIds.includes(recipient.userId)} onChange={() => setRecipientIds((current) => current.includes(recipient.userId) ? current.filter((id) => id !== recipient.userId) : [...current, recipient.userId])} />
                  {recipient.displayName}
                </label>)}
                {eligibleReminderRecipients.length === 0 && <p className="muted">暂无拥有有效且已验证通知邮箱的工作区成员。</p>}
                {!eligibleReminderRecipients.some((recipient) => recipient.userId === session?.user.id) && <Link to="/settings">当前邮箱未就绪，前往账号设置</Link>}
              </div>
            </>}
          </fieldset>
          <fieldset className="field--wide label-picker">
            <legend>标签</legend>
            {labels.length === 0 ? <span className="muted">尚无标签</span> : labels.map((label) => (
              <label key={label.id}>
                <input type="checkbox" checked={draft.labelIds.includes(label.id)} onChange={() => toggleLabel(label.id)} />
                <span className="label-dot" style={{ backgroundColor: label.color }} />{label.name}
              </label>
            ))}
            <div className="chip-list">{labels.filter((label) => draft.labelIds.includes(label.id)).map((label) => <span className="chip" key={label.id}><span className="label-dot" style={{ backgroundColor: label.color }} />{label.name}</span>)}</div>
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

function safeActivityError(reason: unknown, fallback: string) {
  const message = reason instanceof Error ? reason.message : ''
  if (/权限|permission|row-level|jwt/i.test(message)) return '没有权限执行此操作，请确认你仍属于该工作区。'
  if (/网络|fetch|network|connect/i.test(message)) return '网络连接失败，请稍后重试。'
  return fallback
}

function mergeById<T extends { id: string }>(items: T[]) {
  return [...new Map(items.map((item) => [item.id, item])).values()]
}

export function Comments({ repository, task, readOnly = false }: { repository: TaskRepository; task: TaskRecord; readOnly?: boolean }) {
  const { session, profile } = useAuth()
  const [comments, setComments] = useState<TaskComment[]>([])
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBody, setEditBody] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const mounted = useRef(true)
  const submitLock = useRef(false)
  const hasLoaded = useRef(false)
  const commentLoadRequestId = useRef(0)

  const load = useCallback(async (background = false) => {
    const requestId = ++commentLoadRequestId.current
    if (background) setRefreshing(true)
    else if (!hasLoaded.current) setLoading(true)
    try {
      const next = await repository.listComments(task.workspaceId, task.id)
      if (!mounted.current || requestId !== commentLoadRequestId.current) return
      setComments(mergeById(next))
      setError(null)
      hasLoaded.current = true
    } catch (reason) {
      if (mounted.current && requestId === commentLoadRequestId.current) setError(safeActivityError(reason, '加载评论失败，当前仍显示最近一次成功加载的内容。'))
    } finally {
      if (mounted.current && requestId === commentLoadRequestId.current) { setLoading(false); setRefreshing(false) }
    }
  }, [repository, task.id, task.workspaceId])

  useEffect(() => {
    mounted.current = true
    void load()
    const unsubscribe = repository.subscribeWorkspace?.(task.workspaceId, () => { void load(true) })
    return () => { mounted.current = false; commentLoadRequestId.current += 1; unsubscribe?.() }
  }, [load, repository, task.workspaceId])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = body.trim()
    if (!session || submitLock.current || readOnly) return
    if (!trimmed) { setError('评论内容不能为空。'); return }
    if (trimmed.length > 5000) { setError('评论不能超过 5000 个字符。'); return }
    submitLock.current = true
    setSubmitting(true)
    setError(null)
    setSuccess(null)
    try {
      await repository.addComment(task.workspaceId, task.id, session.user.id, trimmed)
      if (!mounted.current) return
      setBody('')
      setSuccess('评论已发布。')
      await load(true)
    } catch (reason) {
      if (mounted.current) setError(safeActivityError(reason, '发表评论失败，输入内容已保留。'))
    } finally {
      submitLock.current = false
      if (mounted.current) setSubmitting(false)
    }
  }

  function beginEdit(comment: TaskComment) {
    setEditingId(comment.id)
    setEditBody(comment.bodyMd)
    setError(null)
    setSuccess(null)
  }

  async function saveEdit(commentId: string) {
    const trimmed = editBody.trim()
    if (savingEdit || readOnly) return
    if (!trimmed) { setError('评论内容不能为空。'); return }
    if (trimmed.length > 5000) { setError('评论不能超过 5000 个字符。'); return }
    setSavingEdit(true)
    try {
      await repository.updateComment(commentId, trimmed)
      if (!mounted.current) return
      setEditingId(null)
      setEditBody('')
      setSuccess('评论已更新。')
      await load(true)
    } catch (reason) {
      if (mounted.current) setError(safeActivityError(reason, '编辑评论失败，修改内容已保留。'))
    } finally {
      if (mounted.current) setSavingEdit(false)
    }
  }

  async function removeComment(commentId: string) {
    if (deletingId || readOnly || !window.confirm('确定删除这条评论吗？')) return
    setDeletingId(commentId)
    try {
      await repository.deleteComment(commentId)
      if (!mounted.current) return
      setSuccess('评论已删除。')
      await load(true)
    } catch (reason) {
      if (mounted.current) setError(safeActivityError(reason, '删除评论失败，请稍后重试。'))
    } finally {
      if (mounted.current) setDeletingId(null)
    }
  }

  return <div className="comments">
    <div className="subsection-heading"><h3>评论</h3>{refreshing && <span className="muted" role="status">正在后台更新…</span>}</div>
    {error && <div className="notice notice--error" role="alert">{error}</div>}
    {success && <div className="notice notice--success" role="status">{success}</div>}
    {loading && comments.length === 0 ? <p className="muted" aria-busy="true">正在加载评论…</p> : comments.length === 0 ? <p className="muted">还没有评论。</p> : comments.map((comment) => (
      <article key={comment.id} className="comment">
        <strong>{comment.authorName}</strong>
        <span className="muted">创建：{DateTime.fromISO(comment.createdAt).setZone(profile?.timezone ?? DEFAULT_TIMEZONE).setLocale('zh-CN').toLocaleString(DateTime.DATETIME_MED)}{comment.updatedAt !== comment.createdAt ? ` · 更新：${DateTime.fromISO(comment.updatedAt).setZone(profile?.timezone ?? DEFAULT_TIMEZONE).setLocale('zh-CN').toLocaleString(DateTime.DATETIME_MED)} · 已编辑` : ''}</span>
        {editingId === comment.id ? <div className="comment-editor">
          <textarea aria-label="编辑评论内容" value={editBody} onChange={(event) => setEditBody(event.target.value)} />
          <small className={editBody.length > 5000 ? 'text-error' : 'muted'}>{editBody.length}/5000</small>
          <div className="task-actions"><button className="button" disabled={savingEdit || !editBody.trim() || editBody.length > 5000} onClick={() => void saveEdit(comment.id)}>{savingEdit ? '保存中…' : '保存修改'}</button><button className="button" disabled={savingEdit} onClick={() => setEditingId(null)}>取消编辑</button></div>
        </div> : <><Markdown empty="评论为空">{comment.bodyMd}</Markdown>{!readOnly && <div className="task-actions">
          <button className="link-button" disabled={Boolean(editingId) || Boolean(deletingId)} onClick={() => beginEdit(comment)}>编辑评论</button>
          <button className="link-button" disabled={Boolean(deletingId)} onClick={() => void removeComment(comment.id)}>{deletingId === comment.id ? '删除中…' : '删除评论'}</button>
        </div>}</>}
      </article>
    ))}
    {!readOnly && <form className="comment-form" onSubmit={submit}>
      <textarea aria-label="添加评论" required value={body} onChange={(event) => setBody(event.target.value)} />
      <small className={body.length > 5000 ? 'text-error' : 'muted'}>{body.length}/5000</small>
      <button className="button" disabled={submitting || !body.trim() || body.length > 5000}>{submitting ? '提交中…' : '发表评论'}</button>
    </form>}
  </div>
}

export function Reminders({ repository, task, readOnly = false }: { repository: TaskRepository; task: TaskRecord; readOnly?: boolean }) {
  const { profile } = useAuth()
  const timezone = profile?.timezone ?? DEFAULT_TIMEZONE
  const [reminders, setReminders] = useState<TaskReminder[]>([])
  const [recipients, setRecipients] = useState<ReminderRecipient[]>([])
  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([])
  const [remindAt, setRemindAt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [actionId, setActionId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingAt, setEditingAt] = useState('')
  const mounted = useRef(true)
  const submitLock = useRef(false)
  const hasLoaded = useRef(false)
  const reminderLoadRequestId = useRef(0)

  const load = useCallback(async (background = false) => {
    const requestId = ++reminderLoadRequestId.current
    if (background) setRefreshing(true)
    else if (!hasLoaded.current) setLoading(true)
    try {
      const [nextReminders, nextRecipients] = await Promise.all([
        repository.listTaskReminders(task.workspaceId, task.id),
        repository.listEligibleReminderRecipients(task.workspaceId),
      ])
      if (!mounted.current || requestId !== reminderLoadRequestId.current) return
      setReminders(mergeById(nextReminders))
      setRecipients(nextRecipients)
      setError(null)
      hasLoaded.current = true
    } catch (reason) {
      if (mounted.current && requestId === reminderLoadRequestId.current) setError(safeActivityError(reason, '加载提醒失败，当前仍显示最近一次成功加载的内容。'))
    } finally {
      if (mounted.current && requestId === reminderLoadRequestId.current) { setLoading(false); setRefreshing(false) }
    }
  }, [repository, task.id, task.workspaceId])

  useEffect(() => {
    mounted.current = true
    void load()
    const unsubscribe = repository.subscribeWorkspace?.(task.workspaceId, () => { void load(true) })
    return () => { mounted.current = false; reminderLoadRequestId.current += 1; unsubscribe?.() }
  }, [load, repository, task.workspaceId])

  function taskAnchor() {
    if (task.scheduleKind === 'timed') {
      const value = task.dueAt ?? task.startAt
      return value ? DateTime.fromISO(value) : null
    }
    if (task.scheduleKind === 'all_day') {
      const value = task.dueDate ?? task.startDate
      return value ? DateTime.fromISO(value, { zone: timezone }).startOf('day') : null
    }
    return null
  }

  function quickOffset(minutes: number) {
    const anchor = taskAnchor()
    if (!anchor) {
      setError('请先为任务设置开始或截止时间，再使用快捷提醒。')
      return
    }
    setRemindAt(anchor.minus({ minutes }).setZone(timezone).toFormat("yyyy-MM-dd'T'HH:mm"))
  }

  function toggleRecipient(userId: string) {
    setSelectedRecipients((current) => current.includes(userId)
      ? current.filter((id) => id !== userId)
      : [...current, userId])
  }

  async function create(event: FormEvent) {
    event.preventDefault()
    if (submitLock.current || readOnly) return
    const utc = zonedInputToUtc(remindAt, timezone)
    if (!utc || selectedRecipients.length === 0) {
      setError('请选择提醒时间和至少一位可接收邮件的成员。')
      return
    }
    if (DateTime.fromISO(utc) <= DateTime.utc()) { setError('提醒时间必须晚于当前时间。'); return }
    submitLock.current = true
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      await repository.createTaskReminders(task.id, [...new Set(selectedRecipients)], utc)
      if (!mounted.current) return
      setSelectedRecipients([])
      setRemindAt('')
      setSuccess('提醒已创建。')
      await load(true)
    } catch (reason) {
      if (mounted.current) setError(safeActivityError(reason, '创建提醒失败，所选时间和收件人已保留。'))
    } finally {
      submitLock.current = false
      if (mounted.current) setSaving(false)
    }
  }

  async function cancel(reminderId: string) {
    if (actionId || readOnly) return
    setActionId(reminderId)
    try { await repository.cancelTaskReminder(reminderId); if (mounted.current) { setSuccess('提醒已取消。'); await load(true) } }
    catch (reason) { if (mounted.current) setError(safeActivityError(reason, '取消提醒失败，请稍后重试。')) }
    finally { if (mounted.current) setActionId(null) }
  }

  async function reschedule(reminder: TaskReminder) {
    if (actionId || readOnly) return
    const utc = zonedInputToUtc(editingAt, timezone)
    if (!utc || DateTime.fromISO(utc) <= DateTime.utc()) { setError('新的提醒时间必须晚于当前时间。'); return }
    setActionId(reminder.id)
    try {
      await repository.rescheduleTaskReminder(reminder.id, utc)
      if (!mounted.current) return
      setEditingId(null)
      setEditingAt('')
      setSuccess(reminder.status === 'cancelled' ? '提醒已重新启用。' : '提醒时间已更新。')
      await load(true)
    } catch (reason) {
      if (mounted.current) setError(safeActivityError(reason, '重新安排提醒失败，修改时间已保留。'))
    } finally { if (mounted.current) setActionId(null) }
  }

  const eligibleRecipients = recipients.filter((recipient) => recipient.canReceiveEmail)
  const recipientNames = new Map(recipients.map((recipient) => [recipient.userId, recipient.displayName]))
  return <div className="reminders">
    <div className="subsection-heading"><h3>邮件提醒</h3>{refreshing && <span className="muted" role="status">正在后台更新…</span>}</div>
    {error && <div className="notice notice--error" role="alert">{error}</div>}
    {success && <div className="notice notice--success" role="status">{success}</div>}
    {!readOnly && <form className="reminder-form" onSubmit={create}>
      <label>提醒时间（{timezoneLabel(timezone)}）
        <input type="datetime-local" value={remindAt} onChange={(event) => setRemindAt(event.target.value)} />
      </label>
      <div className="quick-reminders" aria-label="快捷提醒">
        <button type="button" className="button" onClick={() => quickOffset(10)}>提前10分钟</button>
        <button type="button" className="button" onClick={() => quickOffset(60)}>提前1小时</button>
        <button type="button" className="button" onClick={() => quickOffset(1440)}>提前1天</button>
      </div>
      <fieldset><legend>收件人</legend>
        {task.assigneeIds.some((id) => eligibleRecipients.some((recipient) => recipient.userId === id)) && <button type="button" className="link-button" onClick={() => setSelectedRecipients(task.assigneeIds.filter((id) => eligibleRecipients.some((recipient) => recipient.userId === id)))}>选择全部负责人</button>}
        {eligibleRecipients.length === 0 ? <p className="muted">暂无拥有有效且已验证通知邮箱的工作区成员。</p> : eligibleRecipients.map((recipient) => <label key={recipient.userId} className="checkbox-row">
          <input type="checkbox" checked={selectedRecipients.includes(recipient.userId)} onChange={() => toggleRecipient(recipient.userId)} />
          {recipient.displayName}
        </label>)}
      </fieldset>
      <button className="button button--primary" disabled={saving}>{saving ? '创建中…' : '创建提醒'}</button>
    </form>}
    <div className="reminder-list">{loading && reminders.length === 0 ? <p className="muted" aria-busy="true">正在加载提醒…</p> : reminders.length === 0 ? <p className="muted">尚无提醒。</p> : reminders.map((reminder) => <article key={reminder.id} className="reminder-item">
      <div><strong>{recipientNames.get(reminder.recipientUserId) ?? '工作区成员'}</strong>
        <span>{DateTime.fromISO(reminder.remindAt).setZone(timezone).toLocaleString(DateTime.DATETIME_MED)}</span>
        <span className={`status-pill status--${reminder.status}`}>{REMINDER_STATUS_LABELS[reminder.status]}</span>
        <span className="muted">创建：{DateTime.fromISO(reminder.createdAt).setZone(timezone).setLocale('zh-CN').toLocaleString(DateTime.DATETIME_MED)}</span>
        {reminder.sentAt && <span className="muted">发送：{DateTime.fromISO(reminder.sentAt).setZone(timezone).setLocale('zh-CN').toLocaleString(DateTime.DATETIME_MED)}</span>}
        {reminder.lastError && <small className="notice notice--error">邮件发送失败，请稍后重新安排；持续失败请联系管理员检查邮件服务。</small>}
      </div>
      {!readOnly && <div className="task-actions">
        {editingId === reminder.id ? <><label>新的提醒时间（{timezoneLabel(timezone)}）<input type="datetime-local" value={editingAt} onChange={(event) => setEditingAt(event.target.value)} /></label><button className="button" disabled={actionId === reminder.id} onClick={() => void reschedule(reminder)}>{actionId === reminder.id ? '保存中…' : reminder.status === 'cancelled' ? '重新启用' : '保存时间'}</button><button className="button" disabled={Boolean(actionId)} onClick={() => setEditingId(null)}>取消编辑</button></> : <>
          {['pending', 'processing', 'failed'].includes(reminder.status) && <button className="link-button" disabled={Boolean(actionId)} onClick={() => void cancel(reminder.id)}>{actionId === reminder.id ? '处理中…' : '取消'}</button>}
          {['pending', 'failed', 'cancelled'].includes(reminder.status) && <button className="link-button" disabled={Boolean(actionId)} onClick={() => { setEditingId(reminder.id); setEditingAt(utcToZonedInput(reminder.remindAt, timezone)); setError(null) }}>{reminder.status === 'cancelled' ? '重新启用' : '改期'}</button>}
        </>}
      </div>}
    </article>)}</div>
  </div>
}

export function TaskBoard({ repository, view }: { repository: TaskRepository; view: TaskView }) {
  const { session, profile, memberships } = useAuth()
  const userId = session?.user.id
  const workspace = memberships[0]
  const location = useLocation()
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [labels, setLabels] = useState<WorkspaceLabel[]>([])
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [reminderRecipients, setReminderRecipients] = useState<ReminderRecipient[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<TaskRecord | 'new' | null>(null)
  const hasLoaded = useRef(false)

  const load = useCallback(async () => {
    if (!userId) return
    if (!hasLoaded.current) setLoading(true)
    try {
      const [nextTasks, nextLabels, nextMembers, nextReminderRecipients] = await Promise.all([
        repository.listTasks(workspace.workspaceId, userId, view, profile?.timezone ?? DEFAULT_TIMEZONE),
        repository.listLabels(workspace.workspaceId),
        repository.listMembers(workspace.workspaceId),
        repository.listEligibleReminderRecipients(workspace.workspaceId),
      ])
      setTasks(nextTasks)
      setLabels(nextLabels)
      setMembers(nextMembers)
      setReminderRecipients(nextReminderRecipients)
      hasLoaded.current = true
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '加载任务失败')
    } finally {
      setLoading(false)
    }
  }, [profile?.timezone, repository, userId, view, workspace.workspaceId])

  useEffect(() => { void load() }, [load])
  useEffect(() => repository.subscribeWorkspace?.(workspace.workspaceId, () => { void load() }), [load, repository, workspace.workspaceId])

  async function save(draft: TaskDraft, reminder: TaskReminderDraft) {
    if (!session) return
    if (editing === 'new') await repository.createTask(workspace.workspaceId, session.user.id, draft, reminder)
    else if (editing) {
      const scheduleChanged = editing.scheduleKind !== draft.scheduleKind
        || editing.startDate !== draft.startDate || editing.startAt !== draft.startAt
        || editing.dueDate !== draft.dueDate || editing.dueAt !== draft.dueAt
      await repository.updateTask(editing.id, draft, reminder)
      if (scheduleChanged) {
        const reminders = await repository.listTaskReminders(editing.workspaceId, editing.id)
        if (reminders.some((reminder) => ['pending', 'failed'].includes(reminder.status))) {
          window.alert('任务时间已修改，请检查并重新安排关联提醒。')
        }
      }
    }
    setEditing(null)
    await load()
  }

  async function mutate(action: () => Promise<void>) {
    try {
      await action()
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
        <Link
          className="task-main"
          to={`/tasks/${task.id}`}
          state={{ from: `${location.pathname}${location.search}`, scrollY: window.scrollY, cachedTask: task }}
          aria-label={`查看任务：${task.title}`}
        >
          <span className={`status-pill status--${task.status}`}>{TASK_STATUS_LABELS[task.status]}</span>
          <strong>{task.title}</strong>
          <span className="muted">{formatSchedule(task, profile?.timezone ?? DEFAULT_TIMEZONE)}</span>
          <span className="priority-text">{TASK_PRIORITY_LABELS[task.priority]}</span>
        </Link>
        <div className="task-actions">
          {view === 'trash' ? <>
            <button className="button" onClick={() => void mutate(async () => { await repository.restoreTask(task.id); window.alert('任务已恢复，已取消的提醒不会自动恢复，请重新设置。') })}>恢复</button>
            <button className="button button--danger" onClick={() => void mutate(() => repository.permanentlyDeleteTask(task.id))}>永久删除</button>
          </> : <>
            {task.status !== 'done' && <button className="button" onClick={() => void mutate(() => repository.updateTask(task.id, { ...taskToDraft(task), status: 'done' }))}>完成</button>}
            <button className="button" onClick={() => setEditing(task)}>编辑</button>
            <Link className="button" to={`/tasks/${task.id}/activity`} state={{ from: `${location.pathname}${location.search}`, scrollY: window.scrollY, cachedTask: task }}>提醒与评论</Link>
            <button className="button" onClick={() => void mutate(() => repository.softDeleteTask(task.id))}>移到回收站</button>
          </>}
        </div>
      </article>
    ))}</div>}
    {editing && <TaskEditor task={editing === 'new' ? null : editing} labels={labels} members={members} reminderRecipients={reminderRecipients} repository={repository} workspaceId={workspace.workspaceId} onSave={save} onCancel={() => setEditing(null)} />}
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

  return <section className="content-panel"><p className="eyebrow">整理</p><h2>标签</h2>
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
