import { Routes, Route, Link, useNavigate } from 'react-router-dom'
import HomePage from './pages/HomePage.jsx'
import TripPage from './pages/TripPage.jsx'
import NewTripPage from './pages/NewTripPage.jsx'
import SignInPage from './pages/SignInPage.jsx'
import { AuthProvider, useAuth } from './auth.jsx'

function HeaderAuth() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()

  if (user === undefined) return <nav className="header-auth" />
  if (!user) {
    return (
      <nav className="header-auth">
        <Link to="/signin" className="header-link">
          Sign In
        </Link>
      </nav>
    )
  }
  return (
    <nav className="header-auth">
      <span className="header-user" title={`Signed in as ${user.username}`}>
        {user.username}
      </span>
      <button
        type="button"
        className="header-link header-signout"
        onClick={async () => {
          await signOut()
          navigate('/')
        }}
      >
        Sign Out
      </button>
    </nav>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <div className="app">
        <header className="app-header">
          <Link to="/" className="brand">
            <span className="brand-mark">✈</span> Itinerary Builder
          </Link>
          <HeaderAuth />
        </header>
        <main className="app-main">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/signin" element={<SignInPage />} />
            <Route path="/trips/new" element={<NewTripPage />} />
            <Route path="/trips/:id" element={<TripPage />} />
            <Route path="*" element={<p className="empty-note">Page not found.</p>} />
          </Routes>
        </main>
      </div>
    </AuthProvider>
  )
}
