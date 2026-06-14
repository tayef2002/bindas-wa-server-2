const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys')
const express = require('express')
const qrcode = require('qrcode')
const P = require('pino')
const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')

const app = express()
app.use(express.json())

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || ''
)

let qrCodeData = null
let isConnected = false

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Bindas AI WA Server</title>
  <meta http-equiv="refresh" content="3">
  <style>
    body{background:#0a0a0a;color:#fff;font-family:sans-serif;text-align:center;padding:40px}
    h1{color:#FFD700;font-size:24px;margin-bottom:20px}
    .connected{background:#1a4a1a;color:#4ade80;padding:10px 24px;border-radius:8px;display:inline-block}
    .waiting{background:#2a2a1a;color:#fbbf24;padding:10px 24px;border-radius:8px;display:inline-block}
    .gen{background:#3a1a1a;color:#f87171;padding:10px 24px;border-radius:8px;display:inline-block}
    img{margin:20px auto;display:block;border:2px solid #FFD700;border-radius:8px}
    p{color:#aaa;font-size:13px}
  </style>
</head>
<body>
  <h1>🤖 Bindas AI — WhatsApp Server</h1>
  ${isConnected
    ? '<div class="connected">✅ Connected!</div>'
    : qrCodeData
      ? `<div class="waiting">📱 Scan QR Code</div><br><img src="${qrCodeData}" width="280"/><p>WhatsApp → Linked Devices → Link a Device → Scan</p>`
      : '<div class="gen">⏳ Starting... please wait (auto refresh)</div>'
  }
</body>
</html>`)
})

app.get('/api/status', (req, res) => res.json({ connected: isConnected }))

async function start() {
  const authDir = '/tmp/wa_auth'
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const logger = P({ level: 'silent' })

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '22.04'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    emitOwnEvents: false,
    fireInitQueries: true,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false
  })

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('✅ QR generated!')
      qrCodeData = await qrcode.toDataURL(qr)
      isConnected = false
    }
    if (connection === 'open') {
      console.log('✅ WhatsApp Connected!')
      isConnected = true
      qrCodeData = null
    }
    if (connection === 'close') {
      isConnected = false
      const code = lastDisconnect?.error?.output?.statusCode
      console.log('Closed, code:', code)
      if (code !== DisconnectReason.loggedOut) {
        console.log('Restarting...')
        setTimeout(start, 5000)
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)
}

const PORT = process.env.PORT || 8080
app.listen(PORT, () => {
  console.log('Server on port', PORT)
  setTimeout(start, 2000)
})
