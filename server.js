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
    na:     { host: 'yescrypt.na.mine.zpool.ca', port: 6233 },
    eu:     { host: 'yescrypt.eu.mine.zpool.ca', port: 6233 },
    global: { host: 'yescrypt.mine.zpool.ca',     port: 6233 },
  },
  scrypt: {
    na:     { host: 'scrypt.na.mine.zpool.ca',   port: 3433 },
    eu:     { host: 'scrypt.eu.mine.zpool.ca',   port: 3433 },
    global: { host: 'scrypt.mine.zpool.ca',       port: 3433 },
  },
};

// MoneroOcean pool for XMR
const XMR_POOL = { host: 'gulf.moneroocean.stream', port: 10128 };

// ── Hashing ────────────────────────────────────────────────────────────────────
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

console.log('[✓] Scrypt hashing ready (scrypt + yescrypt)');
console.log('[✓] XMR proxy ready (MoneroOcean)');

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

  // Serve webmr.js if requested
  if (req.method === 'GET' && req.url === '/webmr.js') {
    const filePath = path.join(__dirname, 'webmr.js');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('webmr.js not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(data);
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', algos: ['scrypt', 'yescrypt', 'xmr'] }));
});

// ── WebSocket server ───────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const url = req.url || '/';

  // ── XMR connections come in on /proxy (webmr.js protocol) ──────────────────
  if (url.startsWith('/proxy') || url.startsWith('/xmr')) {
    console.log(`[+] XMR miner connected: ${ip}`);
    handleXmrConnection(ws);
    return;
  }

  // ── Scrypt / YesCrypt connections ───────────────────────────────────────────
  console.log(`[+] Scrypt miner connected: ${ip}`);
  handleScryptConnection(ws);
});

// ── XMR proxy handler (webminerpool protocol) ─────────────────────────────────
function handleXmrConnection(ws) {
  let tcpSocket = null;
  let buffer = '';
  let isAlive = true;

  const heartbeat = setInterval(() => {
    if (!isAlive) { ws.terminate(); return; }
    isAlive = false;
    ws.ping();
  }, 30000);

  ws.on('pong', () => { isAlive = true; });

  // Connect to MoneroOcean TCP
  tcpSocket = new net.Socket();
  tcpSocket.connect(XMR_POOL.port, XMR_POOL.host, () => {
    console.log(`[✓] XMR pool connected: ${XMR_POOL.host}:${XMR_POOL.port}`);
  });

  // Pool → browser
  tcpSocket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(line => {
      if (!line.trim()) return;
      try {
        ws.send(line.trim());
      } catch (e) {}
    });
  });

  tcpSocket.on('error', (err) => {
    console.error('[!] XMR pool error:', err.message);
    try { ws.close(); } catch(e) {}
  });

  tcpSocket.on('close', () => {
    console.log('[-] XMR pool TCP closed');
    try { ws.close(); } catch(e) {}
  });

  // Browser → pool
  ws.on('message', (raw) => {
    const msg = raw.toString();
    if (tcpSocket && tcpSocket.writable) {
      tcpSocket.write(msg + '\n');
    }
  });

  ws.on('close', () => {
    console.log('[-] XMR miner disconnected');
    clearInterval(heartbeat);
    if (tcpSocket) tcpSocket.destroy();
  });

  ws.on('error', (err) => {
    clearInterval(heartbeat);
    if (tcpSocket) tcpSocket.destroy();
  });
}

// ── Scrypt/YesCrypt proxy handler ──────────────────────────────────────────────
function handleScryptConnection(ws) {
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

    if (msg.type === 'connect') {
      currentAlgo = msg.algo || 'scrypt';
      const poolSet = POOLS[currentAlgo] || POOLS.scrypt;
      const pool = poolSet[msg.region] || poolSet.eu;
      console.log(`[>] ${currentAlgo.toUpperCase()} → ${pool.host}:${pool.port}`);

      tcpSocket = new net.Socket();
      tcpSocket.connect(pool.port, pool.host, () => {
        console.log(`[✓] Pool connected: ${pool.host}:${pool.port}`);
        ws.send(JSON.stringify({
          type: 'status', connected: true,
          pool: `${pool.host}:${pool.port}`,
          yescrypt: true, algo: currentAlgo
        }));
      });

      tcpSocket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(line => {
          if (!line.trim()) return;
          try { ws.send(JSON.stringify({ type: 'stratum', data: JSON.parse(line) })); }
          catch (e) {}
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

    if (msg.type === 'hash') {
      const hashHex = await computeHash(msg.header, currentAlgo);
      ws.send(JSON.stringify({
        type: 'hash_result', id: msg.id, hash: hashHex,
        nonce: msg.nonce, jobId: msg.jobId,
        extraNonce2: msg.extraNonce2, nTime: msg.nTime
      }));
      return;
    }

    if (tcpSocket && tcpSocket.writable) {
      tcpSocket.write(JSON.stringify(msg) + '\n');
    }
  });

  ws.on('close', () => {
    console.log('[-] Scrypt miner disconnected');
    clearInterval(heartbeat);
    if (tcpSocket) tcpSocket.destroy();
  });

  ws.on('error', (err) => {
    clearInterval(heartbeat);
    if (tcpSocket) tcpSocket.destroy();
  });
}

// ── Start ──────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`[Proxy] Running on port ${PORT} — Scrypt + YesCrypt + XMR`);
});
