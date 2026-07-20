import { createClient } from 'npm:@supabase/supabase-js@2'

function namedKey(jsonName: string, singleNames: string[]) {
  for (const name of singleNames) {
    const value = Deno.env.get(name)
    if (value) return value
  }
  const encoded = Deno.env.get(jsonName)
  if (encoded) {
    const keys = JSON.parse(encoded) as Record<string, string>
    const value = keys.default ?? Object.values(keys)[0]
    if (value) return value
  }
  throw new Error(`Missing Supabase runtime key: ${jsonName}`)
}

function url() {
  const value = Deno.env.get('SUPABASE_URL')
  if (!value) throw new Error('Missing SUPABASE_URL')
  return value
}

export function userClient(authorization: string) {
  return createClient(url(), namedKey('SUPABASE_PUBLISHABLE_KEYS', ['SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY']), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export function serviceClient() {
  return createClient(url(), namedKey('SUPABASE_SECRET_KEYS', ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY']), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

