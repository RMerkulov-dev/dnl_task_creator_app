import { useState, useEffect } from 'react';
import LoginScreen from './components/LoginScreen.jsx';
import Dashboard from './components/Dashboard.jsx';

// ─── Auth config ─────────────────────────────────────────────────────────────
const APP_PASSWORD = import.meta.env.VITE_APP_PASSWORD || 'puxcof-tegnib-diZgy5';

const ALLOWED_EMAILS = (
  import.meta.env.VITE_ALLOWED_EMAILS ||
  'kateryna.romanenko@dynamicalabs.com,dima.shyshov@dynamicalabs.com,roman.merkulov@dynamicalabs.com'
)
  .split(',')
  .map(e => e.trim().toLowerCase());

const TOKEN_KEY = 'dnl_auth_token';
const TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 hours

function getStoredSession() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (Date.now() > session.expiresAt) {
      localStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(() => getStoredSession());

  // Auto-expire: re-check every minute
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      if (Date.now() > session.expiresAt) {
        handleLogout();
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, [session]);

  // Returns null on success, or 'email' / 'password' error key
  function handleLogin(email, password) {
    if (!ALLOWED_EMAILS.includes(email.trim().toLowerCase())) return 'email';
    if (password !== APP_PASSWORD) return 'password';
    const newSession = {
      email: email.trim().toLowerCase(),
      expiresAt: Date.now() + TOKEN_TTL,
    };
    localStorage.setItem(TOKEN_KEY, JSON.stringify(newSession));
    setSession(newSession);
    return null;
  }

  function handleLogout() {
    localStorage.removeItem(TOKEN_KEY);
    setSession(null);
  }

  return session
    ? <Dashboard user={session.email} expiresAt={session.expiresAt} onLogout={handleLogout} />
    : <LoginScreen onLogin={handleLogin} />;
}
