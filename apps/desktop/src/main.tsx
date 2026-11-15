import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { watchHubToken } from './transport';
// styles.css already pulls in chunks-ui/theme.css; importing it again here would override the hub's tokens.
import './styles.css';
import 'highlight.js/styles/github-dark.css';

// The dev server has no hub: answer every command in-browser from the fixtures (transport.ts).
if (import.meta.env.DEV && window.__TASKCELL_HUB__ !== true) window.__TASKCELL_MOCK__ = true;

// Strip the launch URL's `#token=…` before anything renders (or the user bookmarks the page).
watchHubToken();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
