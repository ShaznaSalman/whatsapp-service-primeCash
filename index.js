import express from 'express';
import cors from 'cors';
import { createRequire } from 'module';
import { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import { promises as fs } from 'fs';

const require = createRequire(import.meta.url);

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY || 'your-secret-api-key';
const SESSION_DIR = './auth_info';

let sock = null;
let status = 'disconnected'; // disconnected | connecting | qr_ready | connected
let latestQR = null; // raw QR string from Baileys

const logger = pino({ level: 'silent' }); // keep logs quiet

function checkAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.use(checkAuth);

async function startSocket() {
  if (sock) return;
  status = 'connecting';
  latestQR = null;
  console.log('[WA] Starting Baileys socket...');

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['PrimeCash', 'Chrome', '120.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      status = 'qr_ready';
      console.log('[WA] QR ready — waiting for scan');
    }

    if (connection === 'open') {
      status = 'connected';
      latestQR = null;
      console.log('[WA] Connected!');
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log('[WA] Connection closed. Reason:', reason);
      sock = null;
      latestQR = null;

      if (reason === DisconnectReason.loggedOut) {
        // Session invalidated — clear auth and let user re-scan
        status = 'disconnected';
        try { await fs.rm(SESSION_DIR, { recursive: true, force: true }); } catch {}
        console.log('[WA] Logged out — session cleared');
      } else {
        // Any other disconnect — reconnect automatically
        status = 'connecting';
        setTimeout(startSocket, 3000);
      }
    }
  });
}

// Health check (no auth needed for uptime monitors)
app.get('/health', (req, res) => res.json({ ok: true, status }));

app.get('/status', async (req, res) => {
  if (status === 'disconnected') {
    startSocket().catch(console.error);
  }
  // Convert QR string to a base64 PNG so the frontend can display it directly
  let qrImage = null;
  if (latestQR) {
    try { qrImage = await QRCode.toDataURL(latestQR); } catch {}
  }
  res.json({ status, qrCode: latestQR, qrImage });
});

app.post('/disconnect', async (req, res) => {
  if (sock) {
    try { await sock.logout(); } catch {}
    sock = null;
  }
  status = 'disconnected';
  latestQR = null;
  try { await fs.rm(SESSION_DIR, { recursive: true, force: true }); } catch {}
  res.json({ ok: true });
});

app.post('/send', async (req, res) => {
  if (status !== 'connected' || !sock) {
    return res.status(400).json({ error: `WhatsApp not connected (status: ${status})` });
  }
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });

  try {
    // Format Sri Lankan numbers: 07x → 94 7x
    let phone = to.replace(/[^0-9]/g, '');
    if (phone.startsWith('0')) phone = '94' + phone.substring(1);
    else if (phone.length === 9) phone = '94' + phone;
    const jid = `${phone}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text: message });
    res.json({ ok: true });
  } catch (err) {
    console.error('[WA] Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`WhatsApp microservice (Baileys) running on port ${PORT}`);
  startSocket().catch(console.error);
});
