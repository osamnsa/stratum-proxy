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

// ─── HTTP server — serves miner.html ─────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
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
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ZPool Stratum Proxy — OK');
  }
});

// ─── WebSocket server — handles mining connections ────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[+] Miner connected from ${ip}`);

  let tcpSocket = null;
  let buffer = '';
  let isAlive = true;

  // Keep-alive ping every 30s
  const heartbeat = setInterval(() => {
    if (!isAlive) {
      console.log('[!] Client timeout, terminating');
      ws.terminate();
      return;
    }
    isAlive = false;
    ws.ping();
  }, 30000);

  ws.on('pong', () => { isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // Connect command — browser tells us which pool region to connect to
    if (msg.type === 'connect') {
      const pool = POOLS[msg.region] || POOLS.eu;
      console.log(`[>] Connecting to pool ${pool.host}:${pool.port}`);

      tcpSocket = new net.Socket();

      tcpSocket.connect(pool.port, pool.host, () => {
        console.log(`[✓] Pool connected: ${pool.host}:${pool.port}`);
        ws.send(JSON.stringify({
          type: 'status',
          connected: true,
          pool: `${pool.host}:${pool.port}`
        }));
      });

      // Pool → browser: relay stratum messages
      tcpSocket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // hold incomplete line
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
        console.log('[-] Pool connection closed');
        ws.send(JSON.stringify({ type: 'status', connected: false }));
      });

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
httpServer.listen(PORT, () => {
  console.log(`[Proxy] HTTP + WebSocket server running on port ${PORT}`);
  console.log(`[Proxy] Ready — visit your Koyeb URL to open the miner`);
});
