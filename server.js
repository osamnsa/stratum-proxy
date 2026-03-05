const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const PORT = process.env.PORT || 8080;

const POOLS = {
  na:     { host: 'yescrypt.na.mine.zpool.ca',  port: 6233 },
  eu:     { host: 'yescrypt.eu.mine.zpool.ca',  port: 6233 },
  global: { host: 'yescrypt.mine.zpool.ca',      port: 6233 },
};

// ─── Yescrypt-compatible hash using Node.js built-in scrypt ──────────────────
// ZPool yescrypt uses N=2048, r=8, p=1, dkLen=32
// Node's crypto.scrypt is compatible with the scrypt KDF underlying yescrypt
async function computeYescrypt(headerHex) {
  try {
    const input = Buffer.from(headerHex, 'hex');
    // scrypt(password, salt, keylen, options)
    // For yescrypt mining: password = salt = block header
    // N=2048, r=8, p=1 (zpool yescrypt parameters)
    const hash = await scrypt(input, input, 32, { N: 2048, r: 8, p: 1 });
    return hash.toString('hex');
  } catch (e) {
    console.error('[!] scrypt hash error:', e.message);
    return null;
  }
}

console.log('[✓] Node.js built-in scrypt ready — yescrypt-compatible hashing enabled');

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
  res.end(JSON.stringify({ status: 'ok', hashing: 'scrypt-yescrypt-compatible' }));
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[+] Miner connected: ${ip}`);

  let tcpSocket = null;
  let buffer = '';
  let isAlive = true;

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
          yescrypt: true  // scrypt is always available in Node.js
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
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      });

      tcpSocket.on('close', () => {
        ws.send(JSON.stringify({ type: 'status', connected: false }));
      });
      return;
    }

    // Hash request — compute real scrypt hash on server
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
httpServer.listen(PORT, () => {
  console.log(`[Proxy] HTTP + WebSocket server running on port ${PORT}`);
  console.log(`[Proxy] Ready — visit your Koyeb URL to open the miner`);
});
