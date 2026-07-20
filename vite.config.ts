import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command, mode }) => {
  if (command === 'build') {
    const env = loadEnv(mode, '.', '')
    const url = env.VITE_SUPABASE_URL?.trim()
    const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
    const missing = [
      !url && 'VITE_SUPABASE_URL',
      !publishableKey && 'VITE_SUPABASE_PUBLISHABLE_KEY',
    ].filter(Boolean)
    if (missing.length > 0) {
      throw new Error(`Production build configuration is missing: ${missing.join(', ')}`)
    }
    if (!/^https:\/\/[^\s/]+(?:\/.*)?$/i.test(url!)) {
      throw new Error('VITE_SUPABASE_URL must be a valid HTTPS URL')
    }
  }

  return {
    base: '/AnotherNotion/',
    plugins: [react()],
  }
})
