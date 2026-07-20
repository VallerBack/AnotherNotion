项目中缺少Supabase Edge Functions目录和实现。请读取当前项目的真实代码、supabase/config.toml、全部migrations和上一阶段的提醒数据结构，然后完成本阶段的函数代码。

必须创建以下目录：

supabase/functions/request-email-verification/
supabase/functions/verify-notification-email/
supabase/functions/send-reminders/

允许根据需要创建：

supabase/functions/_shared/

具体要求：

一、通用要求

1. 使用当前Supabase Edge Functions支持的TypeScript/Deno写法。
2. 读取现有schema，禁止假设表名和字段名。
3. 使用现有task_reminders、profiles、tasks和workspace_members结构。
4. 如果缺少邮箱验证表、领取提醒RPC或必要字段，创建一份新的migration。
5. 禁止修改已经应用的旧migration。
6. 禁止连接、部署或修改远程Supabase。
7. 禁止读取或修改.env.local。
8. 禁止要求我把Secret写入代码。
9. 所有Secret通过Deno.env.get读取。
10. 禁止在日志中输出API Key、Cron Secret、完整邮箱或验证token。
11. 检查并正确配置supabase/config.toml中的函数认证规则。
12. 添加必要的CORS和OPTIONS处理。
13. 增加测试，并运行lint、测试和build。

项目已经在Supabase Edge Function Secrets中准备以下名称：

BREVO_API_KEY
BREVO_SENDER_EMAIL
BREVO_SENDER_NAME
BREVO_REPLY_TO_EMAIL
APP_URL
EMAIL_DRY_RUN
CRON_SECRET

二、共享邮件provider

在_shared中创建可复用的Brevo邮件provider：

1. 使用Brevo HTTP API：
   POST https://api.brevo.com/v3/smtp/email
2. 请求头：
   accept: application/json
   content-type: application/json
   api-key: BREVO_API_KEY
3. 从Secrets读取发件邮箱、发件名称和Reply-To。
4. 支持textContent和htmlContent。
5. 对插入HTML的用户内容进行转义。
6. EMAIL_DRY_RUN=true时禁止调用Brevo。
7. dry-run日志只能包含内部用户ID和提醒ID。
8. 将来应当容易替换成Resend provider。

三、request-email-verification

创建：

supabase/functions/request-email-verification/index.ts

要求：

1. 只允许已登录用户调用。
2. 从有效JWT确定auth.uid()，禁止信任前端提交的user_id。
3. 用户只能验证自己的notification_email。
4. notification_email为空时返回清晰的400错误。
5. 使用安全随机token，至少32字节。
6. 数据库只保存token的SHA-256哈希。
7. token有效期30分钟并且只能使用一次。
8. 新请求使该用户之前未使用的token失效。
9. 限制每分钟一次、每小时最多五次。
10. 通过Brevo发送验证链接。
11. 根据项目现有Router生成正确的GitHub Pages验证地址。
12. 返回通用成功信息，避免泄露邮箱是否存在。

四、verify-notification-email

创建：

supabase/functions/verify-notification-email/index.ts

要求：

1. 接受验证链接中的token。
2. 对token计算SHA-256后查询数据库。
3. 检查未使用、未过期。
4. 使用事务或原子数据库函数，防止token被重复使用。
5. 成功后更新当前profile的notification_email_verified_at。
6. 将token标记为已使用。
7. 无效、过期或已使用token返回清晰错误。
8. 该函数可以由邮件链接打开，但token必须是唯一授权凭据。
9. 增加防止暴力尝试的限制。

五、send-reminders

创建：

supabase/functions/send-reminders/index.ts

要求：

1. 只供Supabase Cron调用。
2. 从请求头读取Cron Secret并与Deno.env.get("CRON_SECRET")比较。
3. Secret缺失或错误返回401。
4. 使用服务端Supabase客户端处理提醒。
5. service role只能在Edge Function运行环境使用。
6. 调用数据库RPC原子领取到期提醒。
7. RPC使用FOR UPDATE SKIP LOCKED。
8. 每次最多领取50条。
9. 领取后设置processing、locked_at和attempt_count。
10. 只发送给：
    notification_email不为空
    notification_email_verified_at不为空
    email_notifications_enabled=true
11. 邮件包含任务标题、日期时间、提醒时间和APP_URL链接。
12. 成功设置status=sent和sent_at。
13. 失败记录last_error并设置next_attempt_at。
14. 使用指数退避重试。
15. 达到最大次数后设置failed。
16. 超时的processing记录能够被下次安全重新领取。
17. 已取消、已发送或任务已删除的提醒禁止发送。
18. 返回JSON：
    claimed
    sent
    failed
    skipped
    dryRun
19. 同一提醒不得重复发送。

六、前端连接

1. 检查上一阶段的账号设置页面。
2. “发送验证邮件”按钮调用request-email-verification。
3. 验证邮件页面调用verify-notification-email。
4. 显示发送中、验证成功、过期和失败状态。
5. 不允许前端调用send-reminders。

七、完成检查

完成后请：

1. 输出创建和修改的文件列表。
2. 确认三个要求的目录都存在。
3. 运行npm lint、测试和build。
4. 如果本机没有Docker，跳过依赖Docker的Supabase本地运行测试并明确说明。
5. 不执行supabase db push。
6. 不执行supabase functions deploy。
7. 最后只告诉我接下来需要人工执行的命令。