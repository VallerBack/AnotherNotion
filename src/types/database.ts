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

type ProfileRow = {
  id: string
  display_name: string
  timezone: string
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
      comments: TableDefinition<
        CommentRow,
        Pick<CommentRow, 'workspace_id' | 'task_id' | 'author_id' | 'body_md'>,
        Pick<CommentRow, 'body_md'>
      >
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
    }
    Enums: {
      workspace_role: WorkspaceRole
      task_status: TaskStatus
      task_priority: TaskPriority
      task_schedule_kind: TaskScheduleKind
    }
    CompositeTypes: Record<string, never>
  }
}
