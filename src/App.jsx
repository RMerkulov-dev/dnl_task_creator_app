import { useState, useEffect } from 'react';
import LoginScreen from './components/LoginScreen.jsx';
import PlatformShell from './platform/PlatformShell.jsx';

// ─── Kyiv sunrise/sunset ──────────────────────────────────────────────────────
const KYIV_LAT = 50.4501;
const KYIV_LON = 30.5234;

function getKyivSunTimes() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const dayOfYear = Math.ceil(
    (Date.UTC(year, now.getUTCMonth(), now.getUTCDate()) - Date.UTC(year, 0, 0)) / 86400000
  );
  const B = (2 * Math.PI / 365) * (dayOfYear - 81);
  const EoT = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  const solarNoon = 720 - (4 * KYIV_LON + EoT);
  const declRad = 23.45 * Math.sin(B) * (Math.PI / 180);
  const latRad = KYIV_LAT * (Math.PI / 180);
  const cosHA = (Math.cos(90.833 * Math.PI / 180) - Math.sin(latRad) * Math.sin(declRad)) /
                (Math.cos(latRad) * Math.cos(declRad));
  if (cosHA < -1) return { sunrise: 0, sunset: 1440 };
  if (cosHA > 1)  return { sunrise: 720, sunset: 720 };
  const halfDay = Math.acos(cosHA) * (180 / Math.PI) * 4;
  return { sunrise: solarNoon - halfDay, sunset: solarNoon + halfDay };
}

function getKyivThemeFromSun() {
  const now = new Date();
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const { sunrise, sunset } = getKyivSunTimes();
  return (utcMin >= sunrise && utcMin < sunset) ? 'light' : 'dark';
}

// null = all projects (System Admin)
const ROLES = {
  'roman.merkulov@dynamicalabs.com':    null,
  'dima.shyshov@dynamicalabs.com':      ['NSMG'],
  'kateryna.romanenko@dynamicalabs.com': ['ABS'],
};

const TOKEN_KEY = 'dnl_auth_token';

function getStoredSession() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    // Sessions without a server token predate server-side auth — force re-login.
    if (!session.token || Date.now() > session.expiresAt) {
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

const THEME_KEY = (email) => email ? `dnl_theme_${email}` : 'dnl_theme';

function getInitialThemeMode(email) {
  try {
    const stored = localStorage.getItem(THEME_KEY(email));
    if (stored === 'light' || stored === 'dark' || stored === 'scheduled') return stored;
    // Migrate existing generic key for already-logged-in users
    if (email) {
      const legacy = localStorage.getItem('dnl_theme');
      if (legacy === 'light' || legacy === 'dark' || legacy === 'scheduled') return legacy;
    }
  } catch { /* noop */ }
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

function themeModeToActive(mode) {
  return mode === 'scheduled' ? getKyivThemeFromSun() : mode;
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(() => getStoredSession());
  const [themeMode, setThemeModeState] = useState(() => getInitialThemeMode(session?.email));
  const [theme, setTheme] = useState(() => themeModeToActive(getInitialThemeMode(session?.email)));

  function setThemeMode(mode) {
    setThemeModeState(mode);
    setTheme(themeModeToActive(mode));
    try { localStorage.setItem(THEME_KEY(session?.email), mode); } catch { /* noop */ }
  }

  // When user logs in/out, load their stored preference
  useEffect(() => {
    const mode = getInitialThemeMode(session?.email);
    setThemeModeState(mode);
    setTheme(themeModeToActive(mode));
  }, [session?.email]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Tick every minute when scheduled mode is active
  useEffect(() => {
    if (themeMode !== 'scheduled') return;
    const id = setInterval(() => setTheme(getKyivThemeFromSun()), 60_000);
    return () => clearInterval(id);
  }, [themeMode]);

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

  // The fetch patch (services/http.js) fires this when the server rejects the
  // app token — expired or invalidated. Drop the dead session.
  useEffect(() => {
    const onUnauthorized = () => handleLogout();
    window.addEventListener('dnl:unauthorized', onUnauthorized);
    return () => window.removeEventListener('dnl:unauthorized', onUnauthorized);
  }, []);

  // Returns null on success, 'email' / 'password' error keys, or a free-text
  // error message. Credentials are validated server-side (/api/login), which
  // issues the bearer token the fetch patch attaches to every /api call.
  async function handleLogin(email, password) {
    const normalised = email.trim().toLowerCase();
    let res, data;
    try {
      res = await fetch('/api/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: normalised, password }),
      });
      data = await res.json().catch(() => ({}));
    } catch {
      return 'Could not reach the server. Check your connection and try again.';
    }
    if (!res.ok) return data.code || data.error || 'Sign-in failed. Please try again.';

    const newSession = {
      email:      normalised,
      token:      data.token,
      projects:   ROLES[normalised] ?? null,
      expiresAt:  data.expiresAt || (Date.now() + 24 * 60 * 60 * 1000),
    };
    localStorage.setItem(TOKEN_KEY, JSON.stringify(newSession));
    localStorage.setItem(THEME_KEY(normalised), themeMode);
    setSession(newSession);
    return null;
  }

  function handleLogout() {
    localStorage.removeItem(TOKEN_KEY);
    setSession(null);
  }

  return session
    ? <PlatformShell session={session} onLogout={handleLogout} theme={theme} themeMode={themeMode} setThemeMode={setThemeMode} />
    : <LoginScreen onLogin={handleLogin} theme={theme} themeMode={themeMode} setThemeMode={setThemeMode} />;
}
