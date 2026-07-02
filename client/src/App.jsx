import { Routes, Route, Link } from 'react-router-dom'
import HomePage from './pages/HomePage.jsx'
import TripPage from './pages/TripPage.jsx'

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <Link to="/" className="brand">
          <span className="brand-mark">✈</span> Itinerary Builder
        </Link>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/trips/:id" element={<TripPage />} />
          <Route path="*" element={<p className="empty-note">Page not found.</p>} />
        </Routes>
      </main>
    </div>
  )
}
