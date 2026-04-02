// ================================================
//  VANGUARD MD - Pairing Site (RAILWAY FIXED)
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
  delay,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys')
const pino = require('pino')

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use(cors())
app.use(express.static(path.join(__dirname, 'public')))

const activeSessions = new Map()
const sseClients = new Map()

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

// ====================== SSE HELPER ======================
function sendToClients(sessionId, data) {
  const clients = sseClients.get(sessionId) || []
  clients.forEach(client => {
    try {
      client.write(`data: ${JSON.stringify(data)}\n\n`)
    } catch (_) {}
  })
}

// ====================== CORE PAIRING FUNCTION ======================
async function startPairingSession(sessionId, phone, res) {
  const sessionDir = path.join(__dirname, 'sessions', sessionId)
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const { version } = await fetchLatestBaileysVersion()

  console.log(`[${sessionId}] 🚀 Starting socket for +${phone}`)

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    markOnlineOnConnect: false,
    defaultQueryTimeoutMs: 60000,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    syncFullHistory: false,
  })

  const session = {
    sock,
    phone,
    sessionDir,
    pairingRequested: false,
    paired: false,
    codeGenerated: false,
    reconnectAttempts: 0,
    maxReconnects: 5,
    cleanupTimer: null,
  }

  activeSessions.set(sessionId, session)

  // Request pairing code
  setTimeout(async () => {
    if (session.pairingRequested || session.paired || state.creds.registered) return
    session.pairingRequested = true
    console.log(`[${sessionId}] 🔑 Requesting pairing code for +${phone}`)
    try {
      let code = await sock.requestPairingCode(phone)
      code = code?.match(/.{1,4}/g)?.join('-') || code
      session.codeGenerated = true
      console.log(`[${sessionId}] ✅ Pairing code generated: ${code}`)
      sendToClients(sessionId, { code })
    } catch (err) {
      console.error(`[${sessionId}] ❌ requestPairingCode failed: ${err.message}`)
      session.pairingRequested = false
      sendToClients(sessionId, { error: 'Could not get pairing code. Retrying...' })
    }
  }, 3000)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update

    if (connection) {
      console.log(`[${sessionId}] connection.update -> ${connection}`)
    }

    if (connection === 'open') {
      session.paired = true
      session.reconnectAttempts = 0
      console.log(`[${sessionId}] 🎉 Successfully paired for +${phone}`)
      sendToClients(sessionId, { status: 'paired', message: 'Pairing successful! Sending session file...' })

      try {
        const credsPath = path.join(sessionDir, 'creds.json')
        if (fs.existsSync(credsPath)) {
          const buffer = fs.readFileSync(credsPath)
          await sock.sendMessage(phone + '@s.whatsapp.net', {
            document: buffer,
            mimetype: 'application/json',
            fileName: 'creds.json',
            caption:
              '✅ *VANGUARD MD SESSION FILE*\n\n' +
              'Pairing successful!\n' +
              'Save this creds.json to your bot /session folder.\n\n' +
              'Made with love by Mr.Admin Blue 2026 🔥'
          })
          sendToClients(sessionId, { status: 'done', message: 'Session file sent to your WhatsApp!' })
        }
      } catch (e) {
        console.error(`[${sessionId}] ❌ Failed to send creds: ${e.message}`)
      }

      session.cleanupTimer = setTimeout(() => cleanupSession(sessionId), 15000)
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode
      console.log(`[${sessionId}] ⚠️ Connection closed | Status: ${status}`)

      if (status === DisconnectReason.loggedOut) {
        console.log(`[${sessionId}] 🚫 Logged out - not reconnecting`)
        sendToClients(sessionId, { error: 'Session logged out. Please try again.' })
        cleanupSession(sessionId)
        return
      }

      if (session.paired) {
        console.log(`[${sessionId}] ✅ Already paired - close is fine`)
        return
      }

      if (session.reconnectAttempts < session.maxReconnects) {
        session.reconnectAttempts++
        const waitMs = session.reconnectAttempts * 3000
        console.log(`[${sessionId}] ♻️ Reconnecting (${session.reconnectAttempts}/${session.maxReconnects}) in ${waitMs / 1000}s...`)
        sendToClients(sessionId, { status: 'reconnecting', attempt: session.reconnectAttempts })

        await delay(waitMs)

        try { sock.end() } catch (_) {}
        activeSessions.delete(sessionId)

        startPairingSession(sessionId, phone, null)
      } else {
        console.log(`[${sessionId}] ❌ Max reconnects reached`)
        sendToClients(sessionId, { error: 'Connection failed after multiple retries. Please try again.' })
        cleanupSession(sessionId)
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  if (!session.cleanupTimer) {
    session.cleanupTimer = setTimeout(() => {
      if (!session.paired) {
        console.log(`[${sessionId}] ⏰ Timeout - cleaning up`)
        sendToClients(sessionId, { error: 'Timed out. Please try again.' })
        cleanupSession(sessionId)
      }
    }, 240000)
  }
}

// ====================== GENERATE ======================
app.post('/generate', async (req, res) => {
  const { phone } = req.body
  if (!phone || phone.length < 9) {
    return res.status(400).json({ error: 'Invalid phone number' })
  }

  const cleanPhone = phone.replace(/[^0-9]/g, '')
  const sessionId = `pair-${Date.now()}`

  res.json({ success: true, sessionId })

  startPairingSession(sessionId, cleanPhone).catch(err => {
    console.error(`[${sessionId}] 💥 Fatal error: ${err.message}`)
    sendToClients(sessionId, { error: 'Internal error. Please try again.' })
    cleanupSession(sessionId)
  })
})

// ====================== CLEANUP ======================
function cleanupSession(sessionId) {
  const session = activeSessions.get(sessionId)
  if (session) {
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer)
    try { session.sock.end() } catch (_) {}
    try {
      fs.rmSync(session.sessionDir, { recursive: true, force: true })
    } catch (_) {}
    activeSessions.delete(sessionId)
  }
  sseClients.delete(sessionId)
  console.log(`[${sessionId}] 🗑️ Session cleaned up`)
}

// ====================== START ======================
app.listen(PORT, () => {
  console.log(`🚀 VANGUARD MD Pairing Site LIVE -> http://localhost:${PORT}`)
  console.log(`👑 Railway optimized | Made by Mr.Admin Blue 2026`)
})
