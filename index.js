const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

let client = null;
let qrCode = null;
let status = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'

const API_KEY = process.env.API_KEY || 'your-secret-api-key';

function checkAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use(checkAuth);

async function getChromePath() {
  try {
    // Use puppeteer's downloaded Chrome
    const browser = await puppeteer.launch({ headless: true });
    const path = browser.process().spawnfile;
    await browser.close();
    return path;
  } catch (e) {
    console.log('Could not detect puppeteer chrome path, using system defaults');
    return null;
  }
}

async function initWhatsApp() {
  if (client) return;
  status = 'connecting';
  console.log('[WhatsApp] Initializing...');

  const chromePath = await getChromePath();
  console.log('[WhatsApp] Chrome path:', chromePath || 'system default');

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
    puppeteer: {
      headless: true,
      executablePath: chromePath || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
      ],
    },
  });

  client.on('qr', (qr) => {
    qrCode = qr;
    status = 'qr_ready';
    console.log('[WhatsApp] QR Code ready');
  });

  client.on('ready', () => {
    status = 'connected';
    qrCode = null;
    console.log('[WhatsApp] Connected!');
  });

  client.on('disconnected', () => {
    status = 'disconnected';
    client = null;
    qrCode = null;
    console.log('[WhatsApp] Disconnected.');
  });

  client.on('auth_failure', () => {
    status = 'disconnected';
    client = null;
    console.error('[WhatsApp] Auth failed.');
  });

  client.initialize().catch(err => {
    console.error('[WhatsApp] Init error:', err.message);
    status = 'disconnected';
    client = null;
  });
}

function formatPhone(phone) {
  let p = phone.replace(/[^0-9]/g, '');
  if (p.startsWith('0')) p = '94' + p.substring(1);
  else if (p.length === 9) p = '94' + p;
  return `${p}@c.us`;
}

// Health check (no auth needed)
app.get('/health', (req, res) => {
  res.json({ ok: true, status });
});

app.get('/status', (req, res) => {
  if (status === 'disconnected') {
    initWhatsApp(); // fire and forget — QR arrives async
  }
  res.json({ status, qrCode });
});

app.post('/disconnect', async (req, res) => {
  if (client) {
    try {
      await client.logout();
      await client.destroy();
    } catch (e) {}
  }
  status = 'disconnected';
  qrCode = null;
  client = null;
  res.json({ ok: true });
});

app.post('/send', async (req, res) => {
  if (status !== 'connected' || !client) {
    return res.status(400).json({ error: `WhatsApp not connected (status: ${status})` });
  }
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ error: 'Missing to or message' });
  }
  try {
    const formatted = formatPhone(to);
    await client.sendMessage(formatted, message);
    res.json({ ok: true });
  } catch (err) {
    console.error('[WhatsApp] Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`WhatsApp microservice running on port ${PORT}`);
  // Auto-start on boot
  initWhatsApp();
});
