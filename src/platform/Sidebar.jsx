import { APP_REGISTRY } from './AppRegistry.js';

function TaskCreatorIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="2" width="8" height="3" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M8 3.5H5C3.895 3.5 3 4.395 3 5.5v15C3 21.605 3.895 22.5 5 22.5h14c1.105 0 2-.895 2-2v-15c0-1.105-.895-2-2-2h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M8.5 13.5l2 2 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M8.5 18h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
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
      <path d="M3 14h7.5a3.5 3.5 0 003.5-3.5V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M3 14v3.5A3.5 3.5 0 006.5 21H8v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M9 7h7.5A3.5 3.5 0 0120 3.5V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M9 7v3.5A3.5 3.5 0 0012.5 14H14v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <circle cx="20" cy="3" r="1.5" stroke="currentColor" strokeWidth="1.3"/>
      <circle cx="8" cy="22" r="1.5" stroke="currentColor" strokeWidth="1.3"/>
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
