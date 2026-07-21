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
  mustChangePassword: boolean
}

export type ProfilePreferences = Pick<
  UserProfile,
  'displayName' | 'timezone'
>

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
  loadProfile(userId: string): Promise<UserProfile>
  loadMemberships(userId: string): Promise<WorkspaceMembership[]>
  loadTaskCount(workspaceId: string): Promise<number>
}

function requireData<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message)
  if (data === null) throw new Error('请求未返回数据')
  return data
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
    }).eq('id', userId)
    if (error) throw error
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
