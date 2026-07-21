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
  ProfilePreferences,
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
  updateProfile(preferences: ProfilePreferences): Promise<void>
  refreshProfileInBackground(): Promise<void>
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
  const stateRef = useRef(state)
  const requestId = useRef(0)
  const manualLogout = useRef(false)
  const initialSessionHandled = useRef(false)
  const hydration = useRef<{ userId: string; promise: Promise<void> } | null>(null)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const hydrate = useCallback(
    (session: AuthSession) => {
      const existing = hydration.current
      if (existing?.userId === session.user.id) return existing.promise

      const currentRequest = ++requestId.current
      const current = stateRef.current
      const sameReadyUser = current.status === 'authenticated'
        && current.session?.user.id === session.user.id
        && current.profile !== null
      if (!sameReadyUser) {
        setState((previous) => ({ ...previous, status: 'loading', error: null }))
      }

      const promise = (async () => {
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
          if (sameReadyUser) {
            setState((previous) => ({
              ...previous,
              session,
              error: getAuthErrorMessage(error, '刷新账户'),
            }))
          } else {
            setState({
              status: 'error',
              session,
              profile: null,
              memberships: [],
              error: getAuthErrorMessage(error, '加载账户'),
            })
          }
        }
      })()
      hydration.current = { userId: session.user.id, promise }
      void promise.finally(() => {
        if (hydration.current?.promise === promise) hydration.current = null
      })
      return promise
    },
    [gateway],
  )

  const refreshProfile = useCallback(async (session: AuthSession) => {
    await gateway.loadProfile(session.user.id).then((profile) => {
      const current = stateRef.current
      if (current.status !== 'authenticated' || current.session?.user.id !== session.user.id) return
      setState((previous) => ({ ...previous, session, profile, error: null }))
    }).catch((error) => {
      const current = stateRef.current
      if (current.status !== 'authenticated' || current.session?.user.id !== session.user.id) return
      setState((previous) => ({ ...previous, error: getAuthErrorMessage(error, '刷新账户') }))
    })
  }, [gateway])

  const refreshProfileInBackground = useCallback(async () => {
    const session = stateRef.current.session
    if (!session || stateRef.current.status !== 'authenticated') return
    await refreshProfile(session)
  }, [refreshProfile])

  const setAnonymous = useCallback((error: string | null = null) => {
    requestId.current += 1
    setState({ ...initialState, status: 'anonymous', error })
  }, [])

  useEffect(() => {
    let active = true
    const restoreInitialSession = (session: AuthSession | null) => {
      if (!active || initialSessionHandled.current) return
      initialSessionHandled.current = true
      if (session) void hydrate(session)
      else setAnonymous()
    }
    const schedule = (action: () => void) => queueMicrotask(() => {
      if (active) action()
    })

    const unsubscribe = gateway.onAuthStateChange(({ event, session }) => {
      if (!active) return
      if (event === 'INITIAL_SESSION') {
        schedule(() => restoreInitialSession(session))
        return
      }
      if (event === 'TOKEN_REFRESHED') {
        if (session) {
          setState((current) => current.status === 'authenticated'
            ? { ...current, session }
            : current)
        }
        return
      }
      if (event === 'SIGNED_IN' && session) {
        const current = stateRef.current
        const sameReadyUser = current.status === 'authenticated'
          && current.session?.user.id === session.user.id
          && current.profile !== null
        if (sameReadyUser) setState((previous) => ({ ...previous, session }))
        else schedule(() => { void hydrate(session) })
        return
      }
      if (event === 'USER_UPDATED' && session) {
        const current = stateRef.current
        if (current.status === 'authenticated' && current.session?.user.id === session.user.id) {
          setState((previous) => ({ ...previous, session }))
          schedule(() => refreshProfile(session))
        } else {
          schedule(() => { void hydrate(session) })
        }
        return
      }
      if (event === 'SIGNED_OUT') {
        const message = manualLogout.current
          ? null
          : '会话已过期，请重新登录。'
        manualLogout.current = false
        setAnonymous(message)
        return
      }
    })

    void gateway
      .getSession()
      .then((session) => {
        restoreInitialSession(session)
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
  }, [gateway, hydrate, refreshProfile, setAnonymous])

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
      if (state.session) await hydrate(state.session)
    },
    [gateway, hydrate, state.session],
  )

  const updateProfile = useCallback(async (preferences: ProfilePreferences) => {
    if (!state.session) throw new Error('Authentication required')
    await gateway.updateProfile(state.session.user.id, preferences)
    await hydrate(state.session)
  }, [gateway, hydrate, state.session])

  const retry = useCallback(async () => {
    const session = state.session ?? (await gateway.getSession())
    if (session) await hydrate(session)
    else setAnonymous()
  }, [gateway, hydrate, setAnonymous, state.session])

  const value = useMemo(
    () => ({ ...state, gateway, login, logout, changePassword, updateProfile, refreshProfileInBackground, retry }),
    [state, gateway, login, logout, changePassword, updateProfile, refreshProfileInBackground, retry],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider')
  return context
}
