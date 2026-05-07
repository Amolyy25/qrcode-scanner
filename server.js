'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT ?? 3000;
const SESSION_TTL_MS = 5 * 60 * 1000;

// sessions: token -> { mac: WebSocket, ttlTimer: NodeJS.Timeout }
const sessions = new Map();

function destroySession(token, reason = 'session_destroyed') {
  const session = sessions.get(token);
  if (!session) return;
  sessions.delete(token);
  clearTimeout(session.ttlTimer);
  if (session.mac?.readyState === session.mac?.OPEN) {
    session.mac.close(4001, reason === 'session_expired' ? 'session_expired' : reason);
  }
  if (session.phone?.readyState === session.phone?.OPEN) {
    session.phone.close(1000, reason);
  }
  console.log(`[${token}] session destroyed — ${reason}`);
}

function bridge(a, b, tokenForLog) {
  a.on('message', (data, isBinary) => {
    if (b.readyState === b.OPEN) b.send(data, { binary: isBinary });
  });
  b.on('message', (data, isBinary) => {
    if (a.readyState === a.OPEN) a.send(data, { binary: isBinary });
  });

  const cleanup = (side) => () => {
    console.log(`[${tokenForLog}] ${side} disconnected`);
    destroySession(tokenForLog, 'peer_disconnected');
  };

  a.on('close', cleanup('mac'));
  b.on('close', cleanup('phone'));
  a.on('error', (err) => console.error(`[${tokenForLog}] mac error: ${err.message}`));
  b.on('error', (err) => console.error(`[${tokenForLog}] phone error: ${err.message}`));
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;
  const token = url.searchParams.get('token');

  if (!token) {
    socket.destroy();
    return;
  }

  if (pathname === '/mac') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (sessions.has(token)) {
        ws.close(4009, 'token_conflict');
        console.log(`[${token}] mac rejected — token_conflict`);
        return;
      }

      const ttlTimer = setTimeout(() => {
        destroySession(token, 'session_expired');
      }, SESSION_TTL_MS);

      sessions.set(token, { mac: ws, phone: null, ttlTimer });
      console.log(`[${token}] session created`);

      ws.on('error', (err) => console.error(`[${token}] mac error: ${err.message}`));
      ws.on('close', () => {
        if (sessions.has(token) && !sessions.get(token).phone) {
          destroySession(token, 'mac_disconnected');
        }
      });
    });
    return;
  }

  if (pathname === '/phone') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = sessions.get(token);
      if (!session) {
        ws.close(4004, 'token_not_found');
        console.log(`[${token}] phone rejected — token_not_found`);
        return;
      }

      clearTimeout(session.ttlTimer);
      session.phone = ws;
      session.ttlTimer = null;
      console.log(`[${token}] phone joined — bridging`);

      // Remove individual close listener from mac before bridging
      session.mac.removeAllListeners('close');
      session.mac.removeAllListeners('error');

      bridge(session.mac, ws, token);
    });
    return;
  }

  socket.destroy();
});

process.on('uncaughtException', (err) => console.error(`uncaughtException: ${err.message}`));
process.on('unhandledRejection', (reason) => console.error(`unhandledRejection: ${reason}`));

server.listen(PORT, () => console.log(`relay listening on port ${PORT}`));
