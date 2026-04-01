// ================================================
//  VANGUARD MD — Official Pairing Site (Render)
//  Made with love by Mr.Admin Blue 2026
// ================================================

const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs')
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys')
const pino = require('pino')

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use(cors())
app.use(express.static(path.join(__dirname, 'public')))

const activeSessions = new Map() // sessionId → { sock, phone, sessionDir, sseClients }
const sseClients = new Map()     // sessionId → array of SSE responses

// ====================== SSE for real-time code ======================
app.get('/events', (req, res) => {
  const sessionId = req.query.sessionId
  if (!sessionId) return res.status(400).end()

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  if (!sseClients.has(sessionId)) sseClients.set(sessionId, [])
  sseClients.get(sessionId).push(res)

  // Keep alive
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000)

  req.on('close', () => {
    clearInterval(keepAlive)
    const clients = sseClients.get(sessionId)
    if (clients) {
      const idx = clients.indexOf(res)
      if (idx > -1) clients.splice(idx, 1)
    }
  })
})

// ====================== Generate Pair Code ======================
app.post('/generate', async (req, res) => {
  const { phone } = req.body
  if (!phone || phone.length < 9) {
    return res.status(400).json({ error: 'Invalid phone number' })
  }

  const sessionId = `pair-${Date.now()}`
  const sessionDir = path.join(__dirname, 'sessions', sessionId)

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true })
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: { creds: state.creds, keys: state.keys },
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    markOnlineOnConnect: false,
    defaultQueryTimeoutMs: 60000,
    connectTimeoutMs: 60000,
  })

  activeSessions.set(sessionId, { sock, phone, sessionDir })

  // ── Pairing code handler ──
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update

    if (connection === 'connecting' && !sock.authState.creds.registered) {
      try {
        let code = await sock.requestPairingCode(phone)
        code = code?.match(/.{1,4}/g)?.join('-') || code

        // Send to all SSE clients
        const clients = sseClients.get(sessionId) || []
        clients.forEach(client => {
          client.write(`data: ${JSON.stringify({ code })}\n\n`)
        })
      } catch (err) {}
    }

    if (connection === 'open') {
      console.log(`✅ [VANGUARD] Successfully paired for +${phone}`)

      // ── AUTO SEND creds.json TO THE USER ──
      try {
        const credsPath = path.join(sessionDir, 'creds.json')
        if (fs.existsSync(credsPath)) {
          const buffer = fs.readFileSync(credsPath)
          const jid = phone + '@s.whatsapp.net'

          await sock.sendMessage(jid, {
            document: buffer,
            mimetype: 'application/json',
            fileName: 'creds.json',
            caption: `✅ *VANGUARD MD SESSION FILE*\n\n` +
                     `Your pairing was successful!\n` +
                     `Save this file and put it inside your bot's "session" folder.\n` +
                     `Then restart your bot.\n\n` +
                     `Made with love by Mr.Admin Blue 2026 🔥`
          })
          console.log(`📤 creds.json sent to +${phone}`)
        }
      } catch (e) {
        console.log('Failed to send creds:', e.message)
      }

      // Cleanup after 15 seconds
      setTimeout(() => {
        sock.end()
        activeSessions.delete(sessionId)
        sseClients.delete(sessionId)
        // Delete temp session folder
        try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch (_) {}
      }, 15000)
    }

    // Your original reconnect magic (if WhatsApp kicks us)
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      if (statusCode !== DisconnectReason.loggedOut && statusCode !== 401) {
        console.log(`♻️ Reconnecting session ${sessionId}...`)
        // We let Baileys handle it automatically
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  res.json({ success: true, sessionId })
})

// ====================== Start Server ======================
app.listen(PORT, () => {
  console.log(`🚀 VANGUARD MD Pairing Site LIVE → http://localhost:${PORT}`)
  console.log(`👑 Made by Mr.Admin Blue 2026`)
})
