import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  HashRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/auth-context'
import { getAuthErrorMessage } from './auth/auth-errors'
import { SupabaseAuthGateway, type AuthGateway } from './auth/auth-gateway'
import { LabelsPage, TaskBoard } from './tasks/TaskWorkspace'
import {
  SupabaseTaskRepository,
  type TaskRepository,
} from './tasks/task-repository'
import {
  isSupabaseConfigured,
  missingSupabaseVariables,
  supabase,
} from './lib/supabase'
import './App.css'

function LoadingPage() {
  return (
    <main className="screen" aria-busy="true">
      <section className="card card--center">
        <span className="spinner" aria-hidden="true" />
        <p>正在恢复登录状态…</p>
      </section>
    </main>
  )
}

function ConfigurationError() {
  return (
    <main className="screen">
      <section className="card" role="alert">
        <p className="eyebrow">CONFIGURATION</p>
        <h1>AnotherNotion</h1>
        <div className="notice notice--error">
          <strong>Supabase 配置缺失</strong>
          <p>
            请在 <code>.env.local</code> 中配置：
            {missingSupabaseVariables.join('、')}
          </p>
        </div>
      </section>
    </main>
  )
}

function LoginPage() {
  const { login, error } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    try {
      await login(email.trim(), password)
    } catch {
      // The provider exposes a localized error in state.
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="screen">
      <section className="card" aria-labelledby="login-title">
        <p className="eyebrow">WELCOME BACK</p>
        <h1 id="login-title">AnotherNotion</h1>
        <p className="intro">使用管理员为你配置的账户登录。</p>
        {error && <div className="notice notice--error" role="alert">{error}</div>}
        <form className="form" onSubmit={submit}>
          <label>
            邮箱
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            密码
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button className="button button--primary" disabled={submitting}>
            {submitting ? '正在登录…' : '登录'}
          </button>
        </form>
      </section>
    </main>
  )
}

function ErrorPage() {
  const { error, retry, logout, session } = useAuth()
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
    } catch {
      // The provider keeps the actionable error message.
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="screen">
      <section className="card" role="alert">
        <p className="eyebrow">CONNECTION ERROR</p>
        <h1>无法加载账户</h1>
        <div className="notice notice--error">{error}</div>
        <div className="actions">
          <button className="button button--primary" disabled={busy} onClick={() => void run(retry)}>
            重试
          </button>
          {session && (
            <button className="button" disabled={busy} onClick={() => void run(logout)}>
              退出登录
            </button>
          )}
        </div>
      </section>
    </main>
  )
}

function WaitingForWorkspace() {
  const { profile, logout } = useAuth()
  return (
    <main className="screen">
      <section className="card card--center">
        <p className="eyebrow">ACCOUNT READY</p>
        <h1>你好，{profile?.displayName}</h1>
        <div className="notice">
          <strong>等待管理员添加</strong>
          <p>你的账户尚未加入工作区。被添加后请刷新页面或重新登录。</p>
        </div>
        <button className="button" onClick={() => void logout()}>退出登录</button>
      </section>
    </main>
  )
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status, memberships } = useAuth()
  const location = useLocation()
  if (status !== 'authenticated' || memberships.length === 0) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return children
}

function Dashboard() {
  const { gateway, memberships } = useAuth()
  const workspace = memberships[0]
  const [taskCount, setTaskCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void gateway
      .loadTaskCount(workspace.workspaceId)
      .then((count) => {
        if (active) setTaskCount(count)
      })
      .catch((reason) => {
        if (active) setError(getAuthErrorMessage(reason, '加载任务'))
      })
    return () => {
      active = false
    }
  }, [gateway, workspace.workspaceId])

  return (
    <section className="workspace-panel">
      <p className="eyebrow">CURRENT WORKSPACE</p>
      <h2>{workspace.workspaceName}</h2>
      <p className="muted">身份：{workspace.role === 'owner' ? 'Owner' : 'Member'}</p>
      {error ? (
        <div className="notice notice--error" role="alert">{error}</div>
      ) : (
        <div className="metric">
          <span>当前任务</span>
          <strong>{taskCount ?? '—'}</strong>
        </div>
      )}
    </section>
  )
}

function PasswordPage() {
  const { changePassword } = useAuth()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setMessage(null)
    setError(null)
    if (password !== confirmation) {
      setError('两次输入的密码不一致。')
      return
    }
    setSubmitting(true)
    try {
      await changePassword(password)
      setPassword('')
      setConfirmation('')
      setMessage('密码已更新。')
    } catch (reason) {
      setError(getAuthErrorMessage(reason, '修改密码'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="workspace-panel">
      <p className="eyebrow">SECURITY</p>
      <h2>修改密码</h2>
      {message && <div className="notice notice--success" role="status">{message}</div>}
      {error && <div className="notice notice--error" role="alert">{error}</div>}
      <form className="form" onSubmit={submit}>
        <label>
          新密码
          <input type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <label>
          确认新密码
          <input type="password" autoComplete="new-password" minLength={8} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
        </label>
        <button className="button button--primary" disabled={submitting}>
          {submitting ? '正在更新…' : '更新密码'}
        </button>
      </form>
    </section>
  )
}

const navigation = [
  ['/today', 'Today'],
  ['/calendar', 'Calendar'],
  ['/tasks', 'All Tasks'],
  ['/my-tasks', 'My Tasks'],
  ['/trash', 'Trash'],
  ['/labels', 'Labels'],
  ['/settings/password', 'Settings'],
] as const

function AppLayout({ taskRepository }: { taskRepository?: TaskRepository }) {
  const { profile, logout } = useAuth()
  return (
    <main className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/">AnotherNotion</Link>
        <nav aria-label="账户导航">
          <span>{profile?.displayName}</span>
          <Link to="/settings/password">修改密码</Link>
          <button className="link-button" onClick={() => void logout()}>退出登录</button>
        </nav>
      </header>
      {taskRepository ? <div className="workspace-layout">
        <aside className="sidebar" aria-label="主导航">
          {navigation.map(([to, label]) => <Link key={to} to={to}>{label}</Link>)}
        </aside>
        <div className="workspace-content"><Routes>
          <Route path="/" element={<Navigate to="/today" replace />} />
          <Route path="/today" element={<TaskBoard repository={taskRepository} view="today" />} />
          <Route path="/calendar" element={<TaskBoard repository={taskRepository} view="calendar" />} />
          <Route path="/tasks" element={<TaskBoard repository={taskRepository} view="all" />} />
          <Route path="/my-tasks" element={<TaskBoard repository={taskRepository} view="mine" />} />
          <Route path="/trash" element={<TaskBoard repository={taskRepository} view="trash" />} />
          <Route path="/labels" element={<LabelsPage repository={taskRepository} />} />
          <Route path="/settings/password" element={<PasswordPage />} />
          <Route path="*" element={<Navigate to="/today" replace />} />
        </Routes></div>
      </div> : <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/settings/password" element={<PasswordPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>}
    </main>
  )
}

function AuthenticatedRoutes({ taskRepository }: { taskRepository?: TaskRepository }) {
  const auth = useAuth()
  if (auth.status === 'loading') return <LoadingPage />
  if (auth.status === 'error') return <ErrorPage />
  if (auth.status === 'anonymous') return <LoginPage />
  if (auth.memberships.length === 0) return <WaitingForWorkspace />

  return (
    <ProtectedRoute>
      <AppLayout taskRepository={taskRepository} />
    </ProtectedRoute>
  )
}

export function AuthApp({
  gateway,
  taskRepository,
}: {
  gateway: AuthGateway
  taskRepository?: TaskRepository
}) {
  return (
    <HashRouter>
      <AuthProvider gateway={gateway}>
        <Routes>
          <Route path="/login" element={<AuthenticatedRoutes taskRepository={taskRepository} />} />
          <Route path="/*" element={<AuthenticatedRoutes taskRepository={taskRepository} />} />
        </Routes>
      </AuthProvider>
    </HashRouter>
  )
}

function App() {
  if (!isSupabaseConfigured || !supabase) return <ConfigurationError />
  return (
    <AuthApp
      gateway={new SupabaseAuthGateway(supabase)}
      taskRepository={new SupabaseTaskRepository(supabase)}
    />
  )
}

export default App
