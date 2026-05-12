import { useState, useRef, useEffect } from 'react';

function getBestMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

function MicIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <rect x="9" y="2" width="6" height="11" rx="3" fill="currentColor"/>
      <path d="M5 11a7 7 0 0014 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      <path d="M12 18v4M9 22h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
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

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  );
}

export default function VoiceFab() {
  const [open,         setOpen]         = useState(false);
  const [recording,    setRecording]    = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript,   setTranscript]   = useState('');
  const [error,        setError]        = useState('');
  const [copied,       setCopied]       = useState(false);

  const mrRef     = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);

  function reset() {
    setRecording(false);
    setTranscribing(false);
    setTranscript('');
    setError('');
    setCopied(false);
  }

  function closePopover() {
    if (recording) stopRecording();
    setOpen(false);
    reset();
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') closePopover(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, recording]); // eslint-disable-line

  async function startRecording() {
    setError('');
    setTranscript('');
    setCopied(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
      });
      streamRef.current = stream;

      const mimeType = getBestMimeType();
      const mr = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 128_000 } : {});
      chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const type = mr.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        await sendToWhisper(blob, type);
      };
      mrRef.current = mr;
      mr.start();
      setRecording(true);
    } catch {
      setError('Нет доступа к микрофону.');
    }
  }

  function stopRecording() {
    if (mrRef.current?.state === 'recording') mrRef.current.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
    setRecording(false);
    setTranscribing(true);
  }

  async function sendToWhisper(blob, mimeType) {
    try {
      const res  = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': mimeType }, body: blob });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка расшифровки');
      const text = (data.text || '').trim();
      if (text) setTranscript(text);
      else      setError('Не удалось распознать речь.');
    } catch (e) {
      setError(e.message);
    } finally {
      setTranscribing(false);
    }
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* noop */ }
  }

  return (
    <>
      <button
        className={`voice-fab${open ? ' voice-fab-open' : ''}`}
        onClick={() => (open ? closePopover() : setOpen(true))}
        title={open ? 'Закрыть' : 'Голосовой ввод'}
        aria-label="Voice input"
      >
        {open ? <CloseIcon /> : <MicIcon />}
      </button>

      {open && (
        <div className="voice-fab-popover" role="dialog" aria-label="Voice input">
          <div className="voice-fab-popover-header">
            <span className="voice-fab-popover-title">Voice</span>
            <button className="voice-fab-popover-close" onClick={closePopover} title="Закрыть">
              <CloseIcon />
            </button>
          </div>

          <div className="voice-fab-popover-body">
            {error && <p className="voice-fab-error">⚠ {error}</p>}

            {!transcript && !error && (
              <div className="voice-fab-status">
                {recording    && <p>Запись… нажмите stop, чтобы расшифровать.</p>}
                {transcribing && <p>Расшифровываю…</p>}
                {!recording && !transcribing && <p>Нажмите микрофон и начните говорить.</p>}
              </div>
            )}

            {transcript && (
              <div className="voice-fab-result">
                <p className="voice-fab-result-text">{transcript}</p>
                <button className="voice-fab-copy" onClick={copyText} title="Скопировать">
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  <span>{copied ? 'Скопировано' : 'Копировать'}</span>
                </button>
              </div>
            )}

            <div className="voice-fab-actions">
              <button
                className={`ba-mic-btn voice-fab-mic${recording ? ' ba-mic-btn-stop' : ''}${transcribing ? ' ba-mic-btn-busy' : ''}`}
                onClick={recording ? stopRecording : startRecording}
                disabled={transcribing}
              >
                {transcribing
                  ? <span className="spinner" style={{ width: 16, height: 16 }} />
                  : recording ? <StopIcon /> : <MicIcon />}
              </button>
              {transcript && !recording && !transcribing && (
                <button className="btn btn-ghost" onClick={() => { setTranscript(''); setCopied(false); }}>
                  Заново
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
