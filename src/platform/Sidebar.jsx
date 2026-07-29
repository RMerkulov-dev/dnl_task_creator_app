import { APP_REGISTRY, isAppAllowedForUser } from './AppRegistry.js';
import { useSlidingPill } from './useSlidingPill.js';

// ── App icons ─────────────────────────────────────────────────────────────────
// One SF-Symbols-flavoured set: a single 24-unit grid, generously rounded
// geometry, 1.6 round-capped strokes and solid dots for the few accents. Glyph
// fixes those defaults so every icon reads at the same optical weight — an icon
// only overrides strokeWidth where it deliberately wants a heavier bar.
function Glyph({ children }) {
  return (
    <svg
      width="27" height="27" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}

function TaskCreatorIcon() {
  return (
    <Glyph>
      {/* Document with a plus — "create a task" */}
      <rect x="4" y="2.75" width="16" height="18.5" rx="5" />
      <path d="M12 8.6v6.8M8.6 12h6.8" strokeWidth="1.9" />
    </Glyph>
  );
}

function VoiceIcon() {
  return (
    <Glyph>
      {/* SF `mic` — capsule + pickup arc, no base bar */}
      <rect x="9.25" y="2.6" width="5.5" height="10.8" rx="2.75" />
      <path d="M5.6 11.4a6.4 6.4 0 0012.8 0" />
      <path d="M12 17.9v3.4" />
    </Glyph>
  );
}

function TaskAgentIcon() {
  return (
    <Glyph>
      {/* Agent head: soft capsule, solid eyes, antenna */}
      <rect x="3.5" y="7.6" width="17" height="11.9" rx="5" />
      <circle cx="9" cy="13.6" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13.6" r="1.15" fill="currentColor" stroke="none" />
      <path d="M12 7.6V5.1" />
      <circle cx="12" cy="3.6" r="1.4" />
    </Glyph>
  );
}

function JiraBaIcon() {
  return (
    <Glyph>
      {/* Chat bubble with transcript lines */}
      <path d="M3.6 7.2A3.6 3.6 0 017.2 3.6h9.6a3.6 3.6 0 013.6 3.6v5.6a3.6 3.6 0 01-3.6 3.6H9.4l-4.5 3.7a.8.8 0 01-1.3-.62V7.2z" />
      <path d="M8.4 8.9h7.2M8.4 12.3h4.2" />
    </Glyph>
  );
}

function FathomIcon() {
  return (
    <Glyph>
      {/* SF `video` + a waveform inside — recorded call, transcribed */}
      <rect x="2.6" y="6.2" width="12.6" height="11.6" rx="4" />
      <path d="M15.2 10.6l4.3-2.5a1.1 1.1 0 011.7.95v5.9a1.1 1.1 0 01-1.7.95l-4.3-2.5z" />
      <path d="M6.3 11.3v1.4M8.9 9.9v4.2M11.5 11.3v1.4" strokeWidth="1.5" />
    </Glyph>
  );
}

function EmailAgentIcon() {
  return (
    <Glyph>
      {/* Envelope + sparkle (AI assist) */}
      <rect x="2.75" y="4.9" width="18.5" height="14.2" rx="4.6" />
      <path d="M4 8.2l6.7 4.6a2.3 2.3 0 002.6 0L20 8.2" />
      <path d="M18.3 13.5l.72 1.73 1.73.72-1.73.72-.72 1.73-.72-1.73-1.73-.72 1.73-.72z"
            fill="currentColor" stroke="none" />
    </Glyph>
  );
}

function StatusUpdatesIcon() {
  return (
    <Glyph>
      {/* One frame split in two — Azure beside Jira */}
      <rect x="2.75" y="4" width="18.5" height="16" rx="5" />
      <path d="M12 4.4v15.2" strokeWidth="1.35" />
      <path d="M5.7 9.1h3.4M5.7 12.6h2.2" strokeWidth="1.8" />
      <path d="M14.9 9.1h3.4M14.9 12.6h2.2" strokeWidth="1.8" />
    </Glyph>
  );
}

function PmIcon() {
  return (
    <Glyph>
      {/* Kanban board — three lanes of cards */}
      <rect x="2.75" y="4" width="18.5" height="16" rx="5" />
      <path d="M8.9 4.4v15.2M15.1 4.4v15.2" strokeWidth="1.35" />
      <path d="M5.4 8.7h1.1M11.6 8.7h1.1M17.8 8.7h1.1" strokeWidth="2.1" />
      <path d="M5.4 12.2h1.1M11.6 12.2h1.1" strokeWidth="2.1" />
    </Glyph>
  );
}

function ReportIcon() {
  return (
    <Glyph>
      {/* SF `chart.bar` — free-standing rounded bars, no frame */}
      <path d="M4.2 20.2V9.4M9.4 20.2V4.4M14.6 20.2V12.6M19.8 20.2V7.2" strokeWidth="2.3" />
    </Glyph>
  );
}

function GanttIcon() {
  return (
    <Glyph>
      {/* Staggered timeline bars — a dashed "today" line here read as sliders */}
      <path d="M4.4 6.4h7.2M8.6 12h8.2M12 17.6h6.8" strokeWidth="2.8" />
    </Glyph>
  );
}

function QuarterlyCallsIcon() {
  return (
    <Glyph>
      {/* Calendar with a marked day */}
      <rect x="2.9" y="4.6" width="18.2" height="16.5" rx="5" />
      <path d="M3.3 9.6h17.4" strokeWidth="1.45" />
      <path d="M8 2.7v3.6M16 2.7v3.6" />
      <circle cx="12" cy="15.3" r="1.7" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

function ChecklistIcon() {
  return (
    <Glyph>
      {/* SF `checklist` — ticks beside their rows, no clipboard */}
      <path d="M3.2 7.1l1.9 1.9 3.4-3.6" />
      <path d="M11.6 7.4h9.2" strokeWidth="1.9" />
      <path d="M3.2 16.7l1.9 1.9 3.4-3.6" />
      <path d="M11.6 17h9.2" strokeWidth="1.9" />
    </Glyph>
  );
}

const ICON_MAP = {
  'pm':            PmIcon,
  'task-creator':  TaskCreatorIcon,
  'voice':         VoiceIcon,
  'task-agent':    TaskAgentIcon,
  'jira-ba-agent': JiraBaIcon,
  'fathom-agent':  FathomIcon,
  'email-agent':   EmailAgentIcon,
  'status-updates': StatusUpdatesIcon,
  'report':        ReportIcon,
  'gantt':         GanttIcon,
  'quarterly-calls': QuarterlyCallsIcon,
  'checklist':     ChecklistIcon,
};

function PlatformLogo() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="32" height="32" rx="10" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M7 17L11 13L15 17L19.5 11.5L25 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M16 17l5-5-5-5M21 12H9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function ComingSoonIcon() {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="8.5" strokeDasharray="3.4 2.9" />
      <path d="M12 8.6v6.8M8.6 12h6.8" strokeWidth="1.7" />
    </Glyph>
  );
}

function getInitials(email) {
  const name = email?.split('@')[0] ?? '';
  const parts = name.split('.');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M12 7v5l3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export default function Sidebar({ activeId, onSelect, user, onLogout, themeMode, setThemeMode }) {
  const initials = getInitials(user);
  const apps = APP_REGISTRY.filter(app => isAppAllowedForUser(app, user));

  // One glass pill slides vertically to the selected app instead of the active
  // background jumping between rows; same for the theme toggle's thumb.
  const nav   = useSlidingPill(activeId);
  const theme = useSlidingPill(themeMode);

  return (
    <aside className="platform-sidebar glass-rail">
      <span className="glass-refract" aria-hidden="true" />
      <nav className="sidebar-nav" ref={nav.trackRef}>
        <span
          className={`sidebar-nav-pill${nav.ready ? ' ready' : ''}`}
          aria-hidden="true"
          style={{ transform: `translateY(${nav.box.top}px)`, height: nav.box.height }}
        >
          <span key={nav.seq} className={`glass-pill-fill${nav.seq > 0 ? ' gel-y' : ''}`} />
          <span className="sidebar-active-bar" />
        </span>
        {apps.map(app => {
          const IconComp = ICON_MAP[app.id];
          const isActive = app.id === activeId;
          return (
            <button
              key={app.id}
              ref={nav.setItemRef(app.id)}
              className={`sidebar-app-btn${isActive ? ' active' : ''}`}
              onClick={() => onSelect(app.id)}
              title={app.name}
            >
              <span className="sidebar-app-icon">
                {IconComp && <IconComp />}
                {app.beta && <span className="sidebar-beta-badge">Beta</span>}
              </span>
              <span className="sidebar-app-label">{app.shortName}</span>
            </button>
          );
        })}

        <div className="sidebar-app-btn coming-soon" title="More apps coming soon">
          <span className="sidebar-app-icon coming-soon-icon">
            <ComingSoonIcon />
          </span>
          <span className="sidebar-app-label">Soon</span>
        </div>
      </nav>

      <div style={{ flex: 1 }} />

      {setThemeMode && (
        <div
          className="theme-toggle theme-toggle-vertical glass-panel"
          role="group"
          aria-label="Theme"
          ref={theme.trackRef}
        >
          <span
            className={`theme-toggle-thumb${theme.ready ? ' ready' : ''}`}
            aria-hidden="true"
            style={{ transform: `translateY(${theme.box.top}px)`, height: theme.box.height }}
          >
            <span key={theme.seq} className={`glass-pill-fill accent${theme.seq > 0 ? ' gel-y' : ''}`} />
          </span>
          <button
            type="button"
            ref={theme.setItemRef('light')}
            className={`theme-toggle-opt ${themeMode === 'light' ? 'active' : ''}`}
            onClick={() => setThemeMode('light')}
            aria-label="Light theme"
            title="Light theme"
          >
            <SunIcon />
          </button>
          <button
            type="button"
            ref={theme.setItemRef('scheduled')}
            className={`theme-toggle-opt ${themeMode === 'scheduled' ? 'active' : ''}`}
            onClick={() => setThemeMode('scheduled')}
            aria-label="Scheduled theme (Kyiv time)"
            title="Auto: light after sunrise, dark after sunset (Kyiv)"
          >
            <ClockIcon />
          </button>
          <button
            type="button"
            ref={theme.setItemRef('dark')}
            className={`theme-toggle-opt ${themeMode === 'dark' ? 'active' : ''}`}
            onClick={() => setThemeMode('dark')}
            aria-label="Dark theme"
            title="Dark theme"
          >
            <MoonIcon />
          </button>
        </div>
      )}

      <div className="sidebar-user">
        <div className="sidebar-user-avatar" title={user}>{initials}</div>
        <button className="sidebar-logout-btn" onClick={onLogout} title="Sign out">
          <LogoutIcon />
        </button>
      </div>
    </aside>
  );
}
