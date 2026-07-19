# AnotherNotion 数据库与 RLS 设计

本文是实施前设计，不包含可执行 migration，也不连接远程 Supabase。所有业务表位于 `public` schema；仅供 RLS 调用的辅助函数放在不可由客户端直接访问的 `private` schema。

## 1. 数据表及字段

### 枚举

- `workspace_role`: `owner`、`member`
- `task_status`: `todo`、`in_progress`、`done`
- `task_priority`: `low`、`medium`、`high`、`urgent`
- `task_schedule_kind`: `none`、`all_day`、`timed`

数据库枚举用于拒绝未知状态；以后新增枚举值应通过独立 migration 完成。

### `profiles`

| 字段 | 类型 | 约束/说明 |
| --- | --- | --- |
| `id` | `uuid` | PK，FK → `auth.users(id)`，`on delete cascade` |
| `display_name` | `text` | NOT NULL，去除首尾空格后 1–80 字符 |
| `timezone` | `text` | NOT NULL，IANA 时区名称 |
| `created_at` | `timestamptz` | NOT NULL，默认 `now()` |
| `updated_at` | `timestamptz` | NOT NULL，默认 `now()` |

`timezone` 不能只靠任意字符串。migration 应建立由 PostgreSQL 时区名称生成的参考表，或用触发器依据 `pg_timezone_names` 验证。客户端不能写 `id`、创建时间。

### `workspaces`

| 字段 | 类型 | 约束/说明 |
| --- | --- | --- |
| `id` | `uuid` | PK，默认 `gen_random_uuid()` |
| `name` | `text` | NOT NULL，去除首尾空格后 1–100 字符 |
| `created_by` | `uuid` | NOT NULL，FK → `profiles(id)`，`on delete restrict` |
| `created_at` | `timestamptz` | NOT NULL，默认 `now()` |
| `updated_at` | `timestamptz` | NOT NULL，默认 `now()` |

不允许客户端直接 INSERT；必须调用 `create_workspace`，保证工作区和首位 owner 在同一事务创建。

### `workspace_members`

| 字段 | 类型 | 约束/说明 |
| --- | --- | --- |
| `workspace_id` | `uuid` | FK → `workspaces(id)`，`on delete cascade` |
| `user_id` | `uuid` | FK → `profiles(id)`，`on delete cascade` |
| `role` | `workspace_role` | NOT NULL |
| `joined_at` | `timestamptz` | NOT NULL，默认 `now()` |
| `added_by` | `uuid` | FK → `profiles(id)`，`on delete set null`；首位 owner 可为自己 |

复合 PK：`(workspace_id, user_id)`。成员上限 10 必须在数据库函数内锁定对应 `workspaces` 行后计数，不能只由 UI 检查。客户端没有 INSERT/UPDATE/DELETE policy，所有成员管理均通过受控函数完成。

### `tasks`

| 字段 | 类型 | 约束/说明 |
| --- | --- | --- |
| `id` | `uuid` | PK，默认 `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL，FK → `workspaces(id)`，`on delete cascade` |
| `title` | `text` | NOT NULL，去除首尾空格后 1–300 字符 |
| `description_md` | `text` | NOT NULL，默认空字符串；存 Markdown 原文 |
| `status` | `task_status` | NOT NULL，默认 `todo` |
| `priority` | `task_priority` | NOT NULL，默认 `medium` |
| `assignee_id` | `uuid` | 可空，FK → `profiles(id)`，`on delete set null` |
| `schedule_kind` | `task_schedule_kind` | NOT NULL，默认 `none` |
| `due_date` | `date` | 仅全天任务使用 |
| `due_at` | `timestamptz` | 仅精确时间任务使用 |
| `created_by` | `uuid` | NOT NULL，FK → `profiles(id)`，`on delete restrict` |
| `created_at` | `timestamptz` | NOT NULL，默认 `now()` |
| `updated_at` | `timestamptz` | NOT NULL，默认 `now()` |
| `deleted_at` | `timestamptz` | 可空；非空表示进入回收站 |
| `deleted_by` | `uuid` | 可空，FK → `profiles(id)`，`on delete set null` |

日期约束：

- `none`：`due_date`、`due_at` 都必须为空。
- `all_day`：仅 `due_date` 非空；日历日期不做时区换算。
- `timed`：仅 `due_at` 非空；展示时按用户 `profiles.timezone` 转换。

插入/更新触发器必须确认 `assignee_id` 属于同一工作区，并维护 `updated_at`。软删除时同时设置 `deleted_at` 和 `deleted_by`；恢复时同时清空。

### `labels`

| 字段 | 类型 | 约束/说明 |
| --- | --- | --- |
| `id` | `uuid` | PK，默认 `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL，FK → `workspaces(id)`，`on delete cascade` |
| `name` | `text` | NOT NULL，去除首尾空格后 1–50 字符 |
| `color` | `text` | NOT NULL，限制为 `#RRGGBB` |
| `created_by` | `uuid` | NOT NULL，FK → `profiles(id)`，`on delete restrict` |
| `created_at` | `timestamptz` | NOT NULL，默认 `now()` |
| `updated_at` | `timestamptz` | NOT NULL，默认 `now()` |

唯一约束：`(workspace_id, lower(name))`，避免同一工作区大小写不同的重复标签。实现时可用唯一表达式索引。

### `task_labels`

| 字段 | 类型 | 约束/说明 |
| --- | --- | --- |
| `task_id` | `uuid` | FK → `tasks(id)`，`on delete cascade` |
| `label_id` | `uuid` | FK → `labels(id)`，`on delete cascade` |
| `workspace_id` | `uuid` | NOT NULL，FK → `workspaces(id)`，`on delete cascade` |
| `created_at` | `timestamptz` | NOT NULL，默认 `now()` |

复合 PK：`(task_id, label_id)`。保留 `workspace_id` 便于 RLS 和索引；触发器必须验证 task、label 与该字段属于同一工作区，防止跨工作区关联。

### `comments`

| 字段 | 类型 | 约束/说明 |
| --- | --- | --- |
| `id` | `uuid` | PK，默认 `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL，FK → `workspaces(id)`，`on delete cascade` |
| `task_id` | `uuid` | NOT NULL，FK → `tasks(id)`，`on delete cascade` |
| `author_id` | `uuid` | NOT NULL，FK → `profiles(id)`，`on delete restrict` |
| `body_md` | `text` | NOT NULL，去除首尾空格后 1–10,000 字符 |
| `created_at` | `timestamptz` | NOT NULL，默认 `now()` |
| `updated_at` | `timestamptz` | NOT NULL，默认 `now()` |

触发器确保 comment 与 task 的 `workspace_id` 一致。所有成员可读和新增评论；默认仅作者可编辑/删除自己的评论。若产品要求所有成员都能管理评论，可在实施前明确后放宽。

### 必要索引

- `workspace_members(user_id, workspace_id)`；复合 PK 已覆盖以 workspace 开头的查询。
- 每个含 `workspace_id` 的业务表建立以它开头的索引。
- `tasks(workspace_id, assignee_id)`。
- `tasks(workspace_id, due_at)`，建议仅索引 `schedule_kind = 'timed' AND deleted_at IS NULL`。
- `tasks(workspace_id, due_date)`，建议仅索引 `schedule_kind = 'all_day' AND deleted_at IS NULL`。
- `tasks(workspace_id, status)`，建议仅索引 `deleted_at IS NULL`。
- `tasks(workspace_id, deleted_at)`；另建 `deleted_at IS NOT NULL` 的回收站部分索引。
- `labels(workspace_id)`、`task_labels(workspace_id, task_id)`、`comments(workspace_id, task_id, created_at)`。

## 2. 表之间的关系

```text
auth.users 1 ── 1 profiles
profiles   1 ── N workspace_members N ── 1 workspaces
workspaces 1 ── N tasks
workspaces 1 ── N labels
tasks      N ── N labels              (通过 task_labels)
tasks      1 ── N comments
profiles   1 ── N tasks               (created_by / assignee_id)
profiles   1 ── N comments            (author_id)
```

`workspace_id` 是业务数据的租户边界。所有跨表写入必须同时校验这个边界，不能因为调用者能访问两个工作区，就允许把两个工作区的数据关联起来。

## 3. RLS policy 清单

所有七张业务表均 `ENABLE ROW LEVEL SECURITY` 并 `FORCE ROW LEVEL SECURITY`。不为 `anon` 创建任何 policy，也不向 `anon` 授予表权限。所有 policy 都显式限定 `TO authenticated`。

| 表 | 操作 | Policy / 条件 |
| --- | --- | --- |
| `profiles` | SELECT | 自己，或与自己至少共享一个工作区的用户 |
| `profiles` | UPDATE | `id = auth.uid()`；`WITH CHECK` 同样限制，列权限仅允许 `display_name`、`timezone` |
| `profiles` | INSERT/DELETE | 无客户端 policy；仅 auth 触发器创建，账号清理由级联处理 |
| `workspaces` | SELECT | `private.is_workspace_member(id)` |
| `workspaces` | UPDATE | `private.is_workspace_owner(id)`；禁止修改 `id`、`created_by`、`created_at` |
| `workspaces` | INSERT/DELETE | 无直接 policy；创建走 RPC；删除可暂不开放或走 owner 专用 RPC |
| `workspace_members` | SELECT | `private.is_workspace_member(workspace_id)` |
| `workspace_members` | INSERT/UPDATE/DELETE | 无直接 policy；全部走 owner 专用 RPC，客户端永远不能直接写 `role` |
| `tasks` | SELECT | `private.is_workspace_member(workspace_id)`，包含回收站记录；普通列表由查询显式加 `deleted_at IS NULL` |
| `tasks` | INSERT | `private.is_workspace_member(workspace_id)`，且 `created_by = auth.uid()`；触发器验证负责人 |
| `tasks` | UPDATE | USING 和 WITH CHECK 均为当前/目标工作区成员；禁止改变 `workspace_id`、`created_by`、`created_at` |
| `tasks` | DELETE | 默认无 policy，避免绕过回收站；永久清理由后端定时任务或受控 owner RPC 执行 |
| `labels` | SELECT/INSERT/UPDATE/DELETE | 工作区成员；INSERT 要求 `created_by = auth.uid()`；禁止改变租户与审计列 |
| `task_labels` | SELECT/INSERT/DELETE | 工作区成员；触发器验证 task/label/workspace 一致；无需 UPDATE |
| `comments` | SELECT | 工作区成员 |
| `comments` | INSERT | 工作区成员且 `author_id = auth.uid()`；触发器验证 task/workspace 一致 |
| `comments` | UPDATE/DELETE | 工作区成员且 `author_id = auth.uid()`；禁止改变作者、任务、工作区和创建时间 |

仅有 row policy 不足以保护不可变字段。因此还要撤销表级默认写权限，再按列授予可写字段，辅以 `BEFORE UPDATE` 触发器拒绝修改租户键、角色和审计字段。

## 4. 需要的数据库函数

### RLS 辅助函数（`private` schema）

- `private.is_workspace_member(p_workspace_id uuid, p_user_id uuid default auth.uid()) returns boolean`
- `private.is_workspace_owner(p_workspace_id uuid, p_user_id uuid default auth.uid()) returns boolean`
- `private.share_workspace_with(p_user_id uuid) returns boolean`，供 profile 可见性判断使用

这些函数应为 `STABLE SECURITY DEFINER`，由受信任的 migration owner 持有，函数体使用完全限定表名，固定 `SET search_path = pg_catalog`，并撤销 `PUBLIC` 的 EXECUTE。它们避免 `workspace_members` policy 自引用导致无限递归。不要接受由客户端传入的“当前用户”来代替 `auth.uid()` 做授权。

### 受控业务函数

- `public.create_workspace(p_name text) returns uuid`：要求 `auth.uid()` 非空；创建 workspace，并在同一事务把调用者插入为唯一首位 `owner`。
- `public.add_workspace_member(p_workspace_id uuid, p_user_id uuid) returns void`：确认调用者是 owner；锁定 workspace 行；确认目标 profile 存在；计数小于 10；始终插入 `role = 'member'`。
- `public.remove_workspace_member(p_workspace_id uuid, p_user_id uuid) returns void`：确认调用者是 owner；不得移除任何 owner；删除普通成员。移除成员后，把该工作区中其负责的任务 `assignee_id` 置空。
- 可选 `public.delete_workspace(p_workspace_id uuid) returns void`：仅 owner 可调用，并应要求二次确认参数；第一版可以不开放。
- 可选后台函数 `private.purge_deleted_tasks(p_before timestamptz)`：仅 `service_role`/计划任务可执行，永久清理超期回收站数据。

所有 `SECURITY DEFINER` 函数都必须：固定 `search_path`、完全限定对象名、验证 `auth.uid()`、撤销 `PUBLIC EXECUTE`，再只向所需角色授权。`add_workspace_member` 不接收 role 参数，因此任何客户端请求都不能借此成为 owner。本阶段不提供客户端 ownership transfer；若未来需要，必须单独设计“转让后旧 owner 降级、且始终恰有一个 owner”的原子函数。

### 触发器函数

- `public.handle_new_user()`：`auth.users` AFTER INSERT，安全创建 profile；显示名称从可信默认值/经过长度限制的 metadata 获取，时区默认 `UTC`。函数固定 search_path，不信任用户 metadata 中的角色或 workspace。
- `private.set_updated_at()`：更新带 `updated_at` 的表。
- `private.validate_profile_timezone()`：验证 IANA 时区。
- `private.validate_task_assignee()`：负责人必须属于 task 工作区。
- `private.validate_task_label_workspace()`：三方 workspace 必须一致。
- `private.validate_comment_workspace()`：comment 与 task workspace 必须一致。
- `private.protect_immutable_columns()`：按表阻止租户键、创建者、角色等字段被更改。

## 5. Migration 顺序

1. 扩展、`private` schema、枚举及通用工具（更新时间、时区验证）。
2. 创建 `profiles`，随后创建 `auth.users → profiles` 触发器；回填已有 auth 用户时必须幂等。
3. 创建 `workspaces`、`workspace_members` 及基础约束。
4. 创建不依赖 RLS 的 membership/owner 辅助函数。
5. 创建 `tasks`、`labels`、`task_labels`、`comments` 及跨工作区验证触发器。
6. 创建约束、唯一索引和查询索引。
7. 创建 `create_workspace`、成员管理及可选清理函数；收紧函数 EXECUTE 权限。
8. 启用并强制所有业务表 RLS，创建 policy，撤销默认权限并按表/列重新 GRANT。
9. 在本地临时数据库运行 seed 与权限测试：anon、非成员、member、owner、跨工作区、角色提升、11 人并发加入、软删除/恢复。
10. 审阅生成 SQL 后才进入远程 migration 流程；本阶段不执行 `db push`。

拆分 migration 时要保持每一步可回滚；RLS 与授权应在业务表对 API 可见之前完成，避免“表已创建但 policy 尚未部署”的窗口。

## 6. 安全风险与缓解措施

- **RLS 递归或绕过**：membership helper 由受信任 owner 持有，固定 search_path，客户端只能执行最小函数集合；测试非成员和跨租户访问。
- **角色提升**：不提供 `workspace_members` 直接写 policy；成员 RPC 固定写入 `member`；不从 user metadata 读取角色。
- **成员上限竞态**：单纯 `count(*) < 10` 会并发越限；函数先 `FOR UPDATE` 锁 workspace，再计数和插入。
- **跨工作区外键拼接**：普通 FK 只验证记录存在，不能验证同租户；用复合唯一约束/复合 FK（优先）或触发器验证。
- **可变列绕过 policy**：UPDATE policy 不能限制具体列；使用列级 GRANT 和不可变字段触发器双重保护。
- **SECURITY DEFINER 注入/对象劫持**：固定 `search_path = pg_catalog`、完全限定对象名、严格参数类型、撤销 PUBLIC EXECUTE。
- **Markdown XSS**：数据库只存原文；前端渲染 Markdown 时必须禁用原始 HTML或使用可靠 sanitizer，不能把结果直接传给 `dangerouslySetInnerHTML`。
- **时区错误**：全天日期用 `date`，不转 UTC；精确时刻用 `timestamptz`；只接受有效 IANA 名称。
- **软删除泄漏**：RLS 允许成员访问回收站是产品需要，但所有普通任务查询必须统一过滤 `deleted_at IS NULL`；可建立只读 view/RPC 降低漏加过滤的风险。
- **service role 泄漏**：service-role key 永远不能进入 Vite 环境变量或浏览器；前端只使用 publishable key。
- **用户删除与审计**：关键作者 FK 使用 `restrict` 会阻止直接删除 profile。上线前需确定账号注销策略（匿名化或保留审计），不要随意 cascade 删除任务/评论。
- **owner 锁死或孤儿工作区**：第一版每个工作区仅一个 owner，禁止删除 owner membership；未来的 ownership transfer 必须原子完成。

## 7. 第一位 owner 初始化流程

推荐使用登录用户自助创建工作区，而不是在 Dashboard 手工改角色：

1. 用户通过 Supabase Auth 注册。
2. `handle_new_user` 触发器自动建立同 ID 的 profile，默认时区为 `UTC`；用户随后只能修改自己的显示名称和时区。
3. 登录后的用户调用 `create_workspace(name)`，不传 user ID 或 role。
4. 函数读取 `auth.uid()`，在一个事务中创建 workspace，并插入 `(workspace_id, auth.uid(), 'owner')`。
5. 函数返回 workspace ID；提交后 RLS 立即允许该 owner 读取工作区。
6. owner 通过 `add_workspace_member` 添加成员；函数始终写 `member` 并原子执行 10 人上限检查。

若已有工作区数据需要导入，使用一次性、经代码审阅的 migration 由数据库管理员明确插入首位 owner；不要使用长期暴露的客户端函数，也不要把 service-role key 放到前端。初始化完成后应验证每个 workspace 恰有一个 owner，并移除一次性脚本。

## 实施前验收标准

- anon 对七张业务表的 SELECT/写入均失败。
- A 工作区成员无法读取或修改 B 工作区任何数据。
- member 无法更新任何 membership role，也不能调用 owner 成员管理函数成功。
- owner 添加第 11 名成员失败，并发请求也不能突破上限。
- 任意客户端都不能创建 owner；首位 owner 只能在创建 workspace 的原子流程产生。
- 非本工作区用户不能被设为负责人，跨工作区 task-label/comment 关联失败。
- 普通任务列表不显示软删除任务，回收站仅显示 `deleted_at IS NOT NULL`。
- profile 更新只能作用于 `auth.uid()`，角色不能来自 auth metadata。
