#!/usr/bin/env node
// SiteGrab — (c) 2026 Salih Avcioglu. MIT License.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startJob } from '../src/core/job.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printUsage() {
  console.log(`SiteGrab CLI - download a website as a ZIP

Usage:
  sitegrab <url> [options]

Options:
  -d, --depth <n>     Max crawl depth (default: 2)
  -p, --pages <n>     Max pages to fetch (default: 200)
  -s, --size <mb>     Max total size in MB (default: 100)
      --single        Only fetch the single page (no crawling)
  -o, --out <path>    Output zip path (default: ./<host>.zip)
  -h, --help          Show this help message
`);
}

function parseArgs(argv) {
  const args = { url: null, depth: undefined, pages: undefined, size: undefined, single: false, out: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-d':
      case '--depth':
        args.depth = Number(argv[++i]);
        break;
      case '-p':
      case '--pages':
        args.pages = Number(argv[++i]);
        break;
      case '-s':
      case '--size':
        args.size = Number(argv[++i]);
        break;
      case '--single':
        args.single = true;
        break;
      case '-o':
      case '--out':
        args.out = argv[++i];
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        rest.push(arg);
    }
  }
  args.url = rest[0] || null;
  return args;
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

function writeProgress(line) {
  if (process.stdout.isTTY) {
    process.stdout.write(`\r\x1b[K${line}`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.url) {
    printUsage();
    process.exit(args.url ? 0 : 1);
  }

  let hostname = 'site';
  try {
    hostname = new URL(args.url).hostname.replace(/[^a-zA-Z0-9.-]/g, '') || 'site';
  } catch {
    console.error(`Invalid URL: ${args.url}`);
    process.exit(1);
  }

  const outPath = path.resolve(process.cwd(), args.out || `./${hostname}.zip`);

  const options = {
    url: args.url,
    ...(args.depth !== undefined && !Number.isNaN(args.depth) ? { maxDepth: args.depth } : {}),
    ...(args.pages !== undefined && !Number.isNaN(args.pages) ? { maxPages: args.pages } : {}),
    ...(args.size !== undefined && !Number.isNaN(args.size) ? { maxSizeMB: args.size } : {}),
    ...(args.single ? { singlePage: true } : {}),
  };

  console.log(`Fetching ${args.url} ...`);

  let job;
  let cancelled = false;

  const onSigint = () => {
    cancelled = true;
    writeProgress('Cancelling...\n');
    if (job) job.cancel();
  };
  process.on('SIGINT', onSigint);

  try {
    job = startJob(options, (event, data) => {
      if (event === 'progress') {
        const { pages = 0, files = 0, bytes = 0, current } = data || {};
        const currentStr = current ? ` ${current}` : '';
        writeProgress(`Pages: ${pages}  Files: ${files}  Size: ${formatBytes(bytes)}${currentStr}`);
      } else if (event === 'log') {
        if (data?.level === 'error' || data?.level === 'warn') {
          writeProgress('');
          console.error(`[${data.level}] ${data.message}`);
        }
      } else if (event === 'error') {
        writeProgress('');
        console.error(`Error: ${data?.message || 'unknown error'}`);
      }
    });

    const result = await job.done;
    process.off('SIGINT', onSigint);

    if (cancelled) {
      writeProgress('');
      console.log('Job cancelled.');
      process.exit(130);
    }

    writeProgress('');

    if (!result || !result.file) {
      console.error('Job finished without producing a zip file.');
      process.exit(1);
    }

    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.copyFile(result.file, outPath);

    console.log(`Done. Pages: ${result.pages}, Files: ${result.files}, Size: ${formatBytes(result.zipBytes ?? result.bytes)}`);
    console.log(`Saved to: ${outPath}`);
  } catch (err) {
    process.off('SIGINT', onSigint);
    writeProgress('');
    if (cancelled) {
      console.log('Job cancelled.');
      process.exit(130);
    }
    console.error(`Failed: ${err?.message || err}`);
    process.exit(1);
  }
}

main();
