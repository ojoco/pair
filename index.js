// ================================================
//  VANGUARD MD - Pairing Site (POLLING‑FIXED v8)
//  Stores code + creds in memory so bots can poll.
//  Uses correct HTTP status codes.
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

const BOT_IMAGE_PATH = path.join(__dirname, 'assets', 'botimage.jpg')

// ====================== SSE (unchanged) ======================
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

// ====================== CORE PAIRING ======================
async function startPairingSession(sessionId, phone, mode) {
  const sessionDir = path.join(__dirname, 'sessions', sessionId)
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })
  
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const { version } = await fetchLatestBaileysVersion()
  
  console.log(`[${sessionId}] 🚀 Starting socket for +${phone} (${mode} mode)`)
  
  const userJid = phone + '@s.whatsapp.net'
  
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
    mode,               // 'md' or 'max'
    credsReady: false,
    code: null,         // ★ STORE THE CODE
    credsBuffer: null,  // ★ STORE CREDS BUFFER (for MAX)
  }
  
  activeSessions.set(sessionId, session)
  
  setTimeout(async () => {
    if (session.pairingRequested || session.paired || state.creds.registered) return
    session.pairingRequested = true
    
    try {
      let code = await sock.requestPairingCode(phone)
      code = code?.match(/.{1,4}/g)?.join('-') || code
      session.code = code               // ★ save code in memory
      session.codeGenerated = true
      console.log(`[${sessionId}] ✅ Pairing code: ${code}`)
      sendToClients(sessionId, { code })
    } catch (err) {
      session.pairingRequested = false
      sendToClients(sessionId, { error: 'Could not get pairing code' })
    }
  }, 3000)
  
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update
    
    if (connection === 'open') {
      session.paired = true
      sendToClients(sessionId, { status: 'paired' })
      
      console.log(`[${sessionId}] ⏳ Waiting 8 seconds for creds.json...`)
      await delay(8000)
      
      const credsPath = path.join(sessionDir, 'creds.json')
      
      if (session.mode === 'md') {
        // MD: send Session ID to user (original behaviour)
        try {
          if (!fs.existsSync(credsPath)) throw new Error('creds.json not found')
          const vanguardSessionId = createSessionId(credsPath)
          console.log(`[${sessionId}] ✅ Session ID created (${vanguardSessionId.length} chars)`)
          
          await sock.sendMessage(session.userJid, { text: '⏳ *Generating Session ID...*' })
          await sock.sendMessage(session.userJid, { text: vanguardSessionId })
          
          const caption = 
            '╭───────────────━⊷\n' +
            '┃ 🔐 *VANGUARD MD SESSION ID* 🪪\n' +
            '╰───────────────━⊷\n' +
            '╭───────────────━⊷\n' +
            '┃ ✅ *Verified ,Active And Working!*\n' +
            '┃\n' +
            '┃ 📋 *Your Session ID above*\n' +
            '┃    Copy the ENTIRE message\n' +
            '┃\n' +
            '┃ 🚀 *Deploy instantly:*\n' +
            '┃    Paste in your .env file:\n' +
            '┃    SESSION_ID=your_id_here\n' +
            '┃\n' +
            '┃ 🔐 *Keep your Credentials secure*\n' +
            '┃    Do not share with untrusted persons!\n' +
            '┃\n' +
            '┃ 💡 *Need help?*\n' +
            '┃    https://whatsapp.com/channel/0029Vb6RoNb0bIdgZPwcst2Y\n' +
            '╰───────────────━⊷\n' +
            '> *_Made With Love By Admin Blue_*\n' +
            '> *_VANGUARD MD is on Fire 🔥_*'
          
          if (fs.existsSync(BOT_IMAGE_PATH)) {
            const imageBuffer = fs.readFileSync(BOT_IMAGE_PATH)
            await sock.sendMessage(session.userJid, { image: imageBuffer, caption })
          } else {
            await sock.sendMessage(session.userJid, { text: caption })
          }
          
          sendToClients(sessionId, { 
            status: 'done', 
            message: 'Session ID sent to your WhatsApp!',
            sessionIdLength: vanguardSessionId.length
          })
        } catch (err) {
          console.error(`[${sessionId}] ❌ Error: ${err.message}`)
          sendToClients(sessionId, { error: err.message })
          try {
            if (fs.existsSync(credsPath)) {
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
        // MAX mode: store creds buffer in memory
        try {
          if (fs.existsSync(credsPath)) {
            session.credsBuffer = fs.readFileSync(credsPath)   // ★ store buffer
            session.credsReady = true
            sendToClients(sessionId, { status: 'creds_ready', message: 'Credentials ready for download' })
            console.log(`[${sessionId}] Creds stored in memory for MAX download`)
          } else {
            sendToClients(sessionId, { error: 'creds.json not found after pairing' })
          }
        } catch (err) {
          sendToClients(sessionId, { error: 'Failed to read creds.json' })
        }
      }
      
      // Extended cleanup: 10 minutes for MD, 30 minutes for MAX (to allow download)
      const cleanupDelay = session.mode === 'max' ? 30 * 60 * 1000 : 10 * 60 * 1000
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

// ★ Get pairing code – returns 202 while waiting, 200 when ready
app.get('/getcode/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId)
  if (!session) return res.status(404).json({ error: 'Session not found' })
  
  if (session.code) {
    // Code already generated – send it and mark that we've served it (still keep session)
    const code = session.code
    // Don't delete the session yet; let it live until cleanup
    return res.json({ code })
  }
  
  if (session.paired) {
    // Already paired – no code will be generated
    return res.json({ status: 'already_paired' })
  }
  
  // Still generating – tell client to keep polling
  return res.status(202).json({ code: null })   // ★ 202 = "still processing"
})

// ★ Get credentials (MAX only) – returns 202 while not ready, 200 with creds when ready
app.get('/getcreds/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId)
  if (!session) return res.status(404).json({ error: 'Session not found' })
  if (session.mode !== 'max') return res.status(400).json({ error: 'Not a MAX session' })
  
  if (session.credsReady && session.credsBuffer) {
    // Return the stored buffer as base64
    const base64Creds = session.credsBuffer.toString('base64')
    // Do NOT cleanup – the bot may need to retry. Cleanup will happen later via timer.
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
  console.log(`🚀 VANGUARD MD Dual‑Mode Pairing Site (POLLING FIXED) LIVE → http://localhost:${PORT}`)
  console.log(`👑 MD mode: /generate | MAX mode: /generate-max`)
})
