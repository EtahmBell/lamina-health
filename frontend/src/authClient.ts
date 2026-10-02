import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

export const authConfigured = Boolean(supabaseUrl && supabaseAnonKey)

let client: SupabaseClient | null = null

function getClient(): SupabaseClient {
  if (!authConfigured) throw new Error('Supabase authentication is not configured')
  if (!client) {
    client = createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  }
  return client
}

export async function signUp(email: string, password: string) {
  const { data, error } = await getClient().auth.signUp({ email, password })
  if (error) throw error
  return data
}

export async function signIn(email: string, password: string) {
  const { data, error } = await getClient().auth.signInWithPassword({ email, password })
  if (error) throw error
  return data
}

export async function signOut() {
  if (!client && !authConfigured) return
  const { error } = await getClient().auth.signOut({ scope: 'local' })
  if (error) throw error
}

export async function getSession(): Promise<Session | null> {
  if (!authConfigured) return null
  const { data, error } = await getClient().auth.getSession()
  if (error) throw error
  return data.session
}

export async function getAccessToken(): Promise<string | null> {
  return (await getSession())?.access_token ?? null
}

export function onAuthStateChange(listener: (session: Session | null) => void) {
  if (!authConfigured) return () => undefined
  const { data } = getClient().auth.onAuthStateChange((_event, session) => listener(session))
  return () => data.subscription.unsubscribe()
}
