// Errors that happen only in the page never reach the server by themselves: this sends the ones the
// page catches (uncaught errors, rejected promises, and those the page reports) to the server's
// log (POST /api/client-error), with where they happened and which version of the page it was.

let version = null;
fetch('/healthz').then((r) => r.json()).then((h) => { version = h.version; }).catch(() => {});

// details: what helps to see why (sizes, the device), as an object.
export function reportError(error, where = '', details = null) {
  const body = {
    message: String(error?.message ?? error).slice(0, 600),
    stack: String(error?.stack ?? '').slice(0, 2400),
    where, page: location.pathname, version: version ?? 'unknown',
    details, agent: navigator.userAgent,
  };
  fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .catch(() => {});
}

window.addEventListener('error', (e) => reportError(e.error ?? e.message, 'uncaught'));
window.addEventListener('unhandledrejection', (e) => reportError(e.reason, 'promise'));
