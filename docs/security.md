# AnotherNotion RLS 与权限说明

> 当前有效模型（`20260720000100_single_workspace_equal_members.sql`）：系统只有一个工作区，`workspace_members` 只表示是否属于该工作区。`role` 字段仅为兼容历史数据而保留，不参与前端、RLS 或 RPC 授权。下文早期 policy 名称中的 `owner`/`author` 会由该增量 migration 覆盖；最终权限一律以 membership 为准。

七张业务表全部启用并强制 RLS。`anon` 被撤销所有业务表和函数权限，也没有任何针对 anon 的 policy。`authenticated` 先取得最小表/列权限，每一行访问仍必须通过 RLS。

## Policy 清单

### profiles

- `profiles_select_shared`：用户可见自己以及至少共享一个工作区的成员，避免泄露无关账号资料。
- `profiles_update_self`：仅允许 `id = auth.uid()` 的行；列级权限进一步限定只能修改 `display_name`、`timezone`。
- 无 INSERT/DELETE policy；profile 只由 auth trigger 创建。

### workspaces

- `workspaces_select_member`：仅工作区成员可读。
- `workspaces_update_owner`：仅 owner 可更新；列级权限仅开放 `name`。
- 无 INSERT/DELETE policy；创建必须调用受控函数。

### workspace_members

- `workspace_members_select_member`：成员只能读取自己所属工作区的成员列表。
- 无 INSERT/UPDATE/DELETE policy，也不给 authenticated 写表权限。owner 只能调用受控函数管理普通成员或原子转让所有权，因此 member 不能修改自己或他人的角色。

### tasks

- `tasks_select_member`：工作区成员可读，包括回收站记录；普通列表仍需过滤 `deleted_at is null`。
- `tasks_insert_member`：工作区成员可创建，且 `created_by` 必须为 `auth.uid()`。
- `tasks_update_member`：工作区成员可管理任务；列权限禁止修改工作区、创建者和审计字段。删除审计触发器依据 `auth.uid()` 设置 `deleted_by`。
- 无 DELETE policy，客户端不能绕过软删除直接永久删除任务。

### labels

- `labels_select_member`：工作区成员可读。
- `labels_insert_member`：成员可创建，创建者必须是当前用户。
- `labels_update_member`、`labels_delete_member`：成员可管理本工作区标签。

### task_labels

- `task_labels_select_member`、`task_labels_insert_member`、`task_labels_delete_member`：成员可管理本工作区的任务标签关联。
- 没有 UPDATE policy。外键与触发器共同阻止跨工作区关联。

### comments

- `comments_select_member`：只有工作区成员可读。
- `comments_insert_member`：成员可评论，`author_id` 必须是当前用户。
- `comments_update_author`、`comments_delete_author`：只有评论作者本人可修改或删除，且仍须是工作区成员。

## 函数与触发器安全

`private.is_workspace_member`、`private.is_workspace_owner` 和 `private.shares_workspace_with` 以受控 definer 身份查询成员表，避免 workspace_members policy 自引用。它们固定 search path，并只授权 authenticated 执行。

成员管理 RPC 都重新读取 `auth.uid()`，不接受客户端声明的当前角色。添加成员函数把角色固定为 member，并通过锁定 workspace 行防止并发请求突破 10 人上限。角色变化只能由当前 owner 调用所有权转让函数完成，且数据库唯一索引保证最多一个 owner。

`handle_new_user` 不读取 metadata 中的角色或工作区，仅提取并截断显示名称，时区固定为 `UTC`。失败时抛出带 auth user ID 和底层原因的 `Profile creation failed...` 错误，便于服务端排查。

跨工作区负责人、任务标签和评论关联由触发器拒绝。时区触发器依据 PostgreSQL 的 IANA 时区目录验证输入。

## 必测攻击场景

1. anon 对七张表的读写全部失败。
2. 非成员和其他工作区成员不能读取或写入目标工作区。
3. member 不能直接写 `workspace_members`，也不能调用 owner RPC 成功。
4. owner 添加第 11 人失败，并发添加也不能超限。
5. 新增成员只能获得 member；所有权转让后仍只有一个 owner。
6. 跨工作区 assignee、task-label、comment 写入失败。
7. 客户端不能永久删除 tasks，软删除时 `deleted_by` 不能伪造。
8. profile 只能修改本人允许的两列。

service-role key 只能存在于可信服务端，绝不能使用 `VITE_` 变量暴露到浏览器。Markdown 渲染必须禁用原始 HTML或经过可靠 sanitizer。
