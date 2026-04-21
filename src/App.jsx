import { useState, useEffect } from 'react';
import LoginScreen from './components/LoginScreen.jsx';
import PlatformShell from './platform/PlatformShell.jsx';

// ─── Auth config ─────────────────────────────────────────────────────────────
const APP_PASSWORD = import.meta.env.VITE_APP_PASSWORD || 'puxcof-tegnib-diZgy5';

// null = all projects (System Admin)
const ROLES = {
  'roman.merkulov@dynamicalabs.com':    null,
  'dima.shyshov@dynamicalabs.com':      ['NSMG'],
  'kateryna.romanenko@dynamicalabs.com': ['ABS'],
};

const ALLOWED_EMAILS = Object.keys(ROLES);

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
    // Re-derive projects from ROLES in case session was saved before roles existed
    if (!Object.prototype.hasOwnProperty.call(session, 'projects')) {
      session.projects = ROLES[session.email] ?? null;
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
    const normalised = email.trim().toLowerCase();
    const newSession = {
      email:      normalised,
      projects:   ROLES[normalised] ?? null,
      expiresAt:  Date.now() + TOKEN_TTL,
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
    ? <PlatformShell session={session} onLogout={handleLogout} />
    : <LoginScreen onLogin={handleLogin} />;
}
