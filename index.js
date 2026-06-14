const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const express = require('express')
const qrcode = require('qrcode')
const pino = require('pino')
const { createClient } = require('@supabase/supabase-js')
const path = require('path')
const fs = require('fs')

const app = express()
app.use(express.json())

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || ''
)

let sock = null
let qrCodeData = null
let isConnected = false
let isStarting = false

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Bindas AI WA Server</title>
      <meta http-equiv="refresh" content="5">
      <style>
        body{background:#0a0a0a;color:#fff;font-family:sans-serif;text-align:center;padding:40px}
        h1{color:#FFD700;font-size:24px;margin-bottom:20px}
        .status{padding:10px 24px;border-radius:8px;display:inline-block;margin:10px;font-size:14px}
        .connected{background:#1a4a1a;color:#4ade80}
        .disconnected{background:#4a1a1a;color:#f87171}
        .waiting{background:#2a2a1a;color:#fbbf24}
        img{margin:20px auto;display:block;border:2px solid #FFD700;border-radius:8px}
        p{color:#aaa;font-size:13px}
      </style>
    </head>
    <body>
      <h1>🤖 Bindas AI — WhatsApp Server</h1>
      ${isConnected 
        ? `<div class="status connected">✅ Connected & Ready</div>`
        : qrCodeData 
          ? `<div class="status waiting">⏳ Scan QR Code</div>
             <img src="${qrCodeData}" width="280" />
             <p>WhatsApp → Linked Devices → Link a Device → Scan</p>`
          : `<div class="status disconnected">⏳ Generating QR... (auto refresh)</div>`
      }
    </body>
    </html>
  `)
})

app.get('/api/status', (req, res) => {
  res.json({ connected: isConnected })
})

app.post('/api/send-message', async (req, res) => {
  const { phone, message } = req.body
  if (!sock || !isConnected) return res.json({ success: false, error: 'Not connected' })
  try {
    const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net'
    await sock.sendMessage(jid, { text: message })
    res.json({ success: true })
  } catch (err) {
    res.json({ success: false, error: err.message })
  }
})

app.post('/api/groups/:groupId/add', async (req, res) => {
  const { groupId } = req.params
  const { participants } = req.body
  if (!sock || !isConnected) return res.json({ success: false, error: 'Not connected' })
  try {
    const result = await sock.groupParticipantsUpdate(groupId, participants, 'add')
    res.json({ success: true, result })
  } catch (err) {
    res.json({ success: false, error: err.message })
  }
})

async function startWA() {
  if (isStarting) return
  isStarting = true

  try {
    const authDir = '/tmp/auth_info'
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(authDir)

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: 'silent' }),
      browser: ['Bindas AI', 'Chrome', '1.0.0']
    })

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        console.log('QR received, generating image...')
        qrCodeData = await qrcode.toDataURL(qr)
        isConnected = false
        console.log('QR ready — open browser to scan')
      }

      if (connection === 'close') {
        isConnected = false
        isStarting = false
        const code = lastDisconnect?.error?.output?.statusCode
        console.log('Connection closed, code:', code)
        if (code !== DisconnectReason.loggedOut) {
          console.log('Reconnecting in 3s...')
          setTimeout(startWA, 3000)
        } else {
          console.log('Logged out — clear auth and restart')
          qrCodeData = null
        }
      }

      if (connection === 'open') {
        isConnected = true
        qrCodeData = null
        isStarting = false
        console.log('✅ WhatsApp Connected!')
      }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        if (msg.key.fromMe) continue
        if (!msg.key.remoteJid?.includes('@s.whatsapp.net')) continue
        const phone = '+' + msg.key.remoteJid.replace('@s.whatsapp.net', '')
        console.log('New message from:', phone)
        try {
          const { data } = await supabase
            .from('wa_follow_up')
            .select('id')
            .eq('phone', phone)
            .eq('status', 'pending')
            .maybeSingle()
          if (!data) {
            await supabase.from('wa_follow_up').insert({
              phone,
              received_at: new Date().toISOString(),
              status: 'pending'
            })
            console.log('Lead saved:', phone)
          }
        } catch (e) {
          console.log('Supabase error:', e.message)
        }
      }
    })

    sock.ev.on('creds.update', saveCreds)

  } catch (err) {
    console.error('startWA error:', err)
    isStarting = false
    setTimeout(startWA, 5000)
  }
}

const PORT = process.env.PORT || 8080
app.listen(PORT, () => {
  console.log(`Bindas WA Server running on port ${PORT}`)
  startWA()
})
