import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth.jsx'

export default function SignInPage() {
  const { signIn, signUp } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [mode, setMode] = useState('signin') // 'signin' | 'signup'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const isSignUp = mode === 'signup'

  async function handleSubmit(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (isSignUp) await signUp(username.trim(), password)
      else await signIn(username.trim(), password)
      navigate(location.state?.from ?? '/')
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-form card" onSubmit={handleSubmit}>
        <h1>{isSignUp ? 'Create an account' : 'Sign in'}</h1>
        <label>
          Username
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
            maxLength={30}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
            required
            minLength={isSignUp ? 8 : undefined}
          />
        </label>
        {isSignUp && (
          <p className="muted auth-hint">
            3–30 characters: lowercase letters, digits, - or _. Password: 8+ characters.
          </p>
        )}
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy || !username.trim() || !password}>
          {busy ? 'Please wait…' : isSignUp ? 'Sign Up' : 'Sign In'}
        </button>
        <p className="auth-switch">
          {isSignUp ? 'Already have an account?' : 'New here?'}{' '}
          <button
            type="button"
            className="btn btn-link"
            onClick={() => {
              setMode(isSignUp ? 'signin' : 'signup')
              setError('')
            }}
          >
            {isSignUp ? 'Sign in' : 'Create an account'}
          </button>
        </p>
      </form>
    </div>
  )
}
