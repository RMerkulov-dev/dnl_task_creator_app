import { APP_REGISTRY } from './AppRegistry.js';

function TaskCreatorIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="2" width="8" height="3" rx="1.5" fill="white" fillOpacity="0.65"/>
      <path d="M8 3.5H5C3.89543 3.5 3 4.39543 3 5.5V20.5C3 21.6046 3.89543 22.5 5 22.5H19C20.1046 22.5 21 21.6046 21 20.5V5.5C21 4.39543 20.1046 3.5 19 3.5H16" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M8.5 13.5L10.5 15.5L15.5 10.5" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M8.5 18H15.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeOpacity="0.45"/>
    </svg>
  );
}

function VoiceIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="9" y="2" width="6" height="11" rx="3" fill="white" fillOpacity="0.9"/>
      <path d="M5 11a7 7 0 0014 0" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M12 18v3M9 21h6" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  );
}

function TaskAgentIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24.817 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path fill="white" d="M11.571 11.513H0a5.218 5.218 0 0 0 5.218 5.218h2.098v2.191A5.218 5.218 0 0 0 12.532 24V12.481a.968.968 0 0 0-.961-.968z"/>
      <path fill="white" fillOpacity="0.7" d="M17.713 5.441H6.142a5.218 5.218 0 0 0 5.218 5.218h2.099v2.19a5.218 5.218 0 0 0 5.215 5.215V6.41a.968.968 0 0 0-.961-.969z"/>
      <path fill="white" fillOpacity="0.45" d="M23.855 0H12.284a5.218 5.218 0 0 0 5.218 5.218h2.098v2.19A5.218 5.218 0 0 0 24.817 12.6V.968A.968.968 0 0 0 23.855 0z"/>
    </svg>
  );
}

function JiraBaIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 4C4 2.9 4.9 2 6 2H18C19.1 2 20 2.9 20 4V14C20 15.1 19.1 16 18 16H7.8L4 20V4Z" fill="white" fillOpacity="0.85"/>
      <path d="M9 8.5L10.5 6L12 8.5L15 7L13 10L16 11.5L12.5 11L13 14L10.5 11.5L7.5 13L9 8.5Z" fill="#7c3aed"/>
    </svg>
  );
}

const ICON_MAP = {
  'task-creator':  TaskCreatorIcon,
  'voice':         VoiceIcon,
  'task-agent':    TaskAgentIcon,
  'jira-ba-agent': JiraBaIcon,
};

function PlatformLogo() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="32" height="32" rx="10" fill="url(#pl-grad)"/>
      <path d="M7 17L11 13L15 17L19.5 11.5L25 17" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
      <defs>
        <linearGradient id="pl-grad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#5b63fe"/>
          <stop offset="100%" stopColor="#8b5cf6"/>
        </linearGradient>
      </defs>
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
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.4" strokeDasharray="3.5 2.5"/>
      <path d="M12 8v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
      <circle cx="12" cy="16.5" r="0.8" fill="currentColor"/>
    </svg>
  );
}

function getInitials(email) {
  const name = email?.split('@')[0] ?? '';
  const parts = name.split('.');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export default function Sidebar({ activeId, onSelect, user, onLogout }) {
  const initials = getInitials(user);

  return (
    <aside className="platform-sidebar">
      <div className="sidebar-logo">
        <PlatformLogo />
      </div>

      <div className="sidebar-sep" />

      <nav className="sidebar-nav">
        {APP_REGISTRY.map(app => {
          const IconComp = ICON_MAP[app.id];
          const isActive = app.id === activeId;
          return (
            <button
              key={app.id}
              className={`sidebar-app-btn${isActive ? ' active' : ''}`}
              onClick={() => onSelect(app.id)}
              title={app.name}
            >
              {isActive && <span className="sidebar-active-bar" />}
              <span
                className="sidebar-app-icon"
                style={{
                  background: app.gradient,
                  boxShadow: isActive ? `0 4px 18px ${app.glow}` : 'none',
                }}
              >
                {IconComp && <IconComp />}
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

      <div className="sidebar-user">
        <div className="sidebar-user-avatar" title={user}>{initials}</div>
        <button className="sidebar-logout-btn" onClick={onLogout} title="Sign out">
          <LogoutIcon />
        </button>
      </div>
    </aside>
  );
}
