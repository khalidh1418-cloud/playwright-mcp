#!/usr/bin/env node
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { timingSafeEqual } = require('node:crypto');

const externalPort = Number(process.env.PORT || 10000);
const internalPort = Number(process.env.PLAYWRIGHT_INTERNAL_PORT || 8931);
const token = String(process.env.PLAYWRIGHT_GATEWAY_TOKEN || '');

if (!token || token.length < 24) {
  console.error('PLAYWRIGHT_GATEWAY_TOKEN must be set to a strong secret (24+ chars).');
  process.exit(1);
}

function authorized(req) {
  const header = String(req.headers.authorization || '');
  const expected = `Bearer ${token}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tcpReady() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: internalPort });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const childArgs = [
  '/app/cli.js',
  '--headless',
  '--browser', 'chromium',
  '--no-sandbox',
  '--port', String(internalPort),
  '--host', '127.0.0.1',
  '--shared-browser-context',
  '--image-responses', 'omit',
  '--snapshot-mode', 'full',
  '--output-dir', '/tmp/playwright-output'
];

const child = spawn(process.execPath, childArgs, {
  stdio: 'inherit',
  env: { ...process.env }
});

child.on('exit', (code, signal) => {
  console.error(`Playwright MCP exited code=${code} signal=${signal || ''}`);
  process.exit(code || 1);
});

const server = http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    const ready = await tcpReady();
    res.writeHead(ready ? 200 : 503, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    return res.end(JSON.stringify({
      ok: ready,
      service: 'playwright-mcp-gateway',
      upstream: '@playwright/mcp',
      auth: 'bearer',
      persistentProfile: false,
      transport: 'streamable-http'
    }));
  }

  if (req.url !== '/mcp') {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  }

  if (!authorized(req)) {
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer'
    });
    return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
  }

  const headers = { ...req.headers };
  delete headers.authorization;
  headers.host = `127.0.0.1:${internalPort}`;

  const upstream = http.request({
    hostname: '127.0.0.1',
    port: internalPort,
    path: '/mcp',
    method: req.method,
    headers
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'upstream_unreachable', message: error.message }));
  });

  req.pipe(upstream);
});

server.listen(externalPort, '0.0.0.0', () => {
  console.log(`Authenticated Playwright MCP gateway listening on :${externalPort}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down.`);
  server.close(() => process.exit(0));
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
