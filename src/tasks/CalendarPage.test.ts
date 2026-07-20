import { describe, expect, it, vi } from 'vitest'
import {
  draftAfterDrop,
  persistCalendarDrop,
  taskToCalendarEvent,
} from './CalendarPage'
import type { TaskRecord, TaskRepository, WorkspaceLabel } from './task-repository'

const allDayTask: TaskRecord = {
  id: 'task-1',
  workspaceId: 'workspace-1',
  title: '全天任务',
  descriptionMd: '',
  status: 'todo',
  priority: 'medium',
  assigneeId: null,
  assigneeIds: [],
  scheduleKind: 'all_day',
  startDate: '2026-07-20',
  startAt: null,
  dueDate: '2026-07-20',
  dueAt: null,
  createdBy: 'user-1',
  createdAt: '2026-07-19T16:00:00.000Z',
  updatedAt: '2026-07-20T01:00:00.000Z',
  deletedAt: null,
  labelIds: ['label-1'],
}

describe('FullCalendar task mapping', () => {
  it('keeps all-day dates as local calendar strings and applies label color', () => {
    const labels = new Map<string, WorkspaceLabel>([
      ['label-1', { id: 'label-1', name: '重要', color: '#ef4444' }],
    ])
    const event = taskToCalendarEvent(allDayTask, labels)

    expect(event).toMatchObject({
      allDay: true,
      start: '2026-07-20',
      end: '2026-07-21',
      backgroundColor: '#ef4444',
    })
  })

  it('stores a dragged precise-time task as UTC ISO timestamptz values', () => {
    const timedTask: TaskRecord = {
      ...allDayTask,
      scheduleKind: 'timed',
      startDate: null,
      dueDate: null,
      startAt: '2026-07-20T01:00:00.000Z',
      dueAt: '2026-07-20T02:00:00.000Z',
    }
    const draft = draftAfterDrop(
      timedTask,
      new Date('2026-07-22T09:00:00+08:00'),
      '2026-07-22T09:00:00+08:00',
      new Date('2026-07-22T10:00:00+08:00'),
      '2026-07-22T10:00:00+08:00',
      false,
    )

    expect(draft.startAt).toBe('2026-07-22T01:00:00.000Z')
    expect(draft.dueAt).toBe('2026-07-22T02:00:00.000Z')
  })

  it('reverts the event when persistence fails', async () => {
    const repository = {
      updateTask: vi.fn(async () => { throw new Error('network failure') }),
    } as unknown as TaskRepository
    const revert = vi.fn()

    await expect(persistCalendarDrop(
      repository,
      allDayTask,
      {
        start: new Date('2026-07-23T00:00:00Z'),
        startStr: '2026-07-23',
        end: new Date('2026-07-24T00:00:00Z'),
        endStr: '2026-07-24',
        allDay: true,
      },
      revert,
    )).rejects.toThrow('network failure')
    expect(revert).toHaveBeenCalledOnce()
  })
})
