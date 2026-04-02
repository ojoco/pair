// ================================================
//  VANGUARD MD - Pairing Site (PURE BASE64 v6)
//  Format: VANGUARD-MD;;;[pure Base64 of creds.json]
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

const BOT_IMAGE_PATH = path.join(__dirname, 'assets', 'botimage.jpg')

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
  if (!fs.existsSync(credsPath)) {
    throw new Error('creds.json not found')
  }
  
  const credsData = fs.readFileSync(credsPath)
  const base64Creds = credsData.toString('base64')
  
  // Simple format: VANGUARD-MD;;;[pure Base64]
  return `VANGUARD-MD;;;${base64Creds}`
}

// ====================== CORE PAIRING ======================
async function startPairingSession(sessionId, phone, res) {
  const sessionDir = path.join(__dirname, 'sessions', sessionId)
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })
  
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const { version } = await fetchLatestBaileysVersion()
  
  console.log(`[${sessionId}] 🚀 Starting socket for +${phone}`)
  
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
  }
  
  activeSessions.set(sessionId, session)
  
  setTimeout(async () => {
    if (session.pairingRequested || session.paired || state.creds.registered) return
    session.pairingRequested = true
    
    try {
      let code = await sock.requestPairingCode(phone)
      code = code?.match(/.{1,4}/g)?.join('-') || code
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
      sendToClients(sessionId, { status: 'paired', message: 'Generating Session ID...' })
      
      console.log(`[${sessionId}] ⏳ Waiting 8 seconds for creds.json...`)
      await delay(8000)
      
      try {
        const credsPath = path.join(sessionDir, 'creds.json')
        if (!fs.existsSync(credsPath)) throw new Error('creds.json not found')
        
        const vanguardSessionId = createSessionId(credsPath)
        console.log(`[${sessionId}] ✅ Session ID created (${vanguardSessionId.length} chars)`)
        
        // Send 3 messages
        await sock.sendMessage(session.userJid, { text: '⏳ *Generating Session ID...*' })
        await sock.sendMessage(session.userJid, { text: vanguardSessionId })
        
        const caption = 
          '╭───────────────━⊷\n' +
          '┃ 🔐 *VANGUARD MD SESSION*\n' +
          '╰───────────────━⊷\n' +
          '╭───────────────━⊷\n' +
          '┃ ✅ *Pairing Successful!*\n' +
          '┃\n' +
          '┃ 📋 *Your Session ID above*\n' +
          '┃    Copy the ENTIRE message\n' +
          '┃\n' +
          '┃ 🚀 *Deploy instantly:*\n' +
          '┃    Paste in your .env file:\n' +
          '┃    SESSION_ID=your_id_here\n' +
          '┃\n' +
          '┃ 💾 *Pure Base64 format*\n' +
          '┃    No expiry - No cloud!\n' +
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
        
        // Fallback
        try {
          const credsPath = path.join(sessionDir, 'creds.json')
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
      
      session.cleanupTimer = setTimeout(() => cleanupSession(sessionId), 15000)
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
        startPairingSession(sessionId, phone, null)
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

app.post('/generate', async (req, res) => {
  const { phone } = req.body
  if (!phone || phone.length < 9) {
    return res.status(400).json({ error: 'Invalid phone number' })
  }
  
  const cleanPhone = phone.replace(/[^0-9]/g, '')
  const sessionId = `pair-${Date.now()}`
  
  res.json({ success: true, sessionId })
  
  startPairingSession(sessionId, cleanPhone).catch(err => {
    sendToClients(sessionId, { error: 'Internal error' })
    cleanupSession(sessionId)
  })
})

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
  console.log(`🚀 VANGUARD MD Pairing Site LIVE -> http://localhost:${PORT}`)
  console.log(`👑 Pure Base64 v6 | Made by Mr.Admin Blue 2026`)
})
