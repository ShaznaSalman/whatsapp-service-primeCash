import express from 'express';
import cors from 'cors';
import { createRequire } from 'module';
import { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import { promises as fs } from 'fs';
import { createClient } from '@supabase/supabase-js';

const require = createRequire(import.meta.url);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Large limit for base64 PDF documents

const API_KEY = process.env.API_KEY || 'your-secret-api-key';
const SESSION_DIR = './auth_info';
const SUPABASE_BUCKET = 'whatsapp-session';
const SUPABASE_PATH = 'auth_info';

// ─── Supabase client (optional — session backup) ─────────────────────────────
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function downloadSessionFromSupabase() {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const { data: files, error } = await supabase.storage.from(SUPABASE_BUCKET).list(SUPABASE_PATH);
    if (error || !files || files.length === 0) return;

    await fs.mkdir(SESSION_DIR, { recursive: true });
    for (const file of files) {
      const { data, error: dlErr } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .download(`${SUPABASE_PATH}/${file.name}`);
      if (dlErr || !data) continue;
      const buffer = Buffer.from(await data.arrayBuffer());
      await fs.writeFile(`${SESSION_DIR}/${file.name}`, buffer);
    }
    console.log(`[WA] Session restored from Supabase (${files.length} files)`);
  } catch (e) {
    console.error('[WA] Failed to restore session from Supabase:', e.message);
  }
}

async function uploadSessionToSupabase() {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    let files;
    try { files = await fs.readdir(SESSION_DIR); } catch { return; }
    for (const file of files) {
      const content = await fs.readFile(`${SESSION_DIR}/${file}`);
      await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(`${SUPABASE_PATH}/${file}`, content, { upsert: true, contentType: 'application/octet-stream' });
    }
    console.log(`[WA] Session backed up to Supabase (${files.length} files)`);
  } catch (e) {
    console.error('[WA] Failed to backup session to Supabase:', e.message);
  }
}

async function clearSupabaseSession() {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const { data: files } = await supabase.storage.from(SUPABASE_BUCKET).list(SUPABASE_PATH);
    if (files && files.length > 0) {
      const paths = files.map(f => `${SUPABASE_PATH}/${f.name}`);
      await supabase.storage.from(SUPABASE_BUCKET).remove(paths);
    }
    console.log('[WA] Supabase session cleared');
  } catch (e) {
    console.error('[WA] Failed to clear Supabase session:', e.message);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

let sock = null;
let status = 'disconnected'; // disconnected | connecting | qr_ready | connected
let latestQR = null;

const logger = pino({ level: 'silent' });

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

  // Restore saved session from Supabase before connecting
  await downloadSessionFromSupabase();

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['PrimeCash', 'Chrome', '120.0'],
  });

  // Save creds locally AND back up to Supabase on every update
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await uploadSessionToSupabase();
  });

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
        status = 'disconnected';
        try { await fs.rm(SESSION_DIR, { recursive: true, force: true }); } catch {}
        await clearSupabaseSession();
        console.log('[WA] Logged out — session cleared');
      } else {
        status = 'connecting';
        setTimeout(startSocket, 3000);
      }
    }
  });
}

// Health check — no auth needed (Render uses this)
app.get('/health', (req, res) => res.json({ ok: true, status }));

app.get('/status', async (req, res) => {
  if (status === 'disconnected') {
    startSocket().catch(console.error);
  }
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
  await clearSupabaseSession();
  res.json({ ok: true });
});

app.post('/send', async (req, res) => {
  if (status !== 'connected' || !sock) {
    return res.status(400).json({ error: `WhatsApp not connected (status: ${status})` });
  }
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });

  try {
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

app.post('/send-document', async (req, res) => {
  if (status !== 'connected' || !sock) {
    return res.status(400).json({ error: `WhatsApp not connected (status: ${status})` });
  }
  const { to, documentBase64, filename, caption, mimetype } = req.body;
  if (!to || !documentBase64) return res.status(400).json({ error: 'Missing to or documentBase64' });

  try {
    let phone = to.replace(/[^0-9]/g, '');
    if (phone.startsWith('0')) phone = '94' + phone.substring(1);
    else if (phone.length === 9) phone = '94' + phone;
    const jid = `${phone}@s.whatsapp.net`;

    const buffer = Buffer.from(documentBase64, 'base64');
    await sock.sendMessage(jid, {
      document: buffer,
      fileName: filename || 'document.pdf',
      mimetype: mimetype || 'application/pdf',
      caption,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[WA] Send document error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`WhatsApp microservice (Baileys) running on port ${PORT}`);
  startSocket().catch(console.error);
});
