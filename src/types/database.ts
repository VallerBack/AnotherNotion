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
export type ChannelReminderStatus = 'pending' | 'exported' | 'cancelled' | 'failed'

type ProfileRow = {
  id: string
  display_name: string
  timezone: string
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
  updated_by: string | null
}

type TaskAssigneeRow = { task_id: string; user_id: string; workspace_id: string; assigned_by: string; assigned_at: string }

type ChannelReminderRow = {
  id: string; workspace_id: string; task_id: string; remind_at: string
  status: ChannelReminderStatus; exported_at: string | null; export_attempt_count: number
  created_by: string | null; created_at: string; updated_at: string
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
      profiles: TableDefinition<ProfileRow, never, Pick<ProfileRow, 'display_name' | 'timezone'>>
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
      task_assignees: TableDefinition<TaskAssigneeRow, Pick<TaskAssigneeRow, 'task_id' | 'user_id' | 'workspace_id' | 'assigned_by'>, never>
      comments: TableDefinition<
        CommentRow,
        Pick<CommentRow, 'workspace_id' | 'task_id' | 'author_id' | 'body_md'>,
        Pick<CommentRow, 'body_md'>
      >
      channel_reminders: TableDefinition<ChannelReminderRow, never, never>
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
      get_my_profile_preferences: { Args: Record<string, never>; Returns: Pick<ProfileRow, 'id' | 'display_name' | 'timezone' | 'must_change_password'>[] }
      set_task_assignees: { Args: { p_task_id: string; p_assignee_ids: string[] }; Returns: undefined }
      set_task_channel_reminder: { Args: { p_task_id: string; p_remind_at: string }; Returns: string }
      cancel_channel_reminder: { Args: { p_reminder_id: string }; Returns: undefined }
      reschedule_channel_reminder: { Args: { p_reminder_id: string; p_remind_at: string }; Returns: undefined }
      reexport_channel_reminder: { Args: { p_reminder_id: string }; Returns: undefined }
      create_task_with_channel_reminder_v2: { Args: { p_workspace_id: string; p_task: Json; p_label_ids: string[]; p_assignee_ids: string[]; p_remind_at: string | null }; Returns: string }
      update_task_with_channel_reminder_v2: { Args: { p_task_id: string; p_task: Json; p_label_ids: string[]; p_assignee_ids: string[]; p_remind_at: string | null }; Returns: undefined }
    }
    Enums: {
      workspace_role: WorkspaceRole
      task_status: TaskStatus
      task_priority: TaskPriority
      task_schedule_kind: TaskScheduleKind
      channel_reminder_status: ChannelReminderStatus
    }
    CompositeTypes: Record<string, never>
  }
}
