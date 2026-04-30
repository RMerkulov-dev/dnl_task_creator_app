import { APP_REGISTRY } from './AppRegistry.js';

function TaskCreatorIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Left document */}
      <rect x="1.5" y="4.5" width="8" height="15" rx="2" stroke="currentColor" strokeWidth="1.35"/>
      <path d="M3.5 8.5h4M3.5 12h4M3.5 15.5h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      {/* Bidirectional sync arrows */}
      <path d="M11 10h2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <path d="M12 8.5L13.5 10L12 11.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M13.5 14H11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <path d="M12.5 12.5L11 14L12.5 15.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
      {/* Right document */}
      <rect x="14.5" y="4.5" width="8" height="15" rx="2" stroke="currentColor" strokeWidth="1.35"/>
      <path d="M16.5 8.5h4M16.5 12h4M16.5 15.5h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );
}

function VoiceIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="9" y="2" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M5 11a7 7 0 0014 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M12 18v3M9 21h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
}

function TaskAgentIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Robot head */}
      <rect x="4" y="8" width="16" height="11" rx="3" stroke="currentColor" strokeWidth="1.5"/>
      {/* Eyes */}
      <circle cx="9.5" cy="13" r="1.5" stroke="currentColor" strokeWidth="1.3"/>
      <circle cx="14.5" cy="13" r="1.5" stroke="currentColor" strokeWidth="1.3"/>
      {/* Mouth */}
      <path d="M9 17h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      {/* Antenna */}
      <path d="M12 8V5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <circle cx="12" cy="4" r="1.2" stroke="currentColor" strokeWidth="1.3"/>
    </svg>
  );
}

function JiraBaIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 4C4 2.9 4.9 2 6 2h12C19.1 2 20 2.9 20 4v10c0 1.1-.9 2-2 2H7.8L4 20V4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <path d="M9 9h6M9 12.5h3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
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
              <span className="sidebar-app-icon">
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
