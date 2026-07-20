/* eslint-disable react-refresh/only-export-components */
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin, { type DateClickArg } from '@fullcalendar/interaction'
import luxonPlugin from '@fullcalendar/luxon3'
import type { EventDropArg, EventInput } from '@fullcalendar/core'
import { DateTime } from 'luxon'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/auth-context'
import { DEFAULT_TIMEZONE } from '../lib/datetime'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { TaskEditor, emptyDraft, taskToDraft } from './TaskWorkspace'
import type {
  TaskDraft,
  TaskRecord,
  TaskRepository,
  TaskReminderDraft,
  ReminderRecipient,
  WorkspaceLabel,
  WorkspaceMember,
} from './task-repository'

type CalendarEventProps = { task: TaskRecord }

function nextDate(date: string) {
  return DateTime.fromISO(date, { zone: 'utc' }).plus({ days: 1 }).toISODate()!
}

function previousDate(date: string) {
  return DateTime.fromISO(date, { zone: 'utc' }).minus({ days: 1 }).toISODate()!
}

export function taskToCalendarEvent(
  task: TaskRecord,
  labels: Map<string, WorkspaceLabel>,
): EventInput | null {
  const color = task.labelIds.map((id) => labels.get(id)?.color).find(Boolean)
  const common: EventInput = {
    id: task.id,
    title: task.title,
    backgroundColor: color,
    borderColor: color,
    extendedProps: { task } satisfies CalendarEventProps,
  }

  if (task.scheduleKind === 'all_day') {
    const start = task.startDate ?? task.dueDate
    if (!start) return null
    return {
      ...common,
      allDay: true,
      start,
      end: task.dueDate ? nextDate(task.dueDate) : undefined,
    }
  }

  if (task.scheduleKind === 'timed') {
    const start = task.startAt ?? task.dueAt
    if (!start) return null
    return {
      ...common,
      allDay: false,
      start,
      end: task.startAt && task.dueAt ? task.dueAt : undefined,
    }
  }

  return null
}

export function draftAfterDrop(
  task: TaskRecord,
  start: Date,
  startStr: string,
  end: Date | null,
  endStr: string,
  allDay: boolean,
): TaskDraft {
  const draft = taskToDraft(task)
  if (allDay) {
    return {
      ...draft,
      scheduleKind: 'all_day',
      startDate: startStr.slice(0, 10),
      dueDate: endStr ? previousDate(endStr.slice(0, 10)) : startStr.slice(0, 10),
      startAt: null,
      dueAt: null,
    }
  }

  const startUtc = start.toISOString()
  const endUtc = end?.toISOString() ?? null
  return {
    ...draft,
    scheduleKind: 'timed',
    startDate: null,
    dueDate: null,
    startAt: task.startAt !== null ? startUtc : task.dueAt === null ? startUtc : null,
    dueAt: task.dueAt !== null ? (endUtc ?? startUtc) : null,
  }
}

export async function persistCalendarDrop(
  repository: TaskRepository,
  task: TaskRecord,
  drop: {
    start: Date
    startStr: string
    end: Date | null
    endStr: string
    allDay: boolean
  },
  revert: () => void,
) {
  try {
    await repository.updateTask(
      task.id,
      draftAfterDrop(
        task,
        drop.start,
        drop.startStr,
        drop.end,
        drop.endStr,
        drop.allDay,
      ),
    )
  } catch (error) {
    revert()
    throw error
  }
}

export function CalendarPage({ repository }: { repository: TaskRepository }) {
  const { session, profile, memberships } = useAuth()
  const userId = session?.user.id
  const workspace = memberships[0]
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [labels, setLabels] = useState<WorkspaceLabel[]>([])
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [reminderRecipients, setReminderRecipients] = useState<ReminderRecipient[]>([])
  const status = searchParams.get('status') ?? 'all'
  const assignee = searchParams.get('assignee') ?? 'all'
  const label = searchParams.get('label') ?? 'all'
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const hasLoaded = useRef(false)
  const [editor, setEditor] = useState<{
    key: string
    task: TaskRecord | null
    draft?: TaskDraft
  } | null>(null)

  const load = useCallback(async () => {
    if (!userId) return
    if (!hasLoaded.current) setLoading(true)
    try {
      const [nextTasks, nextLabels, nextMembers, nextReminderRecipients] = await Promise.all([
        repository.listTasks(workspace.workspaceId, userId, 'calendar', profile?.timezone ?? DEFAULT_TIMEZONE),
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
      setError(reason instanceof Error ? reason.message : '加载日历失败')
    } finally {
      setLoading(false)
    }
  }, [profile?.timezone, repository, userId, workspace.workspaceId])

  useEffect(() => { void load() }, [load])
  useEffect(() => repository.subscribeWorkspace?.(workspace.workspaceId, () => { void load() }), [load, repository, workspace.workspaceId])

  const labelMap = useMemo(
    () => new Map(labels.map((item) => [item.id, item])),
    [labels],
  )
  const events = useMemo(
    () => tasks
      .filter((task) => status === 'all' || task.status === status)
      .filter((task) => assignee === 'all' || task.assigneeId === assignee)
      .filter((task) => label === 'all' || task.labelIds.includes(label))
      .map((task) => taskToCalendarEvent(task, labelMap))
      .filter((event): event is EventInput => event !== null),
    [assignee, label, labelMap, status, tasks],
  )

  function dateClick(info: DateClickArg) {
    const draft: TaskDraft = info.allDay
      ? {
          ...emptyDraft,
          scheduleKind: 'all_day',
          startDate: info.dateStr.slice(0, 10),
          dueDate: info.dateStr.slice(0, 10),
        }
      : {
          ...emptyDraft,
          scheduleKind: 'timed',
          startAt: info.date.toISOString(),
          dueAt: DateTime.fromJSDate(info.date).plus({ hours: 1 }).toUTC().toISO(),
        }
    setEditor({ key: `new-${info.dateStr}`, task: null, draft })
  }

  function setFilter(name: 'status' | 'assignee' | 'label', value: string) {
    const next = new URLSearchParams(searchParams)
    if (value === 'all') next.delete(name)
    else next.set(name, value)
    setSearchParams(next, { replace: true })
  }

  async function eventDrop(info: EventDropArg) {
    const task = (info.event.extendedProps as CalendarEventProps).task
    if (!info.event.start) {
      info.revert()
      return
    }
    try {
      await persistCalendarDrop(
        repository,
        task,
        {
          start: info.event.start,
          startStr: info.event.startStr,
          end: info.event.end,
          endStr: info.event.endStr,
          allDay: info.event.allDay,
        },
        info.revert,
      )
      const reminders = await repository.listTaskReminders(task.workspaceId, task.id)
      if (reminders.some((reminder) => ['pending', 'failed'].includes(reminder.status))) {
        window.alert('任务时间已修改，请检查并重新安排关联提醒。')
      }
      await load()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '调整任务日期失败'
      setError(`${message}，已恢复原位置`)
    }
  }

  async function save(draft: TaskDraft, reminder: TaskReminderDraft) {
    if (!session || !editor) return
    if (editor.task) await repository.updateTask(editor.task.id, draft, reminder)
    else await repository.createTask(workspace.workspaceId, session.user.id, draft, reminder)
    setEditor(null)
    await load()
  }

  return (
    <section className="content-panel calendar-panel">
      <div className="section-heading">
        <div><p className="eyebrow">{workspace.workspaceName}</p><h2>日历</h2></div>
      </div>
      <div className="calendar-filters" aria-label="日历筛选">
        <label>状态<select value={status} onChange={(event) => setFilter('status', event.target.value)}>
          <option value="all">全部</option><option value="todo">Todo</option><option value="in_progress">In Progress</option><option value="done">Done</option>
        </select></label>
        <label>负责人<select value={assignee} onChange={(event) => setFilter('assignee', event.target.value)}>
          <option value="all">全部</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}
        </select></label>
        <label>标签<select value={label} onChange={(event) => setFilter('label', event.target.value)}>
          <option value="all">全部</option>{labels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
      </div>
      {error && <div className="notice notice--error" role="alert">{error}<button className="link-button" onClick={() => void load()}>重试</button></div>}
      {loading ? <p className="empty-state" aria-busy="true">正在加载日历…</p> : (
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin, luxonPlugin]}
          initialView="dayGridMonth"
          headerToolbar={{ left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek' }}
          buttonText={{ today: '今天', month: '月', week: '周' }}
          timeZone={profile?.timezone ?? DEFAULT_TIMEZONE}
          events={events}
          editable
          eventStartEditable
          dateClick={dateClick}
          eventContent={(info) => {
            const task = (info.event.extendedProps as CalendarEventProps).task
            const openDetails = () => navigate(`/tasks/${task.id}`, {
              state: { from: `${location.pathname}${location.search}`, scrollY: window.scrollY, cachedTask: task },
            })
            return <span
              className="calendar-task-link"
              role="link"
              tabIndex={0}
              aria-label={`查看任务：${task.title}`}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                openDetails()
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  openDetails()
                }
              }}
            >{info.event.title}</span>
          }}
          eventDrop={(info) => void eventDrop(info)}
          height="auto"
          nowIndicator
          dayMaxEvents
        />
      )}
      {editor && (
        <TaskEditor
          key={editor.key}
          task={editor.task}
          initialDraft={editor.draft}
          labels={labels}
          members={members}
          reminderRecipients={reminderRecipients}
          repository={repository}
          workspaceId={workspace.workspaceId}
          onSave={save}
          onCancel={() => setEditor(null)}
        />
      )}
    </section>
  )
}
