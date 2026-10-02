import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const auth = readFileSync(new URL('../src/authClient.ts', import.meta.url), 'utf8')
const provider = readFileSync(new URL('../src/AuthProvider.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')

test('Supabase browser auth uses only the public Vite configuration', () => {
  assert.match(auth, /VITE_SUPABASE_URL/)
  assert.match(auth, /VITE_SUPABASE_ANON_KEY/)
  assert.doesNotMatch(auth, /service.?role|MEDPLUM_CLIENT_SECRET/i)
  assert.match(auth, /persistSession: true/)
  assert.match(auth, /autoRefreshToken: true/)
})

test('the reusable provider exposes session lifecycle primitives', () => {
  for (const primitive of ['signUp', 'signIn', 'signOut', 'getSession', 'getAccessToken']) {
    assert.match(auth, new RegExp(`function ${primitive}`))
  }
  assert.match(auth, /signOut\(\{ scope: 'local' \}\)/)
  assert.match(provider, /onAuthStateChange/)
  assert.match(provider, /useAuth/)
  assert.match(main, /<AuthProvider><App \/><\/AuthProvider>/)
})

test('one shared request layer attaches the access token', () => {
  assert.match(api, /const accessToken = await getAccessToken\(\)/)
  assert.match(api, /headers\.set\('Authorization', `Bearer \$\{accessToken\}`\)/)
  assert.equal((api.match(/Authorization/g) || []).length, 1)
  assert.doesNotMatch(api, /X-Demo-User|X-User-Id/)
})

test('claim APIs derive identity server-side and keep the Lucy demo public', () => {
  const claimFunctions = api.slice(api.indexOf('getProviderClaimState'))
  assert.doesNotMatch(claimFunctions, /auth_user_id|authUserId|email:/)
  assert.match(api, /createProviderClaim = \(npi: string\)/)
  assert.match(api, /submitProviderVerification = \(claimId: number\)/)
  assert.match(api, /activateProviderClaim = \(claimId: number\)/)
  assert.match(api, /disableProviderClaim = \(claimId: number\)/)
  assert.match(api, /getPatient = \(id: string\) => request/)
  assert.match(api, /consultNetwork = \(id: string/)
})
