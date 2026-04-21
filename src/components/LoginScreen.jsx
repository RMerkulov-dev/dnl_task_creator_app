import { useState, useRef } from 'react';

const LOGO = 'https://dynamicalabs.com/wp-content/uploads/2024/06/dynamica-white.svg';

export default function LoginScreen({ onLogin }) {
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
