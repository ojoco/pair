// ================================================
//  VANGUARD MD - Pairing Site v10
//  MD mode | MAX mode | QR mode
//  MD now sends session ID with copy button (no image)
// ================================================
const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs')
const QRCode = require('qrcode')
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

function sendToClients(sessionId, data) {
  const clients = sseClients.get(sessionId) || []
  clients.forEach(client => {
    try {
      client.write(`data: ${JSON.stringify(data)}\n\n`)
    } catch (_) {}
  })
}

// ====================== CREATE SESSION ID ======================
function createSessionId(credsPath) {
  if (!fs.existsSync(credsPath)) throw new Error('creds.json not found')
  const credsData = fs.readFileSync(credsPath)
  const base64Creds = credsData.toString('base64')
  return `VANGUARD-MD;;;${base64Creds}`
}

// ====================== QR → data URL ======================
async function renderQrDataUrl(rawQr) {
  return QRCode.toDataURL(rawQr, {
    errorCorrectionLevel: 'M',
    type: 'image/png',
    quality: 0.92,
    margin: 1,
    color: { dark: '#000000', light: '#FFFFFF' }
  })
}

// ====================== CORE PAIRING ======================
async function startPairingSession(sessionId, phone, mode) {
  // mode: 'md' | 'max' | 'qr'
  const sessionDir = path.join(__dirname, 'sessions', sessionId)
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const { version } = await fetchLatestBaileysVersion()

  console.log(`[${sessionId}] 🚀 Starting socket (${mode} mode)${phone ? ' +' + phone : ''}`)

  const userJid = phone ? phone + '@s.whatsapp.net' : null

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
    userJid,
    sessionDir,
    pairingRequested: false,
    paired: false,
    codeGenerated: false,
    reconnectAttempts: 0,
    maxReconnects: 5,
    cleanupTimer: null,
    mode,
    credsReady: false,
    code: null,
    credsBuffer: null,
    qr: null,
    qrDataUrl: null,
    qrVersion: 0,
  }

  activeSessions.set(sessionId, session)

  // ── Pairing code request ONLY for md/max modes ──
  if (mode !== 'qr') {
    setTimeout(async () => {
      if (session.pairingRequested || session.paired || state.creds.registered) return
      session.pairingRequested = true

      try {
        let code = await sock.requestPairingCode(phone)
        code = code?.match(/.{1,4}/g)?.join('-') || code
        session.code = code
        session.codeGenerated = true
        console.log(`[${sessionId}] ✅ Pairing code: ${code}`)
        sendToClients(sessionId, { code })
      } catch (err) {
        session.pairingRequested = false
        sendToClients(sessionId, { error: 'Could not get pairing code' })
      }
    }, 3000)
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    // ── QR mode: capture QR and render server-side ──
    if (qr && mode === 'qr') {
      try {
        session.qr = qr
        session.qrVersion++
        session.qrDataUrl = await renderQrDataUrl(qr)
        console.log(`[${sessionId}] 🎯 QR v${session.qrVersion} rendered`)
        sendToClients(sessionId, {
          qr: session.qrDataUrl,
          qrVersion: session.qrVersion
        })
      } catch (qrErr) {
        console.error(`[${sessionId}] QR render failed:`, qrErr.message)
        sendToClients(sessionId, { error: 'Failed to render QR code' })
      }
    }

    if (connection === 'open') {
      session.paired = true
      sendToClients(sessionId, { status: 'paired' })

      console.log(`[${sessionId}] ⏳ Waiting 8 seconds for creds.json...`)
      await delay(8000)

      const credsPath = path.join(sessionDir, 'creds.json')

      if (mode === 'md') {
        // ── MD: session ID with copy button, no image ──
        try {
          if (!fs.existsSync(credsPath)) throw new Error('creds.json not found')
          const vanguardSessionId = createSessionId(credsPath)
          console.log(`[${sessionId}] ✅ Session ID created (${vanguardSessionId.length} chars)`)

          // 1. Generating status
          await sock.sendMessage(session.userJid, {
            text: '⏳ *Generating Session ID...*'
          })

          // 2. Session ID with copy button
          await sock.sendMessage(session.userJid, {
            text: vanguardSessionId,
            nativeFlow: [
              { text: '📋 Copy Session ID', copy: vanguardSessionId }
            ]
          })

          // 3. Simple card below
          await sock.sendMessage(session.userJid, {
            text:
              '╔═══━───━━━─═══╗\n' +
              '        ✅SESSION ID\n' +
              '╚═══━───━━━─═══╝\n' +
              '╔═══━───━━━─═══╗\n' +
              ' 》🟢Verified  \n' +
              ' 》🔐Secure \n' +
              ' 》🧑‍💻Base64\n' +
              '╚═══━───━━━─═══╝'
          })

          sendToClients(sessionId, {
            status: 'done',
            message: 'Session ID sent to your WhatsApp!',
            sessionIdLength: vanguardSessionId.length
          })
        } catch (err) {
          console.error(`[${sessionId}] ❌ Error: ${err.message}`)
          sendToClients(sessionId, { error: err.message })
          try {
            if (fs.existsSync(credsPath) && session.userJid) {
              const buffer = fs.readFileSync(credsPath)
              await sock.sendMessage(session.userJid, {
                document: buffer,
                mimetype: 'application/json',
                fileName: 'creds.json',
                caption: '⚠️ Fallback: Save to /session folder'
              })
            }
          } catch (_) {}
        }
      } else {
        // MAX + QR: store creds buffer for polling download
        try {
          if (fs.existsSync(credsPath)) {
            session.credsBuffer = fs.readFileSync(credsPath)
            session.credsReady = true
            sendToClients(sessionId, { status: 'creds_ready', message: 'Credentials ready for download' })
            console.log(`[${sessionId}] Creds stored in memory`)
          } else {
            sendToClients(sessionId, { error: 'creds.json not found after pairing' })
          }
        } catch (err) {
          sendToClients(sessionId, { error: 'Failed to read creds.json' })
        }
      }

      const cleanupDelay = mode === 'md' ? 10 * 60 * 1000 : 30 * 60 * 1000
      session.cleanupTimer = setTimeout(() => cleanupSession(sessionId), cleanupDelay)
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode

      if (status === DisconnectReason.loggedOut) {
        sendToClients(sessionId, { error: 'Session logged out' })
        cleanupSession(sessionId)
        return
      }

      if (session.paired) return

      if (session.reconnectAttempts < session.maxReconnects) {
        session.reconnectAttempts++
        const waitMs = session.reconnectAttempts * 3000
        sendToClients(sessionId, { status: 'reconnecting', attempt: session.reconnectAttempts })
        await delay(waitMs)
        try { sock.end() } catch (_) {}
        activeSessions.delete(sessionId)
        startPairingSession(sessionId, phone, mode)
      } else {
        sendToClients(sessionId, { error: 'Max retries reached' })
        cleanupSession(sessionId)
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  if (!session.cleanupTimer) {
    session.cleanupTimer = setTimeout(() => {
      if (!session.paired) {
        sendToClients(sessionId, { error: 'Timed out' })
        cleanupSession(sessionId)
      }
    }, 240000)
  }
}

// ====================== ENDPOINTS ======================

// MD mode
app.post('/generate', async (req, res) => {
  const { phone } = req.body
  if (!phone || phone.length < 9) {
    return res.status(400).json({ error: 'Invalid phone number' })
  }
  const cleanPhone = phone.replace(/[^0-9]/g, '')
  const sessionId = `pair-${Date.now()}`
  res.json({ success: true, sessionId })
  startPairingSession(sessionId, cleanPhone, 'md').catch(err => {
    sendToClients(sessionId, { error: 'Internal error' })
    cleanupSession(sessionId)
  })
})

// MAX mode
app.post('/generate-max', async (req, res) => {
  const { phone } = req.body
  if (!phone || phone.length < 9) {
    return res.status(400).json({ error: 'Invalid phone number' })
  }
  const cleanPhone = phone.replace(/[^0-9]/g, '')
  const sessionId = `pairmax-${Date.now()}`
  res.json({ success: true, sessionId })
  startPairingSession(sessionId, cleanPhone, 'max').catch(err => {
    sendToClients(sessionId, { error: 'Internal error' })
    cleanupSession(sessionId)
  })
})

// QR mode (no phone)
app.post('/generate-qr', async (req, res) => {
  const sessionId = `pairqr-${Date.now()}`
  res.json({ success: true, sessionId })
  startPairingSession(sessionId, null, 'qr').catch(err => {
    sendToClients(sessionId, { error: 'Internal error' })
    cleanupSession(sessionId)
  })
})

// Pairing code polling
app.get('/getcode/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId)
  if (!session) return res.status(404).json({ error: 'Session not found' })

  if (session.code) {
    return res.json({ code: session.code })
  }
  if (session.paired) {
    return res.json({ status: 'already_paired' })
  }
  return res.status(202).json({ code: null })
})

// QR polling
app.get('/getqr/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId)
  if (!session) return res.status(404).json({ error: 'Session not found' })
  if (session.mode !== 'qr') return res.status(400).json({ error: 'Not a QR session' })

  if (session.qrDataUrl) {
    return res.json({
      qr: session.qrDataUrl,
      qrVersion: session.qrVersion
    })
  }
  if (session.paired) {
    return res.json({ status: 'already_paired' })
  }
  return res.status(202).json({ qr: null })
})

// Credentials polling — works for BOTH max and qr modes
app.get('/getcreds/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId)
  if (!session) return res.status(404).json({ error: 'Session not found' })
  if (session.mode !== 'max' && session.mode !== 'qr') {
    return res.status(400).json({ error: 'Not a MAX/QR session' })
  }

  if (session.credsReady && session.credsBuffer) {
    const base64Creds = session.credsBuffer.toString('base64')
    return res.json({ success: true, creds: base64Creds })
  }
  if (session.paired) {
    return res.json({ status: 'already_paired', message: 'Waiting for creds file to be read...' })
  }
  return res.status(202).json({ status: 'generating' })
})

// ====================== CLEANUP ======================
function cleanupSession(sessionId) {
  const session = activeSessions.get(sessionId)
  if (session) {
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer)
    try { session.sock.end() } catch (_) {}
    try { fs.rmSync(session.sessionDir, { recursive: true, force: true }) } catch (_) {}
    activeSessions.delete(sessionId)
  }
  sseClients.delete(sessionId)
}

app.listen(PORT, () => {
  console.log(`🚀 VANGUARD MD Pairing Site v10 LIVE → http://localhost:${PORT}`)
  console.log(`👑 MD: /generate | MAX: /generate-max | QR: /generate-qr`)
})
