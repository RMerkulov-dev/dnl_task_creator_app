import { useState, useRef } from 'react';

const LOGO = 'https://dynamicalabs.com/wp-content/uploads/2024/06/dynamica-white.svg';

export default function LoginScreen({ onLogin, theme, themeMode, setThemeMode }) {
  const [email,    setEmail]   = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]   = useState('');
  const [loading,  setLoading] = useState(false);
  const [shake,    setShake]   = useState(false);
  const emailRef = useRef(null);
  const passRef  = useRef(null);

  function triggerShake() {
    setShake(true);
    setTimeout(() => setShake(false), 500);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    setError('');

    await new Promise(r => setTimeout(r, 400));

    const result = onLogin(email, password);
    if (result === 'email') {
      setError('This email is not authorized to access the app.');
      triggerShake();
      emailRef.current?.focus();
    } else if (result === 'password') {
      setError('Incorrect password. Please try again.');
      setPassword('');
      triggerShake();
      passRef.current?.focus();
    }
    setLoading(false);
  }

  return (
    <div className="login-wrap">
      {setThemeMode && (
        <div className="theme-toggle" role="group" aria-label="Theme"
          style={{ position: 'fixed', top: 20, right: 20 }}>
          <button
            type="button"
            className={`theme-toggle-opt ${themeMode === 'light' ? 'active' : ''}`}
            onClick={() => setThemeMode('light')}
            aria-label="Light theme"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8"/>
              <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </button>
          <button
            type="button"
            className={`theme-toggle-opt ${themeMode === 'scheduled' ? 'active' : ''}`}
            onClick={() => setThemeMode('scheduled')}
            aria-label="Scheduled theme (Kyiv time)"
            title="Auto: light after sunrise, dark after sunset (Kyiv)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8"/>
              <path d="M12 7v5l3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button
            type="button"
            className={`theme-toggle-opt ${themeMode === 'dark' ? 'active' : ''}`}
            onClick={() => setThemeMode('dark')}
            aria-label="Dark theme"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      )}
      <div className="login-card">
        <div className="login-logo">
          <img src={LOGO} alt="Dynamica Labs" />
        </div>

        <h1 className="login-title">DNL PM Platform</h1>
        <p className="login-sub">Sign in to continue</p>

        <form onSubmit={handleSubmit}>
          <div className={`field ${shake ? 'shake' : ''}`}>
            <label className="field-label">Email</label>
            <input
              ref={emailRef}
              type="email"
              className="input"
              placeholder="you@dynamicalabs.com"
              value={email}
              onChange={e => { setEmail(e.target.value); setError(''); }}
              autoFocus
              autoComplete="email"
              required
            />
          </div>

          <div className={`field ${shake ? 'shake' : ''}`}>
            <label className="field-label">Password</label>
            <input
              ref={passRef}
              type="password"
              className="input"
              placeholder="Enter password"
              value={password}
              onChange={e => { setPassword(e.target.value); setError(''); }}
              autoComplete="current-password"
              required
            />
          </div>

          {error && <p className="error-msg" style={{ marginBottom: 12 }}>⚠ {error}</p>}

          <button
            type="submit"
            className="btn btn-primary"
            style={{ marginTop: 8 }}
            disabled={loading || !email || !password}
          >
            {loading ? (
              <>
                <span className="spinner" style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,0.25)' }} />
                Signing in…
              </>
            ) : (
              'Sign In →'
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
