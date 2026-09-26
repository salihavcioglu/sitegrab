// SiteGrab — (c) 2026 Salih Avcioglu. MIT License.
// A job = crawl into data/tmp/<id>, zip to data/zips/<id>.zip, always remove the tmp dir.
import { randomBytes } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawl } from './crawler.js';
import { zipDirectory } from './zip.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(PROJECT_ROOT, 'data'));
export const ZIP_DIR = path.join(DATA_DIR, 'zips');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');

const JOB_TIMEOUT_MS = (Number(process.env.JOB_TIMEOUT_MINUTES) || 15) * 60_000;

const clampInt = (value, min, max, fallback) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Validates and clamps user options. Throws on an invalid URL. */
export function normalizeOptions(options = {}) {
  let raw = String(options.url ?? '').trim();
  if (raw && !/^[a-z][a-z\d+.-]*:/i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Please enter a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs are supported.');
  return {
    url: url.href,
    maxDepth: clampInt(options.maxDepth, 0, 5, 2),
    maxPages: clampInt(options.maxPages, 1, 1000, 200),
    maxSizeMB: clampInt(options.maxSizeMB, 1, 500, 100),
    singlePage: options.singlePage === true || options.singlePage === 'true',
  };
}

/**
 * Starts a crawl+zip job. onEvent(name, data) receives 'progress' | 'log' | 'done' | 'error'.
 * Returns { id, cancel(), done } — `done` resolves with the 'done' payload or rejects
 * (it is pre-handled, so ignoring it never causes an unhandled rejection).
 * Throws synchronously if the options are invalid.
 */
export function startJob(options, onEvent = () => {}) {
  const opts = normalizeOptions(options);
  const id = randomBytes(12).toString('hex');
  const controller = new AbortController();
  const tmpDir = path.join(TMP_DIR, id);
  const zipFile = path.join(ZIP_DIR, `${id}.zip`);
  const emit = (name, data) => {
    try {
      onEvent(name, data);
    } catch {
      /* ignore listener failures */
    }
  };

  const timer = setTimeout(() => controller.abort(new Error('Job took too long and was stopped.')), JOB_TIMEOUT_MS);
  timer.unref?.();

  const run = async () => {
    const result = await crawl({
      url: opts.url,
      outDir: tmpDir,
      maxDepth: opts.singlePage ? 0 : opts.maxDepth,
      maxPages: opts.maxPages,
      maxBytes: opts.maxSizeMB * 1024 * 1024,
      singlePage: opts.singlePage,
      signal: controller.signal,
      onProgress(ev) {
        if (ev.type === 'file') {
          emit('progress', { pages: ev.pages, files: ev.files, bytes: ev.totalBytes, current: ev.url });
        } else if (ev.type === 'log') {
          emit('log', { level: ev.level, message: ev.message });
        }
      },
    });
    if (result.files === 0) {
      const reason = result.errors[0]?.message;
      throw new Error(`Could not download ${opts.url}${reason ? `: ${reason}` : ''}`);
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    emit('log', { level: 'info', message: `Downloaded ${result.files} files, creating ZIP…` });
    const zipBytes = await zipDirectory(tmpDir, zipFile);
    if (controller.signal.aborted) throw controller.signal.reason;
    return { id, file: zipFile, pages: result.pages, files: result.files, bytes: result.bytes, zipBytes, errors: result.errors.length };
  };

  const done = run()
    .then(
      (payload) => {
        emit('done', payload);
        return payload;
      },
      async (err) => {
        await rm(zipFile, { force: true }).catch(() => {});
        const message = controller.signal.aborted
          ? controller.signal.reason?.message || 'Job cancelled.'
          : err?.message || 'Job failed.';
        emit('error', { message });
        throw err instanceof Error ? err : new Error(message);
      },
    )
    .finally(async () => {
      clearTimeout(timer);
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });
  done.catch(() => {});

  return {
    id,
    cancel: () => controller.abort(new Error('Job cancelled.')),
    done,
  };
}

/** Deletes zips older than maxAgeMs. Resolves to the number removed; never rejects. */
export async function cleanupOldZips(maxAgeMs) {
  let removed = 0;
  try {
    const now = Date.now();
    for (const name of await readdir(ZIP_DIR)) {
      if (!name.endsWith('.zip')) continue;
      const file = path.join(ZIP_DIR, name);
      try {
        if (now - (await stat(file)).mtimeMs > maxAgeMs) {
          await rm(file, { force: true });
          removed++;
        }
      } catch {
        /* file vanished or locked */
      }
    }
  } catch {
    /* ZIP_DIR missing */
  }
  return removed;
}
