const WebSocket = require('ws');
const net = require('net');

const PORT = process.env.PORT || 8080;

const POOLS = {
  'na':     { host: 'yescrypt.na.mine.zpool.ca',  port: 6233 },
  'eu':     { host: 'yescrypt.eu.mine.zpool.ca',  port: 6233 },
  'global': { host: 'yescrypt.mine.zpool.ca',      port: 6233 },
};

const wss = new WebSocket.Server({ port: PORT });
console.log(`[Proxy] Started on port ${PORT}`);

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[+] Browser connected: ${ip}`);

  let tcpSocket = null;
  let buffer = '';
  let isAlive = true;

  const heartbeat = setInterval(() => {
    if (!isAlive) { ws.terminate(); return; }
    isAlive = false;
    ws.ping();
  }, 30000);

  ws.on('pong', () => { isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'connect') {
      const pool = POOLS[msg.region] || POOLS['na'];
      console.log(`[>] Connecting to ${pool.host}:${pool.port}`);
      tcpSocket = new net.Socket();

      tcpSocket.connect(pool.port, pool.host, () => {
        console.log(`[✓] Pool connected`);
        ws.send(JSON.stringify({ type: 'status', connected: true, pool: `${pool.host}:${pool.port}` }));
      });

      tcpSocket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(line => {
          if (line.trim()) {
            try { ws.send(JSON.stringify({ type: 'stratum', data: JSON.parse(line) })); }
            catch (e) {}
          }
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

    if (tcpSocket && tcpSocket.writable) {
      tcpSocket.write(JSON.stringify(msg) + '\n');
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    if (tcpSocket) tcpSocket.destroy();
  });
});
