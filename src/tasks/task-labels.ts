import type { TaskPriority, TaskReminderStatus, TaskStatus } from '../types/database'

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办', in_progress: '进行中', done: '已完成',
}
export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: '低', medium: '中', high: '高', urgent: '紧急',
}
export const REMINDER_STATUS_LABELS: Record<TaskReminderStatus, string> = {
  pending: '待发送', processing: '处理中', sent: '已发送', failed: '失败', cancelled: '已取消',
}
