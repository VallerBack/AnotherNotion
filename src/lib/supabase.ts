import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabasePublishableKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

export const missingSupabaseVariables = [
  !supabaseUrl && 'VITE_SUPABASE_URL',
  !supabasePublishableKey && 'VITE_SUPABASE_PUBLISHABLE_KEY',
].filter((name): name is string => Boolean(name))

export const isSupabaseConfigured = missingSupabaseVariables.length === 0

export const supabase: SupabaseClient<Database> | null = isSupabaseConfigured
  ? createClient<Database>(supabaseUrl!, supabasePublishableKey!)
  : null
