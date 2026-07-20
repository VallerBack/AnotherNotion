import type {
  AuthChangeEvent,
  Session,
  SupabaseClient,
} from '@supabase/supabase-js'
import type { Database } from '../types/database'

export type AuthSession = Pick<Session, 'access_token' | 'expires_at' | 'user'>

export type UserProfile = {
  id: string
  displayName: string
  timezone: string
  notificationEmail: string | null
  notificationEmailVerifiedAt: string | null
  emailNotificationsEnabled: boolean
  mustChangePassword: boolean
}

export type ProfilePreferences = Pick<
  UserProfile,
  'displayName' | 'timezone' | 'notificationEmail' | 'emailNotificationsEnabled'
>

export type NotificationEmailSendResult = {
  sent: boolean
  dryRun: boolean
}

export type WorkspaceMembership = {
  workspaceId: string
  workspaceName: string
}

export type AuthChange = {
  event: AuthChangeEvent
  session: AuthSession | null
}

export interface AuthGateway {
  getSession(): Promise<AuthSession | null>
  onAuthStateChange(listener: (change: AuthChange) => void): () => void
  signIn(email: string, password: string): Promise<AuthSession>
  signOut(): Promise<void>
  updatePassword(password: string): Promise<void>
  updateProfile(userId: string, preferences: ProfilePreferences): Promise<void>
  requestNotificationEmailVerification(): Promise<NotificationEmailSendResult>
  verifyNotificationEmail(token: string): Promise<void>
  loadProfile(userId: string): Promise<UserProfile>
  loadMemberships(userId: string): Promise<WorkspaceMembership[]>
  loadTaskCount(workspaceId: string): Promise<number>
}

function requireData<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message)
  if (data === null) throw new Error('请求未返回数据')
  return data
}

async function throwFunctionError(error: unknown): Promise<never> {
  const context = (error as { context?: Response } | null)?.context
  if (context) {
    const body = await context.clone().json().catch(() => null) as { error?: string } | null
    if (body?.error) throw new Error(body.error)
  }
  throw error
}

async function throwNotificationFunctionError(error: unknown): Promise<never> {
  const context = (error as { context?: Response } | null)?.context
  const status = context?.status ?? 0
  const body = context ? await context.clone().json().catch(() => null) as { error?: string } | null : null
  if (body?.error) throw new Error(body.error)
  if (status === 401) throw new Error('登录状态已失效，请重新登录。')
  if (status === 404) throw new Error('验证邮件服务尚未部署或项目配置不一致。')
  if (status === 429) throw new Error('发送过于频繁，请稍后再试。')
  if (status >= 500) throw new Error('邮件服务暂时不可用。')
  throw new Error('无法调用验证邮件服务，请稍后重试。')
}

export class SupabaseAuthGateway implements AuthGateway {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async getSession() {
    const { data, error } = await this.client.auth.getSession()
    if (error) throw error
    return data.session
  }

  onAuthStateChange(listener: (change: AuthChange) => void) {
    const { data } = this.client.auth.onAuthStateChange((event, session) => {
      listener({ event, session })
    })
    return () => data.subscription.unsubscribe()
  }

  async signIn(email: string, password: string) {
    const { data, error } = await this.client.auth.signInWithPassword({
      email,
      password,
    })
    if (error) throw error
    if (!data.session) throw new Error('登录成功但未返回会话')
    return data.session
  }

  async signOut() {
    const { error } = await this.client.auth.signOut()
    if (error) throw error
  }

  async updatePassword(password: string) {
    const { error } = await this.client.auth.updateUser({ password })
    if (error) throw error
    const completion = await this.client.rpc('complete_password_change')
    if (completion.error) throw completion.error
  }

  async updateProfile(userId: string, preferences: ProfilePreferences) {
    const { error } = await this.client.from('profiles').update({
      display_name: preferences.displayName.trim(),
      timezone: preferences.timezone,
      notification_email: preferences.notificationEmail?.trim() || null,
      email_notifications_enabled: preferences.emailNotificationsEnabled,
    }).eq('id', userId)
    if (error) throw error
  }

  async requestNotificationEmailVerification() {
    const functionName = 'request-email-verification'
    console.info('edge_function_request_started', { functionName })
    const { data, error } = await this.client.functions.invoke(functionName, { body: {} })
    if (error) {
      const status = (error as { context?: Response }).context?.status ?? 0
      const category = status === 401 ? 'unauthorized' : status === 404 ? 'not_found'
        : status === 429 ? 'rate_limited' : status >= 500 ? 'service_error' : 'invoke_error'
      console.warn('edge_function_result', { functionName, status, category, sent: false, dryRun: false })
      await throwNotificationFunctionError(error)
    }
    const result = data as { sent?: unknown; dryRun?: unknown; status?: unknown; category?: unknown } | null
    const status = typeof result?.status === 'number' ? result.status : 0
    const sent = result?.sent === true
    const dryRun = result?.dryRun === true
    const category = typeof result?.category === 'string' ? result.category : sent ? 'accepted' : dryRun ? 'dry_run' : 'invalid_response'
    console.info('edge_function_result', { functionName, status, category, sent, dryRun })
    if (dryRun) return { sent: false, dryRun: true }
    if (!sent) throw new Error('邮件函数未确认实际投递，请稍后重试。')
    return { sent: true, dryRun: false }
  }

  async verifyNotificationEmail(token: string) {
    const { error } = await this.client.functions.invoke('verify-notification-email', {
      body: { token },
    })
    if (error) await throwFunctionError(error)
  }

  async loadProfile(userId: string) {
    const response = await this.client
      .rpc('get_my_profile_preferences')
      .single()
    const profile = requireData(response.data, response.error)
    if (profile.id !== userId) throw new Error('Profile identity mismatch')
    return {
      id: profile.id,
      displayName: profile.display_name,
      timezone: profile.timezone,
      notificationEmail: profile.notification_email,
      notificationEmailVerifiedAt: profile.notification_email_verified_at,
      emailNotificationsEnabled: profile.email_notifications_enabled,
      mustChangePassword: profile.must_change_password,
    }
  }

  async loadMemberships(userId: string) {
    const membershipResponse = await this.client
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', userId)
    const memberships = requireData(
      membershipResponse.data,
      membershipResponse.error,
    )
    if (memberships.length === 0) return []

    const workspaceIds = memberships.map((membership) => membership.workspace_id)
    const workspaceResponse = await this.client
      .from('workspaces')
      .select('id, name')
      .in('id', workspaceIds)
    const workspaces = requireData(workspaceResponse.data, workspaceResponse.error)
    const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))

    return memberships.map((membership) => ({
      workspaceId: membership.workspace_id,
      workspaceName: names.get(membership.workspace_id) ?? '未命名工作区',
    }))
  }

  async loadTaskCount(workspaceId: string) {
    const { count, error } = await this.client
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
    if (error) throw error
    return count ?? 0
  }
}
