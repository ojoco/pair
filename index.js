// ================================================
//  VANGUARD MD — Pairing Site (RENDER FREE-TIER FIXED v3)
//  Made with love by Mr.Admin Blue 2026 🔥
// ================================================

const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs')
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion, 
  DisconnectReason,
  delay 
} = require('@whiskeysockets/baileys')
const pino = require('pino')

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use(cors())
app.use(express.static(path.join(__dirname, 'public')))

const activeSessions = new Map()
const sseClients = new Map()
const pairingRequested = new Map()

// ====================== SSE ======================
app.get('/events', (req, res) => {
  const sessionId = req.query.sessionId
  if (!sessionId) return res.status(400).end()

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  if (!sseClients.has(sessionId)) sseClients.set(sessionId, [])
  sseClients.get(sessionId).push(res)

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000)

  req.on('close', () => {
    clearInterval(keepAlive)
    const clients = sseClients.get(sessionId)
    if (clients) {
      const idx = clients.indexOf(res)
      if (idx > -1) clients.splice(idx, 1)
    }
  })
})

// ====================== RENDER-FREE-TIER PROOF ======================
app.post('/generate', async (req, res) => {
  const { phone } = req.body
  if (!phone || phone.length < 9) return res.status(400).json({ error: 'Invalid phone number' })

  const sessionId = `pair-${Date.now()}`
  const sessionDir = path.join(__dirname, 'sessions', sessionId)
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const { version } = await fetchLatestBaileysVersion()

  console.log(`[${sessionId}] 🚀 Starting socket for +${phone}`)

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: { creds: state.creds, keys: state.keys },
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    markOnlineOnConnect: false,
    defaultQueryTimeoutMs: 120000,
    connectTimeoutMs: 120000,
    keepAliveIntervalMs: 30000,
  })

  activeSessions.set(sessionId, { sock, phone, sessionDir })
  pairingRequested.set(sessionId, false)

  let codeSent = false

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update
    console.log(`[${sessionId}] connection.update → ${connection || 'undefined'}`)

    // ── Request pairing code once ──
    if (
      connection === 'connecting' &&
      !pairingRequested.get(sessionId) &&
      !state.creds.registered
    ) {
      pairingRequested.set(sessionId, true)
      console.log(`[${sessionId}] ⏳ Waiting 8 seconds (Render free tier is slow)...`)
      await delay(8000)

      try {
        let code = await sock.requestPairingCode(phone)
        code = code?.match(/.{1,4}/g)?.join('-') || code
        codeSent = true

        console.log(`[${sessionId}] ✅ Pairing code generated: ${code}`)
        const clients = sseClients.get(sessionId) || []
        clients.forEach(client => client.write(`data: ${JSON.stringify({ code })}\n\n`))
      } catch (err) {
        console.error(`[${sessionId}] ❌ requestPairingCode failed:`, err.message)
        const clients = sseClients.get(sessionId) || []
        clients.forEach(client => client.write(`data: ${JSON.stringify({ error: 'WhatsApp rejected request. Try again in 30 seconds.' })}\n\n`))
      }
    }

    if (connection === 'open') {
      console.log(`[${sessionId}] 🎉 Successfully paired for +${phone}`)
      // send creds.json (same as before)
      try {
        const credsPath = path.join(sessionDir, 'creds.json')
        if (fs.existsSync(credsPath)) {
          const buffer = fs.readFileSync(credsPath)
          await sock.sendMessage(phone + '@s.whatsapp.net', {
            document: buffer,
            mimetype: 'application/json',
            fileName: 'creds.json',
            caption: `✅ *VANGUARD MD SESSION FILE*\n\nPairing successful!\nSave this file...\n\nMade with love by Mr.Admin Blue 2026 🔥`
          })
        }
      } catch (e) {}
      setTimeout(() => cleanupSession(sessionId, sock), 10000)
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode
      console.log(`[${sessionId}] ❌ Connection closed | Status: ${status}`)
      if (!codeSent && status !== DisconnectReason.loggedOut) {
        console.log(`[${sessionId}] 🔄 Still waiting for pairing... (will stay alive 4 minutes)`)
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // 🔥 Keep session alive for 4 minutes even if no 'open' yet
  setTimeout(() => {
    if (!codeSent || !activeSessions.has(sessionId)) return
    console.log(`[${sessionId}] ⏰ 4-minute timeout reached → cleaning up`)
    cleanupSession(sessionId, sock)
  }, 240000)

  res.json({ success: true, sessionId })
})

function cleanupSession(sessionId, sock) {
  try { sock.end() } catch (_) {}
  activeSessions.delete(sessionId)
  sseClients.delete(sessionId)
  pairingRequested.delete(sessionId)
  try {
    fs.rmSync(path.join(__dirname, 'sessions', sessionId), { recursive: true, force: true })
  } catch (_) {}
}

// ====================== Start ======================
app.listen(PORT, () => {
  console.log(`🚀 VANGUARD MD Pairing Site LIVE → http://localhost:${PORT}`)
  console.log(`👑 Free-tier optimized | Made by Mr.Admin Blue 2026`)
})
