import { startApp } from './app.js';

const app = startApp();
// The service worker only exists on https and localhost. Offline use is a bonus, not a requirement.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
window.apex = app;
