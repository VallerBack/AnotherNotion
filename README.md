# AnotherNotion

AnotherNotion 是一个面向小型团队的单工作区协作应用。所有工作区成员拥有相同的内容权限，可以共同管理任务、标签、评论、日历和回收站内容。

## 主要功能

- 创建、编辑、完成、回收、恢复和永久删除共享任务
- 月视图和周视图日历，支持点击创建、点击编辑及拖拽调整日期
- 负责人、标签和状态筛选
- 标签与评论协作及 Supabase Realtime 实时更新
- 频道提醒 JSON Feed，支持外部机器人定时抓取与防重复导出
- 账号设置、密码修改和 IANA 时区选择
- 数据库统一保存 UTC `timestamptz`，界面按用户账号时区显示
- Supabase RLS：匿名用户不可访问，认证用户必须是工作区成员

## 技术栈

- React 19、TypeScript、Vite
- FullCalendar、Luxon
- Supabase Auth、Postgres、RLS、Realtime、Edge Functions
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

`.env.local` 只能保存在本机，并且已经被 `.gitignore` 忽略。不要提交数据库密码、`service_role`、Feed Token 或其他线上密钥。

## 环境变量

前端构建需要：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Supabase Edge Functions 使用的服务端 Secrets：

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`（或平台提供的 `SUPABASE_ANON_KEY`）
- `SUPABASE_SECRET_KEY`（旧项目可使用 `SUPABASE_SERVICE_ROLE_KEY`）
- `APP_URL`
- `REMINDER_FEED_TOKEN`
- `REMINDER_JSON_AES_KEY`（标准 Base64 编码的 32 字节 AES 密钥，仅供 GitHub Actions 生成静态快照）

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

## 频道提醒架构

任务日期和提醒时间在 Postgres 中以 UTC `timestamptz` 保存。前端使用账号的 IANA 时区完成输入和显示转换。

- `channel_reminders` 每个任务与提醒时间只保存一条频道提醒。
- `reminder-feed` 仅接受带 `X-Feed-Token` 的 GET 请求，并以原子 RPC 领取最多 20 条到期提醒。
- 领取采用一次性导出语义；“已导出”只表示数据已经交给频道服务，不代表 Discord 或 QQ 最终送达。
- `APP_URL` 用于生成 GitHub Pages HashRouter 任务详情地址。
- 外部机器人只获得安全的纯文字内容，不会获得邮箱、用户 UUID、工作区 UUID 或内部密钥。

GitHub Pages 部署还会生成 `dist/reminders.json`：定时工作流读取旧线上快照，并仅在 schedule 事件中领取新的 Feed 项目。每条记录只有 `content` 使用 AES-256-GCM 独立加密，格式为 `A256GCM.v1.<Base64(IV || TAG || CIPHERTEXT)>`。该文件只进入 Pages artifact，不提交到 Git。GitHub Actions 的 schedule 可能因平台负载延迟，不是精确的五分钟定时器。

管理员可在本地设置 `REMINDER_JSON_AES_KEY` 后，使用以下示例解密单条 `content`；不要把真实密钥写入命令历史或仓库：

```bash
node scripts/decrypt_reminder_content.example.mjs "A256GCM.v1.<encrypted-value>"
```

## 数据库与安全

数据库变更保存在 `supabase/migrations/`。共享业务表保持 RLS 开启；匿名访问不被允许，工作区数据操作必须通过 `workspace_members` 验证成员身份，业务权限不依赖 `role` 字段。

部署数据库或 Edge Functions 前应先审查 migration 和函数代码。公开仓库不得包含内部账号密码、真实邮箱、数据库密码或任何密钥。
