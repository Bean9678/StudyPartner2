console.log("ALL ENV:", process.env);

/**
 * server.js — Main entry point
 *
 * Tinder-style real-time chat backend
 * Stack: Node.js + Express + Socket.io
 *
 * Run: node server.js
 * Env vars: PORT (default 3000), CLIENT_ORIGIN (default *)
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const matchRoutes = require('./matchRoutes');
const { attachHandlers } = require('./socketHandlers');
const { startWorker } = require('./queueWorker');
const { startCleanup } = require('./cleanupWorker');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// Whitelist all allowed origins. Set CLIENT_URL in Railway env vars.
const ALLOWED_ORIGINS = [
  // studypartner-d6205 (active Firebase project)
  'https://studypartner-d6205.web.app',
  'https://studypartner-d6205.firebaseapp.com',
  // studypartner2-14105 (legacy / alternate)
  'https://studypartner2-14105.web.app',
  'https://studypartner2-14105.firebaseapp.com',
  process.env.CLIENT_URL,
].filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true; // Allow non-browser requests (e.g., curl health checks)
  return ALLOWED_ORIGINS.includes(origin);
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();

// Trust first proxy (required for Railway/Render to resolve correct IP + protocol)
app.set('trust proxy', 1);

const corsOptions = {
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked origin: ${origin}`);
      callback(new Error(`CORS policy: Origin ${origin} is not allowed.`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  // credentials: true is REQUIRED when frontend uses withCredentials: true
  // for cross-domain requests.
  credentials: true,
};

// Explicitly handle OPTIONS preflights FIRST so they never hit auth/routes
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Input validation middleware ──────────────────────────────────────────────
app.use((req, _res, next) => {
  // Sanitise query strings and params — strip prototype-pollution keys
  const dangerous = ['__proto__', 'constructor', 'prototype'];
  const clean = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of dangerous) delete obj[key];
  };
  clean(req.query);
  clean(req.params);
  clean(req.body);
  next();
});

// ─── Static files (optional) ──────────────────────────────────────────────────
// Serve the frontend if deployed on same server (Firebase hosting skips this)
app.use(express.static('public'));

// ─── REST API routes ──────────────────────────────────────────────────────────
app.use('/api', matchRoutes);

// 404 fallback for unmatched API routes
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── HTTP + Socket.io ─────────────────────────────────────────────────────────
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Socket.io CORS: Origin ${origin} not allowed.`));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // Force WebSocket transport immediately — avoids polling CORS pre-flight on Firebase
  transports: ['websocket', 'polling'],
  // Increase max payload for file chunks
  maxHttpBufferSize: 10 * 1024 * 1024, // 10 MB
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─── Socket handlers ──────────────────────────────────────────────────────────
attachHandlers(io);

// ─── Queue Worker & Scavenger ─────────────────────────────────────────────────
startWorker();
startCleanup();

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`   Allowed Origins: ${ALLOWED_ORIGINS.join(', ')}\n`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[SIGTERM] Shutting down gracefully...');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('[SIGINT] Shutting down...');
  server.close(() => process.exit(0));
});
