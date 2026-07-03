import { createContext, useContext, useEffect, useState } from 'react'
import { api } from './api.js'

// user is undefined while the session is loading, null when signed out,
// and { username } when signed in. The JWT lives in an httpOnly cookie,
// so the client only ever tracks the username.
const AuthContext = createContext({ user: undefined })

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined)

  useEffect(() => {
    api
      .me()
      .then((me) => setUser(me.username ? { username: me.username } : null))
      .catch(() => setUser(null))
  }, [])

  const value = {
    user,
    signIn: async (username, password) => {
      const me = await api.login(username, password)
      setUser({ username: me.username })
    },
    signUp: async (username, password) => {
      const me = await api.register(username, password)
      setUser({ username: me.username })
    },
    signOut: async () => {
      await api.logout()
      setUser(null)
    },
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
