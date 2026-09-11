// ================================================
//  VANGUARD MD — Pairing Site v14
//  MD | MAX | QR | QR-MAX
//  QR-MAX: QR capture + creds buffer (no DM)
//
//  REVISION:
//   • Waits for creds.json to be COMPLETE before exposing them.
//     Baileys writes `me.id` early and flips `registered: true`
//     a moment later — clients that consumed the buffer too soon
//     got "half creds" and had to heal them.
//   • Heals `registered: true` in-place if the flag is still
//     false after a grace period. Writes the healed copy back
//     to disk so downstream consumers always see valid creds.
//   • Hard-rejects creds missing me.id (pairing never completed).
//   • Fixed userJid construction (was doing a weird string
//     replace; now clean `phone@s.whatsapp.net`).
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

// ====================== MODE HELPERS ======================
const isQrMode    = (mode) => mode === 'qr' || mode === 'qr-max'
const isDmMode    = (mode) => mode === 'md' || mode === 'qr'        // sends session ID via DM
const isCredsMode = (mode) => mode === 'max' || mode === 'qr-max'   // stores creds buffer for polling

// ====================== CREDS COMPLETENESS ======================
// Baileys produces `me.id` early but flips `registered: true` a
// beat later. A creds.json is only safe to export when BOTH are set.
function isCredsComplete(creds) {
  return Boolean(creds && creds.me && creds.me.id && creds.registered === true)
}

function isCredsUsable(creds) {
  // Identity alone is enough for Baileys to connect; `registered`
  // only guards the pair-prompt. If identity exists we can heal.
  return Boolean(creds && creds.me && creds.me.id)
}

// Read + heal creds.json. Returns parsed object or null.
// Writes the healed copy back to disk so future restarts are clean.
async function readAndHealCreds(credsPath, { maxWaitMs = 15000 } = {}) {
  const start = Date.now()
  let last = null

  while (Date.now() - start < maxWaitMs) {
    if (fs.existsSync(credsPath)) {
      try {
        last = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
      } catch (_) { last = null }
    }

    // Fully complete — done immediately
    if (isCredsComplete(last)) return last

    // Identity present but flag missing — wait a bit longer in
    // case Baileys is about to flip it on its own.
    if (isCredsUsable(last) && Date.now() - start > 4000) {
      last.registered = true
      try { fs.writeFileSync(credsPath, JSON.stringify(last, null, 2)) } catch (_) {}
      return last
    }

    await delay(400)
  }

  // Timed out — if we at least have identity, heal and return.
  if (isCredsUsable(last)) {
    last.registered = true
    try { fs.writeFileSync(credsPath, JSON.stringify(last, null, 2)) } catch (_) {}
    return last
  }
  return null
}

// ====================== CORE PAIRING ======================
async function startPairingSession(sessionId, phone, mode) {
  // mode: 'md' | 'max' | 'qr' | 'qr-max'
  const sessionDir = path.join(__dirname, 'sessions', sessionId)
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const { version } = await fetchLatestBaileysVersion()

  console.log(`[${sessionId}] 🚀 Starting socket (${mode} mode)${phone ? ' +' + phone : ''}`)

  const userJid = phone ? `${phone}@s.whatsapp.net` : null

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

  // ── Pairing code request only for md/max (not QR-based modes) ──
  if (!isQrMode(mode)) {
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

    // ── QR capture for qr and qr-max ──
    if (qr && isQrMode(mode)) {
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

      // Resolve user JID for QR-based modes (scanner's account)
      if (!session.userJid && sock.authState?.creds?.me?.id) {
        session.userJid = sock.authState.creds.me.id.split(':')[0] + '@s.whatsapp.net'
        console.log(`[${sessionId}] 👤 QR user JID resolved: ${session.userJid}`)
      }

      console.log(`[${sessionId}] ⏳ Waiting for complete creds.json...`)
      const credsPath = path.join(sessionDir, 'creds.json')

      // ── Wait for + heal creds ──
      const creds = await readAndHealCreds(credsPath, { maxWaitMs: 20000 })

      if (!creds) {
        console.error(`[${sessionId}] ❌ Creds never became usable`)
        sendToClients(sessionId, { error: 'Pairing produced incomplete creds — please retry' })
        // Do NOT cleanup — let the session poller time out naturally
        return
      }

      if (!isCredsComplete(creds)) {
        // Shouldn't happen — readAndHealCreds guarantees this — but
        // if it does, don't ship broken creds downstream.
        console.error(`[${sessionId}] ❌ Creds still incomplete after heal`)
        sendToClients(sessionId, { error: 'Creds healing failed' })
        return
      }

      console.log(`[${sessionId}] ✅ Creds complete (me.id=${creds.me.id}, registered=${creds.registered})`)

      // Always have a fresh on-disk copy for the DM path
      let credsBuffer = null
      try { credsBuffer = fs.readFileSync(credsPath) } catch (_) {}

      if (isDmMode(mode)) {
        // ── md & qr: send session ID via DM ──
        try {
          if (!credsBuffer) throw new Error('creds.json not found')

          const vanguardSessionId = `VANGUARD-MD;;;${credsBuffer.toString('base64')}`
          console.log(`[${sessionId}] ✅ Session ID created (${vanguardSessionId.length} chars)`)

          // For qr, also stash creds buffer for any polling consumers
          if (mode === 'qr') {
            session.credsBuffer = credsBuffer
            session.credsReady = true
          }

          await sock.sendMessage(session.userJid, {
            text: '⏳ *Generating Session ID...*'
          })

          await sock.sendMessage(session.userJid, {
            text: vanguardSessionId
          })

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
            if (credsBuffer && session.userJid) {
              await sock.sendMessage(session.userJid, {
                document: credsBuffer,
                mimetype: 'application/json',
                fileName: 'creds.json',
                caption: '⚠️ Fallback: Save to /session folder'
              })
            }
          } catch (_) {}
        }
      } else if (isCredsMode(mode)) {
        // ── max & qr-max: store creds buffer for polling, no DM ──
        try {
          if (credsBuffer) {
            session.credsBuffer = credsBuffer
            session.credsReady = true
            sendToClients(sessionId, { status: 'creds_ready', message: 'Credentials ready for download' })
            console.log(`[${sessionId}] Creds stored in memory (healed)`)
          } else {
            sendToClients(sessionId, { error: 'creds.json not found after pairing' })
          }
        } catch (err) {
          sendToClients(sessionId, { error: 'Failed to read creds.json' })
        }
      }

      const cleanupDelay = isDmMode(mode) ? 10 * 60 * 1000 : 30 * 60 * 1000
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

// QR mode (standalone — sends session ID via DM)
app.post('/generate-qr', async (req, res) => {
  const sessionId = `pairqr-${Date.now()}`
  res.json({ success: true, sessionId })
  startPairingSession(sessionId, null, 'qr').catch(err => {
    sendToClients(sessionId, { error: 'Internal error' })
    cleanupSession(sessionId)
  })
})

// QR-MAX mode (dashboard — no DM, creds buffer only)
app.post('/generate-qr-max', async (req, res) => {
  const sessionId = `pairqrmax-${Date.now()}`
  res.json({ success: true, sessionId })
  startPairingSession(sessionId, null, 'qr-max').catch(err => {
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

// QR polling — accepts qr and qr-max
app.get('/getqr/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId)
  if (!session) return res.status(404).json({ error: 'Session not found' })
  if (!isQrMode(session.mode)) return res.status(400).json({ error: 'Not a QR session' })

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

// Credentials polling — accepts max and qr-max
app.get('/getcreds/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId)
  if (!session) return res.status(404).json({ error: 'Session not found' })
  if (!isCredsMode(session.mode)) {
    return res.status(400).json({ error: 'Not a MAX/QR-MAX session' })
  }

  // Only hand out creds once they've been validated as complete.
  // If paired but creds not yet ready, tell the client to keep
  // polling — never ship a partial buffer.
  if (session.credsReady && session.credsBuffer) {
    const base64Creds = session.credsBuffer.toString('base64')
    return res.json({ success: true, creds: base64Creds })
  }
  if (session.paired) {
    return res.status(202).json({ status: 'preparing_creds' })
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
  console.log(`🚀 VANGUARD MD Pairing Site v14 LIVE → http://localhost:${PORT}`)
  console.log(`👑 MD: /generate | MAX: /generate-max`)
  console.log(`👑 QR: /generate-qr | QR-MAX: /generate-qr-max`)
})
