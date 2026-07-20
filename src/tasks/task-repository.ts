import type { SupabaseClient } from '@supabase/supabase-js'
import { DateTime } from 'luxon'
import { DEFAULT_TIMEZONE } from '../lib/datetime'
import type {
  Database,
  TaskPriority,
  TaskScheduleKind,
  TaskStatus,
  TaskReminderStatus,
} from '../types/database'

export type TaskView = 'today' | 'calendar' | 'all' | 'mine' | 'trash'

export type TaskRecord = {
  id: string
  workspaceId: string
  title: string
  descriptionMd: string
  status: TaskStatus
  priority: TaskPriority
  assigneeId: string | null
  scheduleKind: TaskScheduleKind
  startDate: string | null
  startAt: string | null
  dueDate: string | null
  dueAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  labelIds: string[]
}

export type TaskDraft = Omit<
  TaskRecord,
  'id' | 'workspaceId' | 'createdBy' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'labelIds'
> & { labelIds: string[] }

export type WorkspaceLabel = { id: string; name: string; color: string }
export type WorkspaceMember = {
  userId: string
  displayName: string
}
export type TaskComment = {
  id: string
  taskId: string
  authorId: string
  authorName: string
  bodyMd: string
  createdAt: string
}
export type ReminderRecipient = { userId: string; displayName: string; canReceiveEmail: boolean }
export type TaskReminderDraft = { enabled: boolean; recipientUserIds: string[]; remindAt: string | null }
export type TaskReminder = {
  id: string
  taskId: string | null
  recipientUserId: string
  remindAt: string
  status: TaskReminderStatus
  attemptCount: number
  sentAt: string | null
  lastError: string | null
}

export interface TaskRepository {
  listTasks(workspaceId: string, userId: string, view: TaskView, timezone?: string): Promise<TaskRecord[]>
  getTask(workspaceId: string, taskId: string): Promise<TaskRecord | null>
  createTask(workspaceId: string, userId: string, draft: TaskDraft, reminder?: TaskReminderDraft): Promise<TaskRecord>
  updateTask(taskId: string, draft: TaskDraft, reminder?: TaskReminderDraft): Promise<void>
  softDeleteTask(taskId: string): Promise<void>
  restoreTask(taskId: string): Promise<void>
  permanentlyDeleteTask(taskId: string): Promise<void>
  listLabels(workspaceId: string): Promise<WorkspaceLabel[]>
  createLabel(workspaceId: string, userId: string, name: string, color: string): Promise<void>
  updateLabel(labelId: string, name: string, color: string): Promise<void>
  deleteLabel(labelId: string): Promise<void>
  listMembers(workspaceId: string): Promise<WorkspaceMember[]>
  listComments(workspaceId: string, taskId: string): Promise<TaskComment[]>
  addComment(workspaceId: string, taskId: string, userId: string, bodyMd: string): Promise<void>
  updateComment(commentId: string, bodyMd: string): Promise<void>
  deleteComment(commentId: string): Promise<void>
  listEligibleReminderRecipients(workspaceId: string): Promise<ReminderRecipient[]>
  listTaskReminders(workspaceId: string, taskId: string): Promise<TaskReminder[]>
  createTaskReminders(taskId: string, recipientUserIds: string[], remindAt: string): Promise<void>
  cancelTaskReminder(reminderId: string): Promise<void>
  rescheduleTaskReminder(reminderId: string, remindAt: string): Promise<void>
  subscribeWorkspace?(workspaceId: string, onChange: () => void): () => void
}

type TaskRow = Database['public']['Tables']['tasks']['Row']

function ensure<T>(data: T | null, error: { message: string; code?: string } | null): T {
  if (error) throw toDataError(error)
  if (data === null) throw new Error('服务器未返回数据')
  return data
}

export function toDataError(error: { message: string; code?: string }) {
  if (
    error.code === '42501' ||
    error.code === 'PGRST301' ||
    /permission|row-level security|jwt/i.test(error.message)
  ) {
    return new Error('没有权限执行此操作，请重新登录或确认你仍属于该工作区。')
  }
  if (/fetch|network|connect/i.test(error.message)) {
    return new Error('网络连接失败，请稍后重试。')
  }
  return new Error(error.message)
}

function mapTask(row: TaskRow, labelIds: string[] = []): TaskRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    descriptionMd: row.description_md,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assignee_id,
    scheduleKind: row.schedule_kind,
    startDate: row.start_date?.slice(0, 10) ?? null,
    startAt: row.start_at,
    dueDate: row.due_date?.slice(0, 10) ?? null,
    dueAt: row.due_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    labelIds,
  }
}

function isToday(task: TaskRecord, timezone: string) {
  const today = DateTime.now().setZone(timezone).toISODate()
  if (task.scheduleKind === 'all_day') {
    return task.startDate === today || task.dueDate === today
  }
  return [task.startAt, task.dueAt].some(
    (value) => value !== null && DateTime.fromISO(value).setZone(timezone).toISODate() === today,
  )
}

function toTaskWrite(draft: TaskDraft) {
  const allDayUtc = (value: string | null) => value ? `${value.slice(0, 10)}T00:00:00.000Z` : null
  return {
    title: draft.title.trim(),
    description_md: draft.descriptionMd,
    status: draft.status,
    priority: draft.priority,
    assignee_id: draft.assigneeId,
    schedule_kind: draft.scheduleKind,
    start_date: draft.scheduleKind === 'all_day' ? allDayUtc(draft.startDate) : null,
    start_at: draft.scheduleKind === 'timed' ? draft.startAt : null,
    due_date: draft.scheduleKind === 'all_day' ? allDayUtc(draft.dueDate) : null,
    due_at: draft.scheduleKind === 'timed' ? draft.dueAt : null,
  }
}

export class SupabaseTaskRepository implements TaskRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async listTasks(workspaceId: string, userId: string, view: TaskView, timezone = DEFAULT_TIMEZONE) {
    let rows: TaskRow[]
    if (view === 'trash') {
      const response = await this.client.rpc('list_deleted_tasks', {
        p_workspace_id: workspaceId,
      })
      rows = ensure(response.data, response.error)
    } else {
      const response = await this.client
        .from('tasks')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
      rows = ensure(response.data, response.error)
    }

    const taskIds = rows.map((row) => row.id)
    const labelsByTask = new Map<string, string[]>()
    if (taskIds.length > 0) {
      const response = await this.client
        .from('task_labels')
        .select('task_id, label_id')
        .eq('workspace_id', workspaceId)
        .in('task_id', taskIds)
      const links = ensure(response.data, response.error)
      for (const link of links) {
        const labels = labelsByTask.get(link.task_id) ?? []
        labels.push(link.label_id)
        labelsByTask.set(link.task_id, labels)
      }
    }

    const tasks = rows.map((row) => mapTask(row, labelsByTask.get(row.id)))
    if (view === 'mine') return tasks.filter((task) => task.assigneeId === userId)
    if (view === 'today') return tasks.filter((task) => isToday(task, timezone))
    return tasks
  }

  async getTask(workspaceId: string, taskId: string) {
    const activeResponse = await this.client
      .from('tasks')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('id', taskId)
      .maybeSingle()
    if (activeResponse.error) throw toDataError(activeResponse.error)

    let row = activeResponse.data
    if (!row) {
      const deletedResponse = await this.client.rpc('list_deleted_tasks', {
        p_workspace_id: workspaceId,
      })
      row = ensure(deletedResponse.data, deletedResponse.error)
        .find((task) => task.id === taskId) ?? null
    }
    if (!row) return null

    const labelsResponse = await this.client
      .from('task_labels')
      .select('label_id')
      .eq('workspace_id', workspaceId)
      .eq('task_id', taskId)
    const labelIds = ensure(labelsResponse.data, labelsResponse.error).map((link) => link.label_id)
    return mapTask(row, labelIds)
  }

  async createTask(workspaceId: string, userId: string, draft: TaskDraft, reminder?: TaskReminderDraft) {
    void userId
    const response = await this.client.rpc('create_task_with_reminders', {
      p_workspace_id: workspaceId, p_task: toTaskWrite(draft), p_label_ids: draft.labelIds,
      p_recipient_user_ids: reminder?.enabled ? reminder.recipientUserIds : [],
      p_remind_at: reminder?.enabled ? reminder.remindAt : null,
    })
    const taskId = ensure(response.data, response.error)
    const taskResponse = await this.client.from('tasks').select('*').eq('id', taskId).single()
    return mapTask(ensure(taskResponse.data, taskResponse.error), draft.labelIds)
  }

  async updateTask(taskId: string, draft: TaskDraft, reminder?: TaskReminderDraft) {
    if (reminder) {
      const { error } = await this.client.rpc('update_task_with_reminders', {
        p_task_id: taskId, p_task: toTaskWrite(draft), p_label_ids: draft.labelIds,
        p_recipient_user_ids: reminder.enabled ? reminder.recipientUserIds : [],
        p_remind_at: reminder.enabled ? reminder.remindAt : null,
      })
      if (error) throw toDataError(error)
      return
    }
    const { error } = await this.client
      .from('tasks')
      .update(toTaskWrite(draft))
      .eq('id', taskId)
    if (error) throw toDataError(error)
    const workspaceResponse = await this.client
      .from('tasks')
      .select('workspace_id')
      .eq('id', taskId)
      .single()
    const task = ensure(workspaceResponse.data, workspaceResponse.error)
    await this.replaceLabels(task.workspace_id, taskId, draft.labelIds)
  }

  async softDeleteTask(taskId: string) {
    const { error } = await this.client.rpc('soft_delete_task', {
      p_task_id: taskId,
    })
    if (error) throw toDataError(error)
  }

  async restoreTask(taskId: string) {
    const { error } = await this.client.rpc('restore_task', { p_task_id: taskId })
    if (error) throw toDataError(error)
  }

  async permanentlyDeleteTask(taskId: string) {
    const { error } = await this.client.rpc('permanently_delete_task', {
      p_task_id: taskId,
    })
    if (error) throw toDataError(error)
  }

  async listLabels(workspaceId: string) {
    const response = await this.client
      .from('labels')
      .select('id, name, color')
      .eq('workspace_id', workspaceId)
      .order('name')
    return ensure(response.data, response.error)
  }

  async createLabel(workspaceId: string, userId: string, name: string, color: string) {
    const { error } = await this.client.from('labels').insert({
      workspace_id: workspaceId,
      created_by: userId,
      name: name.trim(),
      color,
    })
    if (error) throw toDataError(error)
  }

  async updateLabel(labelId: string, name: string, color: string) {
    const { error } = await this.client
      .from('labels')
      .update({ name: name.trim(), color })
      .eq('id', labelId)
    if (error) throw toDataError(error)
  }

  async deleteLabel(labelId: string) {
    const { error } = await this.client.from('labels').delete().eq('id', labelId)
    if (error) throw toDataError(error)
  }

  async listMembers(workspaceId: string) {
    const membershipResponse = await this.client
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', workspaceId)
    const memberships = ensure(membershipResponse.data, membershipResponse.error)
    if (memberships.length === 0) return []
    const profileResponse = await this.client
      .from('profiles')
      .select('id, display_name')
      .in('id', memberships.map((item) => item.user_id))
    const profiles = ensure(profileResponse.data, profileResponse.error)
    const names = new Map(profiles.map((profile) => [profile.id, profile.display_name]))
    return memberships.map((membership) => ({
      userId: membership.user_id,
      displayName: names.get(membership.user_id) ?? '未知成员',
    }))
  }

  async listComments(workspaceId: string, taskId: string) {
    const response = await this.client
      .from('comments')
      .select('id, task_id, author_id, body_md, created_at')
      .eq('workspace_id', workspaceId)
      .eq('task_id', taskId)
      .order('created_at')
    const comments = ensure(response.data, response.error)
    if (comments.length === 0) return []
    const profileResponse = await this.client
      .from('profiles')
      .select('id, display_name')
      .in('id', [...new Set(comments.map((comment) => comment.author_id))])
    const profiles = ensure(profileResponse.data, profileResponse.error)
    const names = new Map(profiles.map((profile) => [profile.id, profile.display_name]))
    return comments.map((comment) => ({
      id: comment.id,
      taskId: comment.task_id,
      authorId: comment.author_id,
      authorName: names.get(comment.author_id) ?? '未知成员',
      bodyMd: comment.body_md,
      createdAt: comment.created_at,
    }))
  }

  async addComment(workspaceId: string, taskId: string, userId: string, bodyMd: string) {
    const { error } = await this.client.from('comments').insert({
      workspace_id: workspaceId,
      task_id: taskId,
      author_id: userId,
      body_md: bodyMd.trim(),
    })
    if (error) throw toDataError(error)
  }

  async updateComment(commentId: string, bodyMd: string) {
    const { error } = await this.client
      .from('comments')
      .update({ body_md: bodyMd.trim() })
      .eq('id', commentId)
    if (error) throw toDataError(error)
  }

  async deleteComment(commentId: string) {
    const { error } = await this.client.from('comments').delete().eq('id', commentId)
    if (error) throw toDataError(error)
  }

  async listEligibleReminderRecipients(workspaceId: string) {
    const response = await this.client.rpc('list_reminder_recipient_capabilities', {
      p_workspace_id: workspaceId,
    })
    return ensure(response.data, response.error).map((recipient) => ({
      userId: recipient.user_id,
      displayName: recipient.display_name,
      canReceiveEmail: recipient.can_receive_email,
    }))
  }

  async listTaskReminders(workspaceId: string, taskId: string) {
    const response = await this.client.from('task_reminders')
      .select('id, task_id, recipient_user_id, remind_at, status, attempt_count, sent_at, last_error')
      .eq('workspace_id', workspaceId)
      .eq('task_id', taskId)
      .order('remind_at')
    return ensure(response.data, response.error).map((reminder) => ({
      id: reminder.id,
      taskId: reminder.task_id,
      recipientUserId: reminder.recipient_user_id,
      remindAt: reminder.remind_at,
      status: reminder.status,
      attemptCount: reminder.attempt_count,
      sentAt: reminder.sent_at,
      lastError: reminder.last_error,
    }))
  }

  async createTaskReminders(taskId: string, recipientUserIds: string[], remindAt: string) {
    const { error } = await this.client.rpc('create_task_reminders', {
      p_task_id: taskId,
      p_recipient_user_ids: recipientUserIds,
      p_remind_at: remindAt,
    })
    if (error) throw toDataError(error)
  }

  async cancelTaskReminder(reminderId: string) {
    const { error } = await this.client.rpc('cancel_task_reminder', { p_reminder_id: reminderId })
    if (error) throw toDataError(error)
  }

  async rescheduleTaskReminder(reminderId: string, remindAt: string) {
    const { error } = await this.client.rpc('reschedule_task_reminder', {
      p_reminder_id: reminderId,
      p_remind_at: remindAt,
    })
    if (error) throw toDataError(error)
  }

  subscribeWorkspace(workspaceId: string, onChange: () => void) {
    const channel = this.client.channel(`workspace:${workspaceId}`)
    for (const table of ['tasks', 'labels', 'task_labels', 'comments', 'task_reminders'] as const) {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `workspace_id=eq.${workspaceId}` },
        onChange,
      )
    }
    channel.subscribe()
    return () => { void this.client.removeChannel(channel) }
  }

  private async replaceLabels(workspaceId: string, taskId: string, labelIds: string[]) {
    const currentResponse = await this.client
      .from('task_labels')
      .select('label_id')
      .eq('workspace_id', workspaceId)
      .eq('task_id', taskId)
    const current = ensure(currentResponse.data, currentResponse.error).map(
      (link) => link.label_id,
    )
    const removed = current.filter((id) => !labelIds.includes(id))
    const added = labelIds.filter((id) => !current.includes(id))

    if (removed.length > 0) {
      const { error } = await this.client
        .from('task_labels')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('task_id', taskId)
        .in('label_id', removed)
      if (error) throw toDataError(error)
    }
    if (added.length > 0) {
      const { error } = await this.client.from('task_labels').insert(
        added.map((labelId) => ({
          workspace_id: workspaceId,
          task_id: taskId,
          label_id: labelId,
        })),
      )
      if (error) throw toDataError(error)
    }
  }
}
