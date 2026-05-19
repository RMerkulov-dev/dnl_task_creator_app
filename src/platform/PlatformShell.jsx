import { useState, Suspense } from 'react';
import Sidebar from './Sidebar.jsx';
import { APP_REGISTRY, APP_COMPONENTS, isAppAllowedForUser } from './AppRegistry.js';
import VoiceFab from '../components/VoiceFab.jsx';

function AppLoader() {
  return (
    <div className="platform-app-loader">
      <div className="spinner spinner-lg" />
    </div>
  );
}

export default function PlatformShell({ session, onLogout, theme, themeMode, setThemeMode }) {
  const allowedApps = APP_REGISTRY.filter(app => isAppAllowedForUser(app, session.email));
  const defaultAppId = allowedApps[0]?.id ?? APP_REGISTRY[0].id;
  const [activeId, setActiveId] = useState(defaultAppId);

  // Guard against stale activeId (e.g. logged-in user without rights to the
  // last-selected app) by falling back to the first app they CAN see.
  const activeApp = APP_REGISTRY.find(a => a.id === activeId);
  const effectiveId = activeApp && isAppAllowedForUser(activeApp, session.email)
    ? activeId
    : defaultAppId;

  const AppComponent = APP_COMPONENTS[effectiveId];

  return (
    <div className="platform-shell">
      <Sidebar
        activeId={activeId}
        onSelect={setActiveId}
        user={session.email}
        onLogout={onLogout}
      />
      <div className="platform-content">
        <Suspense fallback={<AppLoader />}>
          {AppComponent && (
            <AppComponent
              user={session.email}
              allowedProjects={session.projects}
              expiresAt={session.expiresAt}
              onLogout={onLogout}
              theme={theme}
              themeMode={themeMode}
              setThemeMode={setThemeMode}
            />
          )}
        </Suspense>
      </div>
      <VoiceFab />
    </div>
  );
}
