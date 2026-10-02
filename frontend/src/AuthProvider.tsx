import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import {
  authConfigured,
  getSession,
  onAuthStateChange,
  signIn as authSignIn,
  signOut as authSignOut,
  signUp as authSignUp,
} from './authClient.ts'

type AuthContextValue = {
  configured: boolean
  loading: boolean
  session: Session | null
  user: User | null
  signUp: typeof authSignUp
  signIn: typeof authSignIn
  signOut: typeof authSignOut
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(authConfigured)

  useEffect(() => {
    let mounted = true
    getSession().then((next) => { if (mounted) setSession(next) }).finally(() => {
      if (mounted) setLoading(false)
    })
    const unsubscribe = onAuthStateChange((next) => setSession(next))
    return () => { mounted = false; unsubscribe() }
  }, [])

  const value = useMemo<AuthContextValue>(() => ({
    configured: authConfigured,
    loading,
    session,
    user: session?.user ?? null,
    signUp: authSignUp,
    signIn: authSignIn,
    signOut: authSignOut,
  }), [loading, session])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
