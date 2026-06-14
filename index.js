const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const express = require('express')
const qrcode = require('qrcode')
const pino = require('pino')
const { createClient } = require('@supabase/supabase-js')

const app = express()
app.use(express.json())

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || ''
)

let sock = null
let qrCodeData = null
let isConnected = false

// QR Code page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Bindas AI — WA Server</title>
      <meta http-equiv="refresh" content="10">
      <style>
        body { background: #0a0a0a; color: #fff; font-family: sans-serif; text-align: center; padding: 40px; }
        h1 { color: #FFD700; }
        img { margin: 20px auto; display: block; }
        .status { padding: 10px 20px; border-radius: 8px; display: inline-block; margin: 10px; }
        .connected { background: #1a4a1a; color: #4ade80; }
        .disconnected { background: #4a1a1a; color: #f87171; }
      </style>
    </head>
    <body>
      <h1>🤖 Bindas AI — WhatsApp Server</h1>
      <div class="status ${isConnected ? 'connected' : 'disconnected'}">
        ${isConnected ? '✅ Connected' : '❌ Disconnected'}
      </div>
      ${qrCodeData && !isConnected ? `<img src="${qrCodeData}" width="300" /><p>WhatsApp → Linked Devices → Scan QR</p>` : ''}
      ${isConnected ? '<p>✅ WhatsApp connected and ready!</p>' : ''}
    </body>
    </html>
  `)
})

// Send message API
app.post('/api/send-message', async (req, res) => {
  const { phone, message } = req.body
  if (!sock || !isConnected) return res.json({ success: false, error: 'Not connected' })
  
  try {
    const jid = phone.replace('+', '') + '@s.whatsapp.net'
    await sock.sendMessage(jid, { text: message })
    res.json({ success: true })
  } catch (err) {
    res.json({ success: false, error: err.message })
  }
})

// Add to group API
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

// Status API
app.get('/api/status', (req, res) => {
  res.json({ connected: isConnected, qr: qrCodeData ? true : false })
})

// Start WhatsApp
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' })
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    
    if (qr) {
      qrCodeData = await qrcode.toDataURL(qr)
      isConnected = false
      console.log('QR Code generated — scan it!')
    }
    
    if (connection === 'close') {
      isConnected = false
      qrCodeData = null
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) {
        console.log('Reconnecting...')
        setTimeout(startWA, 3000)
      }
    }
    
    if (connection === 'open') {
      isConnected = true
      qrCodeData = null
      console.log('✅ WhatsApp Connected!')
    }
  })

  // New message received — save to Supabase for follow-up
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (!msg.key.remoteJid.includes('@s.whatsapp.net')) continue
      
      const phone = '+' + msg.key.remoteJid.replace('@s.whatsapp.net', '')
      
      // Save to Supabase wa_follow_up table
      if (supabase) {
        const { data } = await supabase
          .from('wa_follow_up')
          .select('id')
          .eq('phone', phone)
          .eq('status', 'pending')
          .single()
        
        if (!data) {
          await supabase.from('wa_follow_up').insert({
            phone,
            received_at: new Date().toISOString(),
            status: 'pending'
          })
          console.log('New lead saved:', phone)
        }
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)
}

startWA()

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Bindas WA Server running on port ${PORT}`))
