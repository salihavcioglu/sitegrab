// SiteGrab — (c) 2026 Salih Avcioglu. MIT License.
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startJob, ZIP_DIR, cleanupOldZips } from '../core/job.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const PORT = Number(process.env.PORT) || 3000;
const MAX_JOBS_PER_HOUR = Number(process.env.MAX_JOBS_PER_HOUR) || 10;
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS) || 3;
const ZIP_TTL_MINUTES = Number(process.env.ZIP_TTL_MINUTES) || 30;
const TRUST_PROXY = process.env.TRUST_PROXY;

const app = express();

if (TRUST_PROXY) {
  // Accept "1", "true", a number of hops, or a specific value (e.g. "loopback").
  const val = TRUST_PROXY === 'true' ? true : (Number.isNaN(Number(TRUST_PROXY)) ? TRUST_PROXY : Number(TRUST_PROXY));
  app.set('trust proxy', val);
}

// --- Security headers (set by hand, no helmet dependency) ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=(), payment=(), usb=()'
  );
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  next();
});

app.use(express.static(PUBLIC_DIR));
app.use(express.json());

// --- In-memory job metadata: jobId -> { hostname, socketId } ---
const jobMeta = new Map();

// --- In-memory rate limiting: ip -> array of start timestamps (ms) ---
const rateLimitMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const timestamps = (rateLimitMap.get(ip) || []).filter((t) => now - t < windowMs);
  rateLimitMap.set(ip, timestamps);
  return timestamps.length >= MAX_JOBS_PER_HOUR;
}

function recordJobStart(ip) {
  const timestamps = rateLimitMap.get(ip) || [];
  timestamps.push(Date.now());
  rateLimitMap.set(ip, timestamps);
}

function cleanupRateLimitMap() {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  for (const [ip, timestamps] of rateLimitMap.entries()) {
    const fresh = timestamps.filter((t) => now - t < windowMs);
    if (fresh.length === 0) rateLimitMap.delete(ip);
    else rateLimitMap.set(ip, fresh);
  }
}

let concurrentJobs = 0;

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    concurrentJobs,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
  });
});

const ZIP_ID_RE = /^[a-f0-9]{8,64}$/;

app.get('/download/:id', (req, res) => {
  const { id } = req.params;
  if (!ZIP_ID_RE.test(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const zipDirResolved = path.resolve(ZIP_DIR);
  const filePath = path.resolve(zipDirResolved, `${id}.zip`);
  // Confine to ZIP_DIR (defends against any unexpected traversal).
  if (filePath !== path.join(zipDirResolved, `${id}.zip`) || !filePath.startsWith(zipDirResolved + path.sep)) {
    return res.status(400).json({ error: 'invalid path' });
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return res.status(404).json({ error: 'not found' });
    }
    const meta = jobMeta.get(id);
    const hostname = meta?.hostname || 'site';
    const filename = `${hostname}-sitegrab.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.pipe(res);
  });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: false,
});

function getClientIp(socket) {
  return socket.handshake.address || 'unknown';
}

io.on('connection', (socket) => {
  let activeJob = null;

  socket.on('job:start', (payload) => {
    if (activeJob) {
      socket.emit('job:error', { message: 'A job is already running on this connection.' });
      return;
    }

    const ip = getClientIp(socket);

    if (isRateLimited(ip)) {
      socket.emit('job:error', { message: 'Rate limit exceeded. Please try again later.' });
      return;
    }

    if (concurrentJobs >= MAX_CONCURRENT_JOBS) {
      socket.emit('job:error', { message: 'Server is busy. Please try again shortly.' });
      return;
    }

    const { url, options } = payload || {};
    if (!url || typeof url !== 'string') {
      socket.emit('job:error', { message: 'A valid url is required.' });
      return;
    }

    let hostname = 'site';
    try {
      hostname = new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, '') || 'site';
    } catch {
      socket.emit('job:error', { message: 'Invalid URL.' });
      return;
    }

    recordJobStart(ip);
    concurrentJobs++;

    let job;
    try {
      job = startJob({ url, ...(options || {}) }, (event, data) => {
        if (event === 'progress') socket.emit('job:progress', data);
        else if (event === 'log') socket.emit('job:log', data);
        else if (event === 'done') {
          jobMeta.set(data.id, { hostname, socketId: socket.id });
          const { file, ...pub } = data; // never expose server paths
          socket.emit('job:done', { ...pub, downloadUrl: `/download/${data.id}` });
        } else if (event === 'error') {
          socket.emit('job:error', data);
        }
      });
    } catch (err) {
      concurrentJobs--;
      socket.emit('job:error', { message: err?.message || 'Failed to start job.' });
      return;
    }

    activeJob = job;

    job.done
      .catch(() => {})
      .finally(() => {
        concurrentJobs = Math.max(0, concurrentJobs - 1);
        if (activeJob === job) activeJob = null;
      });
  });

  socket.on('job:cancel', () => {
    if (activeJob) {
      activeJob.cancel();
    }
  });

  socket.on('disconnect', () => {
    if (activeJob) {
      activeJob.cancel();
      activeJob = null;
    }
  });
});

// --- Periodic cleanup of old zip files and stale rate-limit entries ---
const cleanupIntervalMs = 5 * 60 * 1000;
const cleanupInterval = setInterval(() => {
  try {
    cleanupOldZips(ZIP_TTL_MINUTES * 60 * 1000);
  } catch (err) {
    console.error('cleanupOldZips failed:', err?.message || err);
  }
  cleanupRateLimitMap();
  // Drop metadata for jobs whose zip no longer exists on disk.
  for (const id of jobMeta.keys()) {
    const zipPath = path.join(path.resolve(ZIP_DIR), `${id}.zip`);
    if (!fs.existsSync(zipPath)) jobMeta.delete(id);
  }
}, cleanupIntervalMs);
cleanupInterval.unref?.();

httpServer.listen(PORT, () => {
  console.log(`SiteGrab server listening on port ${PORT}`);
});

// --- Graceful shutdown ---
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down gracefully...`);
  clearInterval(cleanupInterval);
  io.close();
  httpServer.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  // Force-exit if close hangs.
  setTimeout(() => process.exit(0), 5000).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
