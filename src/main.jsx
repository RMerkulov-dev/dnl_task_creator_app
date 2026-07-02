import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './services/http.js'; // patches fetch to send the auth token on /api calls
import './index.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
