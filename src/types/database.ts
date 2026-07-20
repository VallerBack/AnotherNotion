export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type WorkspaceRole = 'owner' | 'member'
export type TaskStatus = 'todo' | 'in_progress' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'
export type TaskScheduleKind = 'none' | 'all_day' | 'timed'
export type TaskReminderStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled'

type ProfileRow = {
  id: string
  display_name: string
  timezone: string
  notification_email: string | null
  notification_email_verified_at: string | null
  email_notifications_enabled: boolean
  must_change_password: boolean
  created_at: string
  updated_at: string
}

type WorkspaceRow = {
  id: string
  name: string
  created_by: string
  created_at: string
  updated_at: string
}

type WorkspaceMemberRow = {
  workspace_id: string
  user_id: string
  role: WorkspaceRole
  joined_at: string
  added_by: string | null
}

type TaskRow = {
  id: string
  workspace_id: string
  title: string
  description_md: string
  status: TaskStatus
  priority: TaskPriority
  assignee_id: string | null
  schedule_kind: TaskScheduleKind
  start_date: string | null
  start_at: string | null
  due_date: string | null
  due_at: string | null
  created_by: string
  created_at: string
  updated_at: string
  deleted_at: string | null
  deleted_by: string | null
}

type LabelRow = {
  id: string
  workspace_id: string
  name: string
  color: string
  created_by: string
  created_at: string
  updated_at: string
}

type TaskLabelRow = {
  task_id: string
  label_id: string
  workspace_id: string
  created_at: string
}

type CommentRow = {
  id: string
  workspace_id: string
  task_id: string
  author_id: string
  body_md: string
  created_at: string
  updated_at: string
}

type TaskReminderRow = {
  id: string
  workspace_id: string
  task_id: string | null
  recipient_user_id: string
  remind_at: string
  status: TaskReminderStatus
  attempt_count: number
  next_attempt_at: string | null
  locked_at: string | null
  sent_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

type TableDefinition<Row, Insert, Update> = {
  Row: Row
  Insert: Insert
  Update: Update
  Relationships: []
}

export interface Database {
  public: {
    Tables: {
      profiles: TableDefinition<ProfileRow, never, Pick<ProfileRow, 'display_name' | 'timezone' | 'notification_email' | 'email_notifications_enabled'>>
      workspaces: TableDefinition<WorkspaceRow, never, Pick<WorkspaceRow, 'name'>>
      workspace_members: TableDefinition<WorkspaceMemberRow, never, never>
      tasks: TableDefinition<
        TaskRow,
        Pick<TaskRow, 'workspace_id' | 'title' | 'created_by'> & Partial<Pick<TaskRow, 'description_md' | 'status' | 'priority' | 'assignee_id' | 'schedule_kind' | 'start_date' | 'start_at' | 'due_date' | 'due_at'>>,
        Partial<Pick<TaskRow, 'title' | 'description_md' | 'status' | 'priority' | 'assignee_id' | 'schedule_kind' | 'start_date' | 'start_at' | 'due_date' | 'due_at' | 'deleted_at'>>
      >
      labels: TableDefinition<
        LabelRow,
        Pick<LabelRow, 'workspace_id' | 'name' | 'color' | 'created_by'>,
        Partial<Pick<LabelRow, 'name' | 'color'>>
      >
      task_labels: TableDefinition<
        TaskLabelRow,
        Pick<TaskLabelRow, 'task_id' | 'label_id' | 'workspace_id'>,
        never
      >
      comments: TableDefinition<
        CommentRow,
        Pick<CommentRow, 'workspace_id' | 'task_id' | 'author_id' | 'body_md'>,
        Pick<CommentRow, 'body_md'>
      >
      task_reminders: TableDefinition<TaskReminderRow, never, never>
    }
    Views: Record<string, never>
    Functions: {
      create_workspace: { Args: { p_name: string }; Returns: string }
      add_workspace_member: { Args: { p_workspace_id: string; p_user_id: string }; Returns: undefined }
      remove_workspace_member: { Args: { p_workspace_id: string; p_user_id: string }; Returns: undefined }
      list_deleted_tasks: { Args: { p_workspace_id: string }; Returns: TaskRow[] }
      soft_delete_task: { Args: { p_task_id: string }; Returns: undefined }
      restore_task: { Args: { p_task_id: string }; Returns: undefined }
      permanently_delete_task: { Args: { p_task_id: string }; Returns: undefined }
      complete_password_change: { Args: Record<string, never>; Returns: undefined }
      get_my_profile_preferences: { Args: Record<string, never>; Returns: Pick<ProfileRow, 'id' | 'display_name' | 'timezone' | 'notification_email' | 'notification_email_verified_at' | 'email_notifications_enabled' | 'must_change_password'>[] }
      list_eligible_reminder_recipients: { Args: { p_workspace_id: string }; Returns: { user_id: string; display_name: string }[] }
      create_task_reminders: { Args: { p_task_id: string; p_recipient_user_ids: string[]; p_remind_at: string }; Returns: undefined }
      cancel_task_reminder: { Args: { p_reminder_id: string }; Returns: undefined }
      reschedule_task_reminder: { Args: { p_reminder_id: string; p_remind_at: string }; Returns: undefined }
      list_reminder_recipient_capabilities: { Args: { p_workspace_id: string }; Returns: { user_id: string; display_name: string; can_receive_email: boolean }[] }
      create_task_with_reminders: { Args: { p_workspace_id: string; p_task: Json; p_label_ids: string[]; p_recipient_user_ids: string[]; p_remind_at: string | null }; Returns: string }
      update_task_with_reminders: { Args: { p_task_id: string; p_task: Json; p_label_ids: string[]; p_recipient_user_ids: string[]; p_remind_at: string | null }; Returns: undefined }
    }
    Enums: {
      workspace_role: WorkspaceRole
      task_status: TaskStatus
      task_priority: TaskPriority
      task_schedule_kind: TaskScheduleKind
      task_reminder_status: TaskReminderStatus
    }
    CompositeTypes: Record<string, never>
  }
}
