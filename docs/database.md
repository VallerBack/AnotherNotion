# AnotherNotion 数据库

当前采用单工作区、所有成员同权模型。`workspace_members.role` 保留但不参与任何权限决定；所有共享内容操作都验证 `auth.uid()` 对应的 membership。

可执行结构位于 `supabase/migrations/20260719000100_initial_schema.sql`。本阶段只创建 migration 文件，不会自动连接或推送远程数据库。

## 数据模型

`profiles` 与 `auth.users` 一对一，保存显示名称和 IANA 时区。注册后由 `handle_new_user` 自动创建，默认时区为 `UTC`。

`workspaces` 是租户边界，`workspace_members` 连接用户和工作区。每个工作区最多 10 人，并通过部分唯一索引保证同一时间只有一个 owner。成员关系不能直接从客户端写入。

`tasks` 属于工作区，支持 Markdown 描述、状态、优先级、负责人和回收站：

- `schedule_kind = none`：没有日期。
- `schedule_kind = all_day`：使用 `due_date date`，不做时区换算。
- `schedule_kind = timed`：使用 `due_at timestamptz`，展示时转换到 profile 时区。
- `deleted_at` 非空表示软删除，`deleted_by` 由触发器维护。

`labels` 属于工作区，同一工作区的标签名称不区分大小写且唯一。`task_labels` 构成任务与标签的多对多关系，并保存 `workspace_id` 以便实施租户检查。`comments` 属于任务和工作区，正文保存 Markdown 原文。

```text
auth.users 1──1 profiles
profiles N──N workspaces (workspace_members)
workspaces 1──N tasks 1──N comments
workspaces 1──N labels N──N tasks (task_labels)
```

## 受控操作

- `create_workspace(name)`：创建工作区，并把当前登录用户设为首位 owner。
- `add_workspace_member(workspace_id, user_id)`：仅 owner；加锁后检查 10 人上限，新增角色固定为 member。
- `remove_workspace_member(workspace_id, user_id)`：仅 owner；不能移除 owner，并清空被移除成员的任务指派。
- `transfer_workspace_ownership(workspace_id, new_owner_id)`：仅当前 owner；目标必须是现有 member，原子交换角色。

所有 `SECURITY DEFINER` 函数固定 `search_path = pg_catalog`，使用完全限定对象名，并撤销默认执行权限。

## 索引

任务索引覆盖 `workspace_id`、`assignee_id`、`due_at`、`due_date`、`status` 和 `deleted_at`；活跃任务与回收站使用部分索引。成员、标签、任务标签和评论也具有以 `workspace_id` 开头的访问索引。

## TypeScript 类型

前端数据库类型位于 `src/types/database.ts`，并已传入 `createClient<Database>()`。数据库结构改变后应同步更新；连接到已应用 migration 的环境后，可用 Supabase CLI 重新生成并替换手写类型。

## 本地应用方式

需要 Docker 可用，然后执行：

```powershell
npx supabase start
npx supabase db reset
```

`db reset` 只重建本地数据库。确认 migration 和权限测试通过并经过审阅后，才能另行决定是否推送远程；本阶段禁止 `supabase db push`。
