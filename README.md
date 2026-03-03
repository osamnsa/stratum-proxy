# Stratum Proxy - Browser to ZPool YesCrypt

WebSocket-to-Stratum bridge so a browser can mine yescrypt on zpool for real.

[Browser] --WebSocket--> [This proxy on Render] --TCP--> [ZPool]

## Deploy on Render
1. Push this repo to GitHub
2. Render > New > Background Worker
3. Build Command: npm install
4. Start Command: node server.js
5. Copy your wss:// URL when deployed

## Miner Settings
- Proxy URL: wss://your-service.onrender.com
- Wallet: Your BTC address
- Password: c=BTC
- Region: na / eu / global
