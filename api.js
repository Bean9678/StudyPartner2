// src/api.js
const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3000').replace(/\/$/, '');

export async function fetchApi(endpoint, options = {}) {
  const url = `${API_URL}${endpoint}`;

  // Production safeguard: mixed-content check
  if (url.startsWith('http://') && window.location.protocol === 'https:') {
    console.error(
      '[API] Mixed Content Warning: HTTP fetch from HTTPS origin blocked by browser. ' +
      'Set VITE_API_URL to https:// in your .env.'
    );
  }

  const defaultHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  // Credentials: 'omit' — we use Firebase UIDs for identity, not cookies.
  // 'include' forces a CORS preflight that Railway's dynamic-origin response
  // often fails, causing a silent "Failed to fetch" in the browser.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...defaultHeaders,
        ...options.headers,
      },
      credentials: 'omit',
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      const msg = errorBody.message || `API Error: ${response.status} ${response.statusText}`;
      console.error(`[API] ${options.method || 'GET'} ${endpoint} →`, response.status, msg);
      throw new Error(msg);
    }

    return response.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[API] ${endpoint} timed out after 15s`);
      throw new Error('Request timed out. The server may be starting up — please try again.');
    }
    // "Failed to fetch" = network-level block (CORS preflight, server down, no internet)
    const isNetworkError = err.message === 'Failed to fetch' || err.message === 'NetworkError when attempting to fetch resource.';
    console.error(`[API] ${options.method || 'GET'} ${url} failed:`, err.message);
    if (isNetworkError) {
      throw new Error('Cannot reach the server. Check your connection or try again in a moment.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Convenience wrappers ─────────────────────────────────────────────────────

export const api = {
  /** POST /api/start-search */
  startSearch: (uid, { grade, subjects, gender } = {}) =>
    fetchApi('/api/start-search', {
      method: 'POST',
      body: JSON.stringify({ uid, grade, subjects, gender }),
    }),

  /** POST /api/cancel-search */
  cancelSearch: (uid) =>
    fetchApi('/api/cancel-search', {
      method: 'POST',
      body: JSON.stringify({ uid }),
    }),

  /** GET /api/check-match?uid=... */
  checkMatch: (uid) =>
    fetchApi(`/api/check-match?uid=${encodeURIComponent(uid)}`),

  /** POST /api/match-delivered */
  matchDelivered: (uid, roomId) =>
    fetchApi('/api/match-delivered', {
      method: 'POST',
      body: JSON.stringify({ uid, roomId }),
    }),

  /** GET /api/messages/:roomId */
  getMessages: (roomId) =>
    fetchApi(`/api/messages/${encodeURIComponent(roomId)}`),

  /** GET /api/health */
  health: () => fetchApi('/api/health'),
};
