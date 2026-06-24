const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
app.use(cors());
app.use(express.json());

let client = null;
let qrCode = null;
let status = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'

// We need an API key to ensure only our Vercel backend can hit this service
const API_KEY = process.env.API_KEY || 'your-secret-api-key';

function checkAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use(checkAuth);

function initWhatsApp() {
  if (client) return;
  status = 'connecting';
  
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ],
    },
  });

  client.on('qr', (qr) => {
    qrCode = qr;
    status = 'qr_ready';
    console.log('QR Code ready');
  });

  client.on('ready', () => {
    status = 'connected';
    qrCode = null;
    console.log('WhatsApp connected');
  });

  client.on('disconnected', () => {
    status = 'disconnected';
    client = null;
    qrCode = null;
    console.log('WhatsApp disconnected');
  });

  client.on('auth_failure', () => {
    status = 'disconnected';
    client = null;
    console.log('WhatsApp auth failed');
  });

  client.initialize().catch(err => {
    console.error('Init error:', err);
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

app.get('/status', (req, res) => {
  if (status === 'disconnected') {
    initWhatsApp();
  }
  res.json({ status, qrCode });
});

app.post('/disconnect', async (req, res) => {
  if (client) {
    try {
      await client.logout();
      await client.destroy();
    } catch(e) {}
  }
  status = 'disconnected';
  qrCode = null;
  client = null;
  res.json({ ok: true });
});

app.post('/send', async (req, res) => {
  if (status !== 'connected' || !client) {
    return res.status(400).json({ error: 'WhatsApp not connected' });
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
    console.error('Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`WhatsApp microservice listening on port ${PORT}`);
});
