// ================================================
//  VANGUARD MD - Pairing Site (CREDS.JSON EDITION v3)
//  Fixed: Uploads creds.json only (no zip)
//  Sends: 1) Generating... 2) Session ID 3) Image+caption
//  Made with love by Mr.Admin Blue 2026 🔥
// ================================================
const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs')
const axios = require('axios')
const FormData = require('form-data')
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

// Path to your bot image (place botimage.jpg in assets folder)
const BOT_IMAGE_PATH = path.join(__dirname, 'assets', 'botimage.jpg')

// ====================== RANDOM STRING GEN ======================
function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function generateSessionId(shortcode) {
  const prefix = generateRandomString(100)
  const suffix = generateRandomString(100)
  return `VANGUARD-MD;;;${prefix}&${shortcode}&${suffix}`
}

// ====================== UPLOAD CREDS.JSON ONLY ======================
async function uploadCredsJson(credsPath) {
  try {
    if (!fs.existsSync(credsPath)) {
      throw new Error('creds.json not found at: ' + credsPath)
    }
    
    const stats = fs.statSync(credsPath)
    const fileSizeKB = stats.size / 1024
    console.log(`[UPLOAD] creds.json size: ${fileSizeKB.toFixed(2)} KB`)
    
    // Upload to Uguu - EXACT same logic as working upload.js
    const form = new FormData()
    form.append('files[]', fs.createReadStream(credsPath))
    
    const { data } = await axios({
      url: 'https://uguu.se/upload.php',
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...form.getHeaders(),
      },
      data: form,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 60000,
    })
    
    console.log('[UPLOAD] Uguu response:', JSON.stringify(data))
    
    // Extract URL - handle different response formats
    let url = ''
    if (typeof data === 'string') {
      url = data
    } else if (data.files && data.files[0]) {
      url = typeof data.files[0] === 'string' ? data.files[0] : (data.files[0].url || data.files[0].url_full || '')
    } else if (data.url) {
      url = data.url
    } else if (data[0] && data[0].url) {
      url = data[0].url
    }
    
    if (!url) {
      throw new Error('No URL in upload response: ' + JSON.stringify(data))
    }
    
    // Extract shortcode from URL
    // URL format: https://n.uguu.se/vmdbjBHy.json or https://uguu.se/f/vmdbjBHy.json
    const match = url.match(/\/([a-zA-Z0-9]+)\.json$/) || 
                  url.match(/\/f\/([a-zA-Z0-9]+)\.json$/) ||
                  url.match(/\/([a-zA-Z0-9]+)$/) ||  // No extension case
                  url.match(/\/f\/([a-zA-Z0-9]+)$/)
    const shortcode = match ? match[1] : null
    
    if (!shortcode) {
      throw new Error(`Could not extract shortcode from URL: ${url}`)
    }
    
    console.log(`[UPLOAD] Success! URL: ${url}, Shortcode: ${shortcode}`)
    return shortcode
    
  } catch (err) {
    console.error('[UPLOAD ERROR]', err.message)
    if (err.response) {
      console.error('[UPLOAD ERROR] Status:', err.response.status)
      console.error('[UPLOAD ERROR] Data:', err.response.data)
    }
    throw err
  }
}

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
  
  // Define userJid EARLY
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
    sessionIdSent: false,
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
      sendToClients(sessionId, { status: 'paired', message: 'Pairing successful! Generating Session ID...' })
      
      // ⏳ WAIT for creds.json to be written
      console.log(`[${sessionId}] ⏳ Waiting 8 seconds for creds.json...`)
      await delay(8000)
      
      try {
        const credsPath = path.join(sessionDir, 'creds.json')
        
        // Verify creds.json exists
        if (!fs.existsSync(credsPath)) {
          throw new Error('creds.json not found after waiting')
        }
        
        // 1. UPLOAD creds.json only
        console.log(`[${sessionId}] 📤 Uploading creds.json...`)
        const shortcode = await uploadCredsJson(credsPath)
        
        // 2. GENERATE Session ID
        const vanguardSessionId = generateSessionId(shortcode)
        console.log(`[${sessionId}] 🔐 Session ID generated`)
        
        // 3. SEND 3 MESSAGES TO USER'S WHATSAPP
        
        // Message 1: "Generating Session ID..."
        await sock.sendMessage(session.userJid, {
          text: '⏳ *Generating Session ID...*'
        })
        console.log(`[${sessionId}] 📤 Message 1 sent: Generating...`)
        
        // Message 2: Raw Session ID (easy copy)
        await sock.sendMessage(session.userJid, {
          text: vanguardSessionId
        })
        console.log(`[${sessionId}] 📤 Message 2 sent: Session ID`)
        
        // Message 3: Image with fancy caption (if image exists)
        const caption = 
          '╭───────────────━⊷\n' +
          '┃ 🔐 *VANGUARD MD SESSION*\n' +
          '╰───────────────━⊷\n' +
          '╭───────────────━⊷\n' +
          '┃ ✅ *Pairing Successful!*\n' +
          '┃\n' +
          '┃ 📋 *Your Session ID above*\n' +
          '┃    Copy it exactly as shown\n' +
          '┃\n' +
          '┃ 🚀 *Deploy instantly:*\n' +
          '┃    Paste in your .env file:\n' +
          '┃    SESSION_ID=your_id_here\n' +
          '┃\n' +
          '┃ ⚡ *IMPORTANT:*\n' +
          '┃    Deploy within 48 hours!\n' +
          '┃    Creds.json expires fast\n' +
          '┃\n' +
          '┃ 💡 *Need help?*\n' +
          '┃    https://whatsapp.com/channel/0029Vb6RoNb0bIdgZPwcst2Y\n' +
          '╰───────────────━⊷\n' +
          '> *_Made With Love By Admin Blue_*\n' +
          '> *_VANGUARD MD is on Fire 🔥_*'
        
        if (fs.existsSync(BOT_IMAGE_PATH)) {
          const imageBuffer = fs.readFileSync(BOT_IMAGE_PATH)
          await sock.sendMessage(session.userJid, {
            image: imageBuffer,
            caption: caption
          })
          console.log(`[${sessionId}] 📤 Message 3 sent: Image + caption`)
        } else {
          // Fallback: send text only if image not found
          await sock.sendMessage(session.userJid, { text: caption })
          console.log(`[${sessionId}] 📤 Message 3 sent: Text only (image not found)`)
        }
        
        // 4. Notify frontend
        sendToClients(sessionId, { 
          status: 'done', 
          message: 'Session ID sent to your WhatsApp! Check your DMs.',
          sessionId: vanguardSessionId 
        })
        
        session.sessionIdSent = true
        
      } catch (err) {
        console.error(`[${sessionId}] ❌ Session processing failed: ${err.message}`)
        sendToClients(sessionId, { 
          error: 'Session created but upload failed. Sending manual file...' 
        })
        
        // Fallback: Send creds.json directly as document
        try {
          const credsPath = path.join(sessionDir, 'creds.json')
          if (fs.existsSync(credsPath)) {
            const buffer = fs.readFileSync(credsPath)
            await sock.sendMessage(session.userJid, {
              document: buffer,
              mimetype: 'application/json',
              fileName: 'creds.json',
              caption: 
                '⚠️ *Upload Failed - Manual Session*\n\n' +
                'Save this creds.json to your bot /session folder.\n' +
                'Error: ' + err.message + '\n\n' +
                '> Made With Love By Admin Blue'
            })
            console.log(`[${sessionId}] 📤 Fallback: creds.json sent as document`)
          }
        } catch (fallbackErr) {
          console.error(`[${sessionId}] ❌ Fallback failed: ${fallbackErr.message}`)
          await sock.sendMessage(session.userJid, {
            text: '❌ Critical error: ' + err.message + '\nPlease try pairing again.'
          })
        }
      }
      
      // Cleanup after sending
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
  
  // Timeout if never paired
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
    if (session.cleanupTimer) clearTimeout(session.session.cleanupTimer)
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
  console.log(`👑 Creds.json Edition v3 | Made by Mr.Admin Blue 2026`)
  console.log(`📤 Uploads: creds.json only (no zip)`)
  console.log(`📸 Image path: ${BOT_IMAGE_PATH}`)
  console.log(`   (Place botimage.jpg in assets/ folder)`)
})
