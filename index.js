// ================================================
//  VANGUARD MD — Official Pairing Site (RENDER FIXED v2)
//  Made with love by Mr.Admin Blue 2026 🔥
// ================================================
//install 

// ── Auto-install guard (Render loves this) ─────────────
;(() => {
  const { execSync } = require('child_process')
  const fs = require('fs')
  const path = require('path')
  if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
    console.log('\x1b[36m[VANGUARD PAIRING]\x1b[0m Dependencies missing. Installing...')
    execSync('npm install --legacy-peer-deps', { stdio: 'inherit' })
    console.log('\x1b[32m[✅ DONE]\x1b[0m Packages installed!')
  }
})()


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

// ====================== FIXED + RENDER-PROOF GENERATE ======================
app.post('/generate', async (req, res) => {
  const { phone } = req.body
  if (!phone || phone.length < 9) {
    return res.status(400).json({ error: 'Invalid phone number' })
  }

  const sessionId = `pair-${Date.now()}`
  const sessionDir = path.join(__dirname, 'sessions', sessionId)

  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const { version } = await fetchLatestBaileysVersion()

  console.log(`[${sessionId}] 🚀 Creating socket for +${phone}`)

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: { creds: state.creds, keys: state.keys },
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    markOnlineOnConnect: false,
    defaultQueryTimeoutMs: 90000,      // increased for Render
    connectTimeoutMs: 90000,
    keepAliveIntervalMs: 30000,        // helps on free tier
  })

  activeSessions.set(sessionId, { sock, phone, sessionDir })
  pairingRequested.set(sessionId, false)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update

    console.log(`[${sessionId}] connection.update → ${connection}`)

    // 🔥 RENDER-FIXED pairing request
    if (
      connection === 'connecting' &&
      !pairingRequested.get(sessionId) &&
      !state.creds.registered
    ) {
      pairingRequested.set(sessionId, true)
      console.log(`[${sessionId}] ⏳ Waiting 6 seconds (Render is slow)...`)

      await delay(6000)   // ← increased for Render free tier

      try {
        let code = await sock.requestPairingCode(phone)
        code = code?.match(/.{1,4}/g)?.join('-') || code

        console.log(`[${sessionId}] ✅ Pairing code generated: ${code}`)

        const clients = sseClients.get(sessionId) || []
        clients.forEach(client => {
          client.write(`data: ${JSON.stringify({ code })}\n\n`)
        })
      } catch (err) {
        console.error(`[${sessionId}] ❌ requestPairingCode failed:`, err.message)
        const clients = sseClients.get(sessionId) || []
        clients.forEach(client => {
          client.write(`data: ${JSON.stringify({ 
            error: 'WhatsApp rejected the request. Try a different number or wait 1 minute.' 
          })}\n\n`)
        })
      }
    }

    if (connection === 'open') {
      console.log(`[${sessionId}] ✅ Successfully paired for +${phone}`)
      // ... (same creds.json sending code as before) ...
      try {
        const credsPath = path.join(sessionDir, 'creds.json')
        if (fs.existsSync(credsPath)) {
          const buffer = fs.readFileSync(credsPath)
          const jid = phone + '@s.whatsapp.net'
          await sock.sendMessage(jid, {
            document: buffer,
            mimetype: 'application/json',
            fileName: 'creds.json',
            caption: `✅ *VANGUARD MD SESSION FILE*\n\nYour pairing was successful!\nSave this file...\n\nMade with love by Mr.Admin Blue 2026 🔥`
          })
        }
      } catch (e) { console.log('Failed to send creds:', e.message) }

      setTimeout(() => cleanupSession(sessionId, sock), 15000)
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode
      console.log(`[${sessionId}] ❌ Connection closed. Status: ${status} | Reason:`, lastDisconnect?.error?.message || 'unknown')

      // NO auto-reconnect on pairing site (we don't want infinite loops)
      if (status !== DisconnectReason.loggedOut && status !== 401) {
        console.log(`[${sessionId}] ♻️ Would have reconnected but skipping on pairing site`)
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  res.json({ success: true, sessionId })
})

function cleanupSession(sessionId, sock) {
  sock.end()
  activeSessions.delete(sessionId)
  sseClients.delete(sessionId)
  pairingRequested.delete(sessionId)
  try { fs.rmSync(path.join(__dirname, 'sessions', sessionId), { recursive: true, force: true }) } catch (_) {}
}

// ====================== Start ======================
app.listen(PORT, () => {
  console.log(`🚀 VANGUARD MD Pairing Site LIVE → http://localhost:${PORT}`)
  console.log(`👑 Made by Mr.Admin Blue 2026 | Render-optimized`)
})
