const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

const POOLS = {
  na:     { host: 'yescrypt.na.mine.zpool.ca',  port: 6233 },
  eu:     { host: 'yescrypt.eu.mine.zpool.ca',  port: 6233 },
  global: { host: 'yescrypt.mine.zpool.ca',      port: 6233 },
};

// Load yescrypt WASM for real hashing
let yescrypt = null;
async function loadYescrypt() {
  try {
    const mod = await import('yescrypt-wasm');
    yescrypt = mod.default || mod;
    console.log('[✓] yescrypt-wasm loaded — real hashing enabled');
  } catch (e) {
    console.warn('[!] yescrypt-wasm not available:', e.message);
    console.warn('[!] Falling back to SHA256 (shares will be rejected by pool)');
  }
}

// Compute real yescrypt hash of a block header
// ZPool yescrypt uses: N=2048, r=8, p=1
async function computeYescrypt(headerHex) {
  if (!yescrypt) return null;
  try {
    const input = Buffer.from(headerHex, 'hex');
    // yescrypt-wasm: hash(password, salt, N, r, p, dkLen)
    // For mining, password = salt = block header
    const result = await yescrypt.hash(input, input, 2048, 8, 1, 32);
    return Buffer.from(result).toString('hex');
  } catch (e) {
    console.error('[!] yescrypt hash error:', e.message);
    return null;
  }
}

// ─── HTTP server — serves miner.html ─────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // CORS headers for WebSocket upgrade
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

  // Health check endpoint
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    yescrypt: yescrypt !== null,
    pools: Object.keys(POOLS)
  }));
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[+] Miner connected: ${ip}`);

  let tcpSocket = null;
  let buffer = '';
  let isAlive = true;

  // Track pending message IDs to know which are share submissions
  const pendingShares = new Map(); // msgId -> {jobId, nonce, ...}

  const heartbeat = setInterval(() => {
    if (!isAlive) { ws.terminate(); return; }
    isAlive = false;
    ws.ping();
  }, 30000);

  ws.on('pong', () => { isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // Connect to pool command
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
          yescrypt: yescrypt !== null
        }));
      });

      tcpSocket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(line => {
          if (!line.trim()) return;
          try {
            const parsed = JSON.parse(line);
            ws.send(JSON.stringify({ type: 'stratum', data: parsed }));
          } catch (e) {
            console.warn('[!] Non-JSON from pool:', line.slice(0, 80));
          }
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

    // Hash request — browser sends header, we compute yescrypt and check target
    if (msg.type === 'hash') {
      if (!yescrypt) {
        ws.send(JSON.stringify({ type: 'hash_result', id: msg.id, error: 'yescrypt not loaded' }));
        return;
      }
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

    // All other messages — forward to pool as stratum JSON-RPC
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
  });
});
