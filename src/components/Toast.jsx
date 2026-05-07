import { useEffect, useState } from 'react';

const DURATION = 5000;

function Toast({ toast, onDismiss }) {
  const [visible, setVisible] = useState(true);

  function close() {
    setVisible(false);
    setTimeout(() => onDismiss(toast.id), 300);
  }

  useEffect(() => {
    const t = setTimeout(close, DURATION);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className={`toast ${visible ? '' : 'toast-out'}`}>
      <span className="toast-check">✓</span>
      <div className="toast-body">
        <p className="toast-title">Task synced</p>
        <div className="toast-links">
          {toast.epicUrl && (
            <a href={toast.epicUrl} target="_blank" rel="noreferrer" className="toast-link">
              Azure #{toast.epicId} ↗
            </a>
          )}
          {toast.jiraUrl && (
            <a href={toast.jiraUrl} target="_blank" rel="noreferrer" className="toast-link">
              {toast.jiraKey} ↗
            </a>
          )}
        </div>
      </div>
      <button className="toast-close" onClick={close} aria-label="Dismiss">×</button>
      <div className="toast-progress" />
    </div>
  );
}

export default function ToastContainer({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
