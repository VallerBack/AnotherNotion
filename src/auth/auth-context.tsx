import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type {
  AuthGateway,
  AuthSession,
  UserProfile,
  WorkspaceMembership,
} from './auth-gateway'
import { getAuthErrorMessage } from './auth-errors'

type AuthStatus = 'loading' | 'anonymous' | 'authenticated' | 'error'

type AuthState = {
  status: AuthStatus
  session: AuthSession | null
  profile: UserProfile | null
  memberships: WorkspaceMembership[]
  error: string | null
}

type AuthContextValue = AuthState & {
  gateway: AuthGateway
  login(email: string, password: string): Promise<void>
  logout(): Promise<void>
  changePassword(password: string): Promise<void>
  retry(): Promise<void>
}

const initialState: AuthState = {
  status: 'loading',
  session: null,
  profile: null,
  memberships: [],
  error: null,
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({
  gateway,
  children,
}: {
  gateway: AuthGateway
  children: ReactNode
}) {
  const [state, setState] = useState(initialState)
  const requestId = useRef(0)
  const manualLogout = useRef(false)

  const hydrate = useCallback(
    async (session: AuthSession) => {
      const currentRequest = ++requestId.current
      setState((current) => ({ ...current, status: 'loading', error: null }))
      try {
        const [profile, memberships] = await Promise.all([
          gateway.loadProfile(session.user.id),
          gateway.loadMemberships(session.user.id),
        ])
        if (currentRequest !== requestId.current) return
        setState({
          status: 'authenticated',
          session,
          profile,
          memberships,
          error: null,
        })
      } catch (error) {
        if (currentRequest !== requestId.current) return
        setState({
          status: 'error',
          session,
          profile: null,
          memberships: [],
          error: getAuthErrorMessage(error, '加载账户'),
        })
      }
    },
    [gateway],
  )

  const setAnonymous = useCallback((error: string | null = null) => {
    requestId.current += 1
    setState({ ...initialState, status: 'anonymous', error })
  }, [])

  useEffect(() => {
    let active = true
    const unsubscribe = gateway.onAuthStateChange(({ event, session }) => {
      if (!active || event === 'INITIAL_SESSION') return
      if (!session) {
        const message = manualLogout.current
          ? null
          : '会话已过期，请重新登录。'
        manualLogout.current = false
        setAnonymous(message)
        return
      }
      void hydrate(session)
    })

    void gateway
      .getSession()
      .then((session) => {
        if (!active) return
        if (session) return hydrate(session)
        setAnonymous()
      })
      .catch((error) => {
        if (!active) return
        setState({
          ...initialState,
          status: 'error',
          error: getAuthErrorMessage(error, '恢复会话'),
        })
      })

    return () => {
      active = false
      requestId.current += 1
      unsubscribe()
    }
  }, [gateway, hydrate, setAnonymous])

  const login = useCallback(
    async (email: string, password: string) => {
      try {
        const session = await gateway.signIn(email, password)
        await hydrate(session)
      } catch (error) {
        setAnonymous(getAuthErrorMessage(error, '登录'))
        throw error
      }
    },
    [gateway, hydrate, setAnonymous],
  )

  const logout = useCallback(async () => {
    manualLogout.current = true
    try {
      await gateway.signOut()
      setAnonymous()
    } catch (error) {
      manualLogout.current = false
      setState((current) => ({
        ...current,
        error: getAuthErrorMessage(error, '退出登录'),
      }))
      throw error
    }
  }, [gateway, setAnonymous])

  const changePassword = useCallback(
    async (password: string) => {
      if (password.length < 8) throw new Error('新密码至少需要 8 个字符')
      await gateway.updatePassword(password)
    },
    [gateway],
  )

  const retry = useCallback(async () => {
    const session = state.session ?? (await gateway.getSession())
    if (session) await hydrate(session)
    else setAnonymous()
  }, [gateway, hydrate, setAnonymous, state.session])

  const value = useMemo(
    () => ({ ...state, gateway, login, logout, changePassword, retry }),
    [state, gateway, login, logout, changePassword, retry],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider')
  return context
}
