当前仓库是 AnotherNotion。

请先完成第一阶段工程初始化：

1. 在当前仓库根目录初始化 React + TypeScript + Vite 项目。
2. 使用 npm。
3. 启用 TypeScript strict mode。
4. 安装 @supabase/supabase-js。
5. 安装并配置 ESLint。
6. 创建 src/lib/supabase.ts，读取：
   - VITE_SUPABASE_URL
   - VITE_SUPABASE_PUBLISHABLE_KEY
7. 如果环境变量缺失，页面应显示清晰的配置错误。
8. 保留现有 .env.local，不读取或输出其中的真实值。
9. 创建安全的 .env.example 和 .gitignore。
10. 在 vite.config.ts 中为 GitHub Pages 设置 base: '/AnotherNotion/'。
11. 路由优先使用 HashRouter，避免 GitHub Pages 刷新后出现 404。
12. 创建一个最简单的启动页，显示 AnotherNotion 和 Supabase 配置状态。
13. 运行 npm install、npm run lint 和 npm run build。
14. 暂时不要创建数据库表，不要运行 SQL，不要执行 supabase db push。
15. 完成后汇报修改文件、测试结果和下一阶段计划。