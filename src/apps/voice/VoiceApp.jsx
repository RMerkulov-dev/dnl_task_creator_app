import { useState, useRef, useEffect } from 'react';

const LOGO = 'https://dynamicalabs.com/wp-content/uploads/2024/06/dynamica-white.svg';

const LANGS = [
  { value: '', label: 'Auto detect' },
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Русский' },
  { value: 'uk', label: 'Українська' },
  { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
];

function MicIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
      <rect x="9" y="2" width="6" height="11" rx="3" fill="currentColor"/>
      <path d="M5 11a7 7 0 0014 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      <path d="M12 18v4M9 22h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
      <rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor"/>
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function formatTime() {
  return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Equalizer canvas ──────────────────────────────────────────────────────────
function Equalizer({ analyserRef, active }) {
  const canvasRef = useRef(null);
  const rafRef    = useRef(null);

  useEffect(() => {
    if (!active) {
      cancelAnimationFrame(rafRef.current);
      // Fade out — clear canvas
      const canvas = canvasRef.current;
      if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    function draw() {
      rafRef.current = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const analyser = analyserRef.current;
      if (!canvas || !analyser) return;

      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;

      if (canvas.width !== Math.round(cssW * dpr)) {
        canvas.width  = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }

      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const W = cssW;
      const H = cssH;

      ctx.clearRect(0, 0, W, H);

      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);

      const BAR_COUNT = 52;
      const GAP       = 2.5;
      const barW      = (W - GAP * (BAR_COUNT - 1)) / BAR_COUNT;
      // Focus on voice-relevant range (roughly first 60% of bins)
      const binRange  = Math.floor(analyser.frequencyBinCount * 0.6);

      for (let i = 0; i < BAR_COUNT; i++) {
        const binIndex = Math.round((i / BAR_COUNT) * binRange);
        const raw      = data[binIndex] / 255;
        const barH     = Math.max(3, raw * H * 0.92);
        const x        = i * (barW + GAP);
        const y        = H - barH;

        // Per-bar gradient: cyan top → blue bottom
        const alpha = 0.55 + raw * 0.45;
        const grad  = ctx.createLinearGradient(0, y, 0, H);
        grad.addColorStop(0, `rgba(6, 182, 212, ${alpha})`);
        grad.addColorStop(1, `rgba(59, 130, 246, ${alpha * 0.5})`);
        ctx.fillStyle = grad;

        const r = Math.min(barW / 2, 3);
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(x, y, barW, barH, r);
        } else {
          ctx.rect(x, y, barW, barH);
        }
        ctx.fill();
      }
    }

    draw();
    return () => cancelAnimationFrame(rafRef.current);
  }, [active, analyserRef]);

  return (
    <canvas
      ref={canvasRef}
      className={`voice-equalizer${active ? ' voice-equalizer-active' : ''}`}
    />
  );
}

// ── Main component ────────────────────────────────────────────────────────────
// Pick the best supported MIME type for Whisper (prefer opus → fallback webm)
function getBestMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

export default function VoiceApp() {
  const [recording,    setRecording]    = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript,   setTranscript]   = useState('');
  const [error,        setError]        = useState('');
  const [copied,       setCopied]       = useState(null);
  const [lang,         setLang]         = useState('');
  const [context,      setContext]      = useState('');
  const [history,      setHistory]      = useState([]);

  const mrRef       = useRef(null);
  const chunksRef   = useRef([]);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);

  function startVisualizer(stream) {
    const audioCtx = new AudioContext();
    const analyser  = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.82;

    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);

    audioCtxRef.current = audioCtx;
    analyserRef.current = analyser;
  }

  function stopVisualizer() {
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    analyserRef.current = null;
  }

  async function startRecording() {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
      });

      startVisualizer(stream);

      const mimeType = getBestMimeType();
      const options  = { audioBitsPerSecond: 128_000 };
      if (mimeType) options.mimeType = mimeType;

      const mr = new MediaRecorder(stream, options);
      chunksRef.current = [];

      // No timeslice — ondataavailable fires once on stop with the full recording
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };

      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const type = mr.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        await sendToWhisper(blob, type);
      };

      mrRef.current = mr;
      mr.start(); // full recording, no chunking
      setRecording(true);
    } catch {
      setError('Нет доступа к микрофону. Разрешите доступ в настройках браузера.');
    }
  }

  function stopRecording() {
    if (mrRef.current?.state === 'recording') mrRef.current.stop();
    stopVisualizer();
    setRecording(false);
    setTranscribing(true);
  }

  async function sendToWhisper(blob, mimeType) {
    try {
      const params = new URLSearchParams();
      if (lang)    params.set('language', lang);
      if (context) params.set('prompt', context);
      const qs  = params.toString() ? `?${params}` : '';
      const res = await fetch(`/api/transcribe${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': mimeType },
        body: blob,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка расшифровки');
      const text = (data.text || '').trim();
      if (text) {
        const entry = { id: Date.now(), text, time: formatTime() };
        setTranscript(text);
        setHistory(h => [entry, ...h.slice(0, 19)]);
      } else {
        setError('Не удалось распознать речь. Попробуйте ещё раз.');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setTranscribing(false);
    }
  }

  function copyText(id, text) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  const latestId = history[0]?.id ?? null;

  return (
    <div className="app-shell">
      <header className="header">
        <div className="header-logo"><img src={LOGO} alt="Dynamica Labs" /></div>
        <div className="header-sep" />
        <span className="header-title">Voice Transcription</span>
        <div className="header-spacer" />
        <select
          className="select voice-lang-select"
          value={lang}
          onChange={e => setLang(e.target.value)}
          disabled={recording || transcribing}
        >
          {LANGS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
      </header>

      <main className="main">
        <div className="voice-wrap">

          {/* Context hint */}
          <div className="voice-context-wrap">
            <label className="voice-context-label">Контекст (имена, проект, термины)</label>
            <input
              className="input voice-context-input"
              type="text"
              placeholder="например: Роман, Dynamica, NSMG Sprint 12..."
              value={context}
              onChange={e => setContext(e.target.value)}
              disabled={recording || transcribing}
            />
          </div>

          {/* Record area */}
          <div className="voice-record-area">
            <div className={`voice-btn-wrap${recording ? ' voice-recording' : ''}`}>
              {recording && <span className="voice-ring voice-ring-1" />}
              {recording && <span className="voice-ring voice-ring-2" />}
              <button
                className={`voice-btn${recording ? ' voice-btn-stop' : ''}${transcribing ? ' voice-btn-busy' : ''}`}
                onClick={recording ? stopRecording : startRecording}
                disabled={transcribing}
                aria-label={recording ? 'Остановить запись' : 'Начать запись'}
              >
                {transcribing
                  ? <span className="spinner spinner-lg" style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,0.2)' }} />
                  : recording ? <StopIcon /> : <MicIcon />
                }
              </button>
            </div>

            {/* Equalizer */}
            <Equalizer analyserRef={analyserRef} active={recording} />

            <p className="voice-status-text">
              {transcribing
                ? 'Расшифровка...'
                : recording
                  ? 'Запись... нажмите чтобы остановить'
                  : 'Нажмите чтобы начать запись'}
            </p>

            {error && (
              <p className="error-msg" style={{ marginTop: 12, justifyContent: 'center' }}>⚠ {error}</p>
            )}
          </div>

          {/* Latest transcript */}
          {transcript && !transcribing && (
            <div className="voice-card">
              <div className="voice-card-header">
                <span className="voice-card-label">Результат</span>
                <button
                  className={`voice-copy-btn${copied === latestId ? ' copied' : ''}`}
                  onClick={() => copyText(latestId, transcript)}
                >
                  {copied === latestId ? <><CheckIcon /> Скопировано</> : <><CopyIcon /> Копировать</>}
                </button>
              </div>
              <p className="voice-card-text">{transcript}</p>
            </div>
          )}

          {/* History */}
          {history.length > 1 && (
            <div className="voice-history">
              <h3 className="voice-history-title">История сессии</h3>
              <div className="voice-history-list">
                {history.slice(1).map(item => (
                  <div key={item.id} className="voice-history-item">
                    <div className="voice-history-meta">
                      <span className="voice-history-time">{item.time}</span>
                      <button
                        className={`voice-copy-btn voice-copy-btn-sm${copied === item.id ? ' copied' : ''}`}
                        onClick={() => copyText(item.id, item.text)}
                      >
                        {copied === item.id ? <><CheckIcon /> Скопировано</> : <><CopyIcon /> Копировать</>}
                      </button>
                    </div>
                    <p className="voice-history-text">{item.text}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
