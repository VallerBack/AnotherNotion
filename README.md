数据库设计确认后，请实施数据库 migration。

要求：
- 使用 supabase/migrations 目录
- 创建一个清晰命名的 initial_schema migration
- migration 包含表、约束、索引、触发器、函数和 RLS
- 不向 anon 开放任何业务表
- authenticated 的权限需要同时经过 RLS
- workspace_members 的角色修改只能由 owner 完成
- 所有 security definer 函数固定 search_path
- profile trigger 失败时应有清晰原因
- 生成 TypeScript 数据库类型或对应接口
- 创建 docs/database.md 解释数据模型
- 创建 docs/security.md 解释每条 RLS policy
- 创建一次性 owner 初始化 SQL 模板，模板中不要包含真实邮箱
- 不要执行 db push
- 完成后运行 lint、test 和 build