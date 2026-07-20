# AnotherNotion

AnotherNotion 是一个面向小型团队的单工作区协作应用。所有工作区成员拥有相同的内容权限，可以共同管理任务、标签、评论、日历和回收站内容。

## 主要功能

- 创建、编辑、完成、回收、恢复和永久删除共享任务
- 月视图和周视图日历，支持点击创建、点击编辑及拖拽调整日期
- 负责人、标签和状态筛选
- 标签与评论协作及 Supabase Realtime 实时更新
- 任务邮件提醒、通知邮箱验证和失败重试
- 账号设置、密码修改和 IANA 时区选择
- 数据库统一保存 UTC `timestamptz`，界面按用户账号时区显示
- Supabase RLS：匿名用户不可访问，认证用户必须是工作区成员

## 技术栈

- React 19、TypeScript、Vite
- FullCalendar、Luxon
- Supabase Auth、Postgres、RLS、Realtime、Edge Functions、Cron
- Brevo Transactional Email
- GitHub Pages、GitHub Actions

## 本地启动

需要 Node.js 24 和 npm。

```bash
npm ci
```

复制 `.env.example` 为 `.env.local`，填入前端公开配置：

```dotenv
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key
```

然后启动开发服务器：

```bash
npm run dev
```

上线前本地检查：

```bash
npm run lint
npm test
npm run build
```

`.env.local` 只能保存在本机，并且已经被 `.gitignore` 忽略。不要提交数据库密码、`service_role`、Brevo API Key、Cron Secret 或其他线上密钥。

## 环境变量

前端构建需要：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Supabase Edge Functions 使用的服务端 Secrets：

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`（或平台提供的 `SUPABASE_ANON_KEY`）
- `SUPABASE_SECRET_KEY`（旧项目可使用 `SUPABASE_SERVICE_ROLE_KEY`）
- `BREVO_API_KEY`
- `BREVO_SENDER_EMAIL`
- `BREVO_SENDER_NAME`
- `BREVO_REPLY_TO_EMAIL`
- `APP_URL`
- `CRON_SECRET`
- `EMAIL_DRY_RUN`

服务端变量只能配置在 Supabase Secrets 或 Vault 中，不能写入前端环境变量、仓库文件或 GitHub Pages 构建产物。

## GitHub Pages 部署

Vite 的生产 base 是 `/AnotherNotion/`，应用使用 `HashRouter`，因此仓库 Pages 地址及子路由刷新不会依赖服务器端 SPA fallback。

在 GitHub 仓库的 `Settings → Secrets and variables → Actions` 中创建以下 Repository Secrets：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

然后在 `Settings → Pages → Build and deployment` 中将 Source 设置为 `GitHub Actions`。推送到 `main` 会触发 `.github/workflows/deploy.yml`，也可以在 Actions 页面手动运行。工作流使用 Node.js 24，依次执行 `npm ci`、lint、完整测试和生产构建，最后发布 `dist`。

默认部署地址：

```text
https://<github-user>.github.io/AnotherNotion/
```

## 邮件提醒架构

任务日期和提醒时间在 Postgres 中以 UTC `timestamptz` 保存。前端使用账号的 IANA 时区完成输入和显示转换。

- `request-email-verification`：要求登录 JWT，生成限时、单次使用的验证 token
- `verify-notification-email`：由验证链接调用，消费随机限时 token
- `send-reminders`：由 Supabase Cron 调用，并在函数内部校验 `CRON_SECRET`
- Supabase 数据库函数以 UTC 判断到期提醒并原子认领任务
- Edge Function 调用 Brevo 发送邮件，并按收件人时区格式化展示时间

`EMAIL_DRY_RUN=true` 时不会调用 Brevo，也不会把测试提醒永久标记为已发送。

## 数据库与安全

数据库变更保存在 `supabase/migrations/`。共享业务表保持 RLS 开启；匿名访问不被允许，工作区数据操作必须通过 `workspace_members` 验证成员身份，业务权限不依赖 `role` 字段。

部署数据库或 Edge Functions 前应先审查 migration 和函数代码。公开仓库不得包含内部账号密码、真实邮箱、数据库密码或任何密钥。
