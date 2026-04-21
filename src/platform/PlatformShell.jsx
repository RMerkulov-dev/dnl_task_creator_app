import { useState, Suspense } from 'react';
import Sidebar from './Sidebar.jsx';
import { APP_REGISTRY, APP_COMPONENTS } from './AppRegistry.js';

function AppLoader() {
  return (
    <div className="platform-app-loader">
      <div className="spinner spinner-lg" />
    </div>
  );
}

export default function PlatformShell({ session, onLogout }) {
  const [activeId, setActiveId] = useState(APP_REGISTRY[0].id);

  const AppComponent = APP_COMPONENTS[activeId];

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
            />
          )}
        </Suspense>
      </div>
    </div>
  );
}
