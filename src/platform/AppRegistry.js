import { lazy } from 'react';

export const APP_REGISTRY = [
  {
    id: 'task-creator',
    name: 'Task Creator',
    shortName: 'Tasks',
    gradient: 'linear-gradient(135deg, #5b63fe 0%, #8b5cf6 100%)',
    glow: 'rgba(91, 99, 254, 0.5)',
  },
  {
    id: 'voice',
    name: 'Voice',
    shortName: 'Voice',
    gradient: 'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)',
    glow: 'rgba(6, 182, 212, 0.5)',
  },
];

// Lazy-load app components separately so AppRegistry stays JSON-serialisable
export const APP_COMPONENTS = {
  'task-creator': lazy(() => import('../components/Dashboard.jsx')),
  'voice':        lazy(() => import('../apps/voice/VoiceApp.jsx')),
};
