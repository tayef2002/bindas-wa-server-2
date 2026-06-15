const { Client, LocalAuth } = require('whatsapp-web.js')
const express = require('express')
const qrcode = require('qrcode')
const { createClient } = require('@supabase/supabase-js')

const app = express()
app.use(express.json())

// CORS — allow all origins
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
let client = null

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
  if (!client || !isConnected) return res.json({ success: false, error: 'Not connected' })
  try {
    const { phone, message } = req.body
    const chatId = phone.replace(/\D/g, '') + '@c.us'
    await client.sendMessage(chatId, message)
    
    // Save outgoing message
    await supabase.from('wa_messages').insert({
      phone,
      message,
      direction: 'out',
      media_type: 'text',
      created_at: new Date().toISOString()
    })
    
    res.json({ success: true })
  } catch (err) {
    res.json({ success: false, error: err.message })
  }
})

function startClient() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/tmp/wa_session' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    }
  })

  client.on('qr', async (qr) => {
    console.log('✅ QR received!')
    qrCodeData = await qrcode.toDataURL(qr)
    isConnected = false
  })

  client.on('ready', () => {
    console.log('✅ WhatsApp Connected!')
    isConnected = true
    qrCodeData = null
  })

  client.on('disconnected', (reason) => {
    console.log('Disconnected:', reason)
    isConnected = false
    qrCodeData = null
    setTimeout(startClient, 5000)
  })

  client.on('message', async (msg) => {
    if (msg.fromMe) return
    const phone = '+' + msg.from.replace('@c.us', '')
    const body = msg.body || ''
    console.log('New message from:', phone, ':', body)
    try {
      // Save to wa_messages
      await supabase.from('wa_messages').insert({
        phone,
        message: body,
        direction: 'in',
        media_type: msg.type || 'text',
        created_at: new Date().toISOString()
      })

      // Save lead if not exists
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
      console.log('DB error:', e.message)
    }
  })

  client.initialize()
}

const PORT = process.env.PORT || 8080
app.listen(PORT, () => {
  console.log('Server running on port', PORT)
  startClient()
})
