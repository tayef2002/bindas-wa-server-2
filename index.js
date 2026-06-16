const makeWASocket = require('@whiskeysockets/baileys').default
const { useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys')
const express = require('express')
const { createClient } = require('@supabase/supabase-js')
const { Boom } = require('@hapi/boom')
const QRCode = require('qrcode')
const P = require('pino')

const app = express()
app.use(express.json())

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || ''
)

let qrCodeData = null
let isConnected = false
let sock = null

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Bindas AI WA Server</title>
  <meta http-equiv="refresh" content="5">
  <style>
    body{background:#0a0a0a;color:#fff;font-family:sans-serif;text-align:center;padding:40px}
    h1{color:#FFD700;font-size:24px;margin-bottom:20px}
    .connected{background:#1a4a1a;color:#4ade80;padding:12px 28px;border-radius:8px;display:inline-block;font-size:16px}
    .waiting{background:#2a2a1a;color:#fbbf24;padding:12px 28px;border-radius:8px;display:inline-block;font-size:16px}
    .gen{background:#3a1a1a;color:#f87171;padding:12px 28px;border-radius:8px;display:inline-block;font-size:16px}
    img{margin:20px auto;display:block;border:3px solid #FFD700;border-radius:12px}
    p{color:#aaa;font-size:13px;margin-top:10px}
  </style>
</head>
<body>
  <h1>🤖 Bindas AI — WhatsApp Server</h1>
  ${isConnected
    ? '<div class="connected">✅ WhatsApp Connected!</div>'
    : qrCodeData
      ? `<div class="waiting">📱 QR Code Ready — Scan Now!</div><br><img src="${qrCodeData}" width="300"/><p>WhatsApp → Linked Devices → Link a Device → Scan QR</p>`
      : '<div class="gen">⏳ Starting... please wait (auto refresh every 5 sec)</div>'
  }
</body>
</html>`)
})

app.get('/api/status', (req, res) => res.json({ connected: isConnected }))

app.post('/api/send-message', async (req, res) => {
  if (!sock || !isConnected) return res.json({ success: false, error: 'Not connected' })
  try {
    const { phone, message } = req.body
    const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net'
    await sock.sendMessage(jid, { text: message })
    await supabase.from('wa_messages').insert({
      phone, message, direction: 'out', media_type: 'text',
      created_at: new Date().toISOString()
    })
    res.json({ success: true })
  } catch (err) {
    res.json({ success: false, error: err.message })
  }
})

async function startClient() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('/tmp/baileys_auth_v3')
    const logger = P({ level: 'silent' })

    sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      logger,
      printQRInTerminal: false,
      browser: ['Bindas AI', 'Safari', '1.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        console.log('QR received!')
        qrCodeData = await QRCode.toDataURL(qr)
        isConnected = false
      }

      if (connection === 'close') {
        isConnected = false
        qrCodeData = null
        const code = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : 0
        console.log('Disconnected, code:', code)
        if (code !== DisconnectReason.loggedOut) {
          setTimeout(startClient, 5000)
        }
      }

      if (connection === 'open') {
        console.log('WhatsApp Connected!')
        isConnected = true
        qrCodeData = null
      }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        if (msg.key.fromMe) continue
        if (!msg.message) continue

        const jid = msg.key.remoteJid || ''
        if (!jid.includes('@s.whatsapp.net')) continue

        const phone = '+' + jid.replace('@s.whatsapp.net', '')
        const body = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || '[media]'
        const name = msg.pushName || ''

        console.log('New message from:', phone, 'name:', name, ':', body)

        try {
          await supabase.from('wa_messages').insert({
            phone, message: body, direction: 'in', media_type: 'text',
            created_at: new Date().toISOString()
          })

          const { data: existing } = await supabase
            .from('wa_follow_up').select('id').eq('phone', phone).maybeSingle()

          if (!existing) {
            await supabase.from('wa_follow_up').insert({
              phone, name, received_at: new Date().toISOString(), status: 'pending'
            })
            console.log('New lead saved:', phone, name)
          } else {
            await supabase.from('wa_follow_up')
              .update({ received_at: new Date().toISOString(), name })
              .eq('phone', phone)
            console.log('Lead updated:', phone)
          }
        } catch (e) {
          console.log('DB error:', e.message)
        }
      }
    })

  } catch (e) {
    console.log('startClient error:', e.message)
    setTimeout(startClient, 5000)
  }
}

const PORT = process.env.PORT || 8080
app.listen(PORT, () => {
  console.log('Server running on port', PORT)
  startClient()
})
