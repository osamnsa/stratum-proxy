const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const PORT = process.env.PORT || 8080;

// ── Pool endpoints ─────────────────────────────────────────────────────────────
const POOLS = {
  yescrypt: {
    na:     { host: 'yescrypt.na.mine.zpool.ca',  port: 6233 },
    eu:     { host: 'yescrypt.eu.mine.zpool.ca',  port: 6233 },
    global: { host: 'yescrypt.mine.zpool.ca',      port: 6233 },
  },
  scrypt: {
    na:     { host: 'scrypt.na.mine.zpool.ca',    port: 3433 },
    eu:     { host: 'scrypt.eu.mine.zpool.ca',    port: 3433 },
    global: { host: 'scrypt.mine.zpool.ca',        port: 3433 },
  },
};

// ── Hashing ────────────────────────────────────────────────────────────────────
// Node.js crypto.scrypt is compatible with both yescrypt and scrypt KDF
// ZPool params: N=2048, r=8, p=1 for yescrypt; N=1024, r=1, p=1 for scrypt
async function computeHash(headerHex, algo) {
  try {
    const input = Buffer.from(headerHex, 'hex');
    const opts = algo === 'scrypt'
      ? { N: 1024, r: 1, p: 1 }
      : { N: 2048, r: 8, p: 1 };
    const hash = await scrypt(input, input, 32, opts);
    return hash.toString('hex');
  } catch (e) {
    console.error('[!] Hash error:', e.message);
    return null;
  }
}

console.log('[✓] Node.js built-in scrypt ready (yescrypt + scrypt compatible)');

// ── HTTP server ────────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'GET' && (req.url === '/' || req.url === '/miner.html')) {
    const filePath = path.join(__dirname, 'miner.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', algos: ['yescrypt','scrypt'] }));
});

// ── WebSocket server ───────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[+] Miner connected: ${ip}`);

  let tcpSocket = null;
  let buffer = '';
  let isAlive = true;
  let currentAlgo = 'scrypt';

  const heartbeat = setInterval(() => {
    if (!isAlive) { ws.terminate(); return; }
    isAlive = false;
    ws.ping();
  }, 30000);

  ws.on('pong', () => { isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // Connect command
    if (msg.type === 'connect') {
      currentAlgo = msg.algo || 'scrypt';
      const poolSet = POOLS[currentAlgo] || POOLS.scrypt;
      const pool = poolSet[msg.region] || poolSet.eu;
      console.log(`[>] ${currentAlgo.toUpperCase()} → ${pool.host}:${pool.port}`);

      tcpSocket = new net.Socket();
      tcpSocket.connect(pool.port, pool.host, () => {
        console.log(`[✓] Pool connected: ${pool.host}:${pool.port}`);
        ws.send(JSON.stringify({
          type: 'status',
          connected: true,
          pool: `${pool.host}:${pool.port}`,
          yescrypt: true,
          algo: currentAlgo
        }));
      });

      tcpSocket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(line => {
          if (!line.trim()) return;
          try { ws.send(JSON.stringify({ type:'stratum', data:JSON.parse(line) })); }
          catch (e) {}
        });
      });

      tcpSocket.on('error', (err) => {
        ws.send(JSON.stringify({ type:'error', message:err.message }));
      });

      tcpSocket.on('close', () => {
        ws.send(JSON.stringify({ type:'status', connected:false }));
      });
      return;
    }

    // Hash request
    if (msg.type === 'hash') {
      const hashHex = await computeHash(msg.header, currentAlgo);
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

    // Forward to pool
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

// ── Start ──────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`[Proxy] Running on port ${PORT} — Scrypt + YesCrypt + WebSocket proxy`);
});
