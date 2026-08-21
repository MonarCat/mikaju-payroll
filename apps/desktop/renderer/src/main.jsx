import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { AuthProvider } from './lib/AuthContext';
import App from './App';
import './index.css';

// HashRouter, not BrowserRouter: the app is loaded from a file:// URL in
// production (see main.js loadFile), and history-API routing breaks under
// file://. Hash routing works identically in dev and packaged builds.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HashRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </HashRouter>
  </StrictMode>
);
