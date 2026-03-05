const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

const POOLS = {
  na:     { host: 'yescrypt.na.mine.zpool.ca',  port: 6233 },
  eu:     { host: 'yescrypt.eu.mine.zpool.ca',  port: 6233 },
  global: { host: 'yescrypt.mine.zpool.ca',      port: 6233 },
};

// ─── yescrypt hashing ─────────────────────────────────────────────────────────
let yescryptHash = null;

async function loadYescrypt() {
  const attempts = [
    // Try ESM dynamic import
    async () => {
      const mod = await import('yescrypt-wasm');
      return mod.yescrypt || mod.hash || mod.default?.yescrypt || mod.default?.hash || mod.default;
    },
    // Try require
    async () => {
      const mod = require('yescrypt-wasm');
      return mod.yescrypt || mod.hash || mod.default?.yescrypt || mod.default?.hash || mod.default;
    },
  ];

  for (const attempt of attempts) {
    try {
      const fn = await attempt();
      if (typeof fn === 'function') {
        // Test it works
        const testInput = Buffer.alloc(80);
        await fn(testInput, testInput, 2048, 8, 1, 32);
        yescryptHash = fn;
        console.log('[✓] yescrypt-wasm loaded and tested — real hashing enabled');
        return;
      } else {
        console.log('[!] yescrypt-wasm loaded but no callable function found, type:', typeof fn);
      }
    } catch (e) {
      console.log('[!] yescrypt load attempt failed:', e.message);
    }
  }
  console.warn('[!] yescrypt-wasm unavailable — proxy will relay stratum only');
  console.warn('[!] Shares will be computed browser-side with SHA256 (rejected by pool)');
}

async function computeYescrypt(headerHex) {
  if (!yescryptHash) return null;
  try {
    const input = Buffer.from(headerHex, 'hex');
    const result = await yescryptHash(input, input, 2048, 8, 1, 32);
    // Reverse bytes for display (little-endian to big-endian)
    return Buffer.from(result).reverse().toString('hex');
  } catch (e) {
    console.error('[!] yescrypt compute error:', e.message);
    return null;
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' && (req.url === '/' || req.url === '/miner.html')) {
    const filePath = path.join(__dirname, 'miner.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('miner.html not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    yescrypt: yescryptHash !== null,
    pools: Object.keys(POOLS)
  }));
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[+] Miner connected from ${ip}`);

  let tcpSocket = null;
  let buffer = '';
  let isAlive = true;
  const pendingHashes = new Map();

  const heartbeat = setInterval(() => {
    if (!isAlive) { ws.terminate(); return; }
    isAlive = false;
    ws.ping();
  }, 30000);

  ws.on('pong', () => { isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // Connect to pool
    if (msg.type === 'connect') {
      const pool = POOLS[msg.region] || POOLS.eu;
      console.log(`[>] Connecting to pool ${pool.host}:${pool.port}`);
      tcpSocket = new net.Socket();

      tcpSocket.connect(pool.port, pool.host, () => {
        console.log(`[✓] Pool connected: ${pool.host}:${pool.port}`);
        ws.send(JSON.stringify({
          type: 'status',
          connected: true,
          pool: `${pool.host}:${pool.port}`,
          yescrypt: yescryptHash !== null
        }));
      });

      tcpSocket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(line => {
          if (!line.trim()) return;
          try {
            ws.send(JSON.stringify({ type: 'stratum', data: JSON.parse(line) }));
          } catch (e) {}
        });
      });

      tcpSocket.on('error', (err) => {
        console.error('[!] Pool error:', err.message);
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      });

      tcpSocket.on('close', () => {
        console.log('[-] Pool TCP closed');
        ws.send(JSON.stringify({ type: 'status', connected: false }));
      });
      return;
    }

    // Hash request from browser
    if (msg.type === 'hash') {
      const hashHex = await computeYescrypt(msg.header);
      ws.send(JSON.stringify({
        type: 'hash_result',
        id: msg.id,
        hash: hashHex,
        nonce: msg.nonce,
        jobId: msg.jobId,
        extraNonce2: msg.extraNonce2,
        nTime: msg.nTime
      }));
      return;
    }

    // Forward stratum messages to pool
    if (tcpSocket && tcpSocket.writable) {
      tcpSocket.write(JSON.stringify(msg) + '\n');
    }
  });

  ws.on('close', () => {
    console.log('[-] Miner disconnected');
    clearInterval(heartbeat);
    if (tcpSocket) tcpSocket.destroy();
  });

  ws.on('error', (err) => {
    console.error('[!] WS error:', err.message);
    clearInterval(heartbeat);
    if (tcpSocket) tcpSocket.destroy();
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
loadYescrypt().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`[Proxy] HTTP + WebSocket server running on port ${PORT}`);
    console.log(`[Proxy] Ready — visit your Koyeb URL to open the miner`);
    console.log(`[Proxy] yescrypt available: ${yescryptHash !== null}`);
  });
});
