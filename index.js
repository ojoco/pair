// ================================================
//  VANGUARD MD - Pairing Site (SESSION ID EDITION v2)
//  Fixed: Upload logic + userJid scope
//  Made with love by Mr.Admin Blue 2026 🔥
// ================================================
const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs')
const axios = require('axios')
const FormData = require('form-data')
const AdmZip = require('adm-zip')
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

// ====================== ZIP & UPLOAD (FIXED) ======================
async function zipAndUploadSession(sessionDir) {
  try {
    // Create zip of entire session folder
    const zip = new AdmZip()
    zip.addLocalFolder(sessionDir)
    
    const zipPath = path.join(__dirname, `vanguard_session_${Date.now()}.zip`)
    zip.writeZip(zipPath)
    
    // Check file size (Uguu limit ~100MB usually)
    const stats = fs.statSync(zipPath)
    const fileSizeMB = stats.size / (1024 * 1024)
    console.log(`[ZIP] Created: ${zipPath} (${fileSizeMB.toFixed(2)} MB)`)
    
    if (fileSizeMB > 100) {
      throw new Error(`Zip file too large: ${fileSizeMB.toFixed(2)}MB (max 100MB)`)
    }
    
    // Upload to Uguu - EXACT same logic as working upload.js
    const form = new FormData()
    form.append('files[]', fs.createReadStream(zipPath))
    
    const { data } = await axios({
      url: 'https://uguu.se/upload.php',
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...form.getHeaders(), // This auto-sets Content-Type with boundary
      },
      data: form,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 60000, // 60s timeout for large files
    })
    
    // Clean up local zip
    try { fs.unlinkSync(zipPath) } catch (_) {}
    
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
    // URL format: https://n.uguu.se/vmdbjBHy.zip or https://uguu.se/f/vmdbjBHy.zip
    const match = url.match(/\/([a-zA-Z0-9]+)\.zip$/) || url.match(/\/f\/([a-zA-Z0-9]+)\.zip$/)
    const shortcode = match ? match[1] : null
    
    if (!shortcode) {
      throw new Error(`Could not extract shortcode from URL: ${url}`)
    }
    
    console.log(`[UPLOAD] Success! URL: ${url}, Shortcode: ${shortcode}`)
    return shortcode
    
  } catch (err) {
    console.error('[ZIP/UPLOAD ERROR]', err.message)
    if (err.response) {
      console.error('[ZIP/UPLOAD ERROR] Status:', err.response.status)
      console.error('[ZIP/UPLOAD ERROR] Data:', err.response.data)
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
  
  // Define userJid EARLY so it's available everywhere in this function
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
    userJid, // Store it in session object too
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
      sendToClients(sessionId, { status: 'paired', message: 'Pairing successful! Creating session package...' })
      
      // ⏳ STAY ALIVE to capture all session files
      console.log(`[${sessionId}] ⏳ Waiting 12 seconds to capture full session...`)
      await delay(12000)
      
      try {
        // 1. ZIP & UPLOAD session folder
        console.log(`[${sessionId}] 📦 Zipping session files...`)
        const shortcode = await zipAndUploadSession(sessionDir)
        
        // 2. GENERATE Session ID
        const vanguardSessionId = generateSessionId(shortcode)
        console.log(`[${sessionId}] 🔐 Session ID generated: ${vanguardSessionId.substring(0, 50)}...`)
        
        // 3. SEND TO USER'S WHATSAPP - First: Raw Session ID (for easy copying)
        // Use session.userJid which is guaranteed to be defined
        await sock.sendMessage(session.userJid, {
          text: vanguardSessionId
        })
        console.log(`[${sessionId}] 📤 Raw Session ID sent to ${session.userJid}`)
        
        // Message 2: Fancy formatted message
        await sock.sendMessage(session.userJid, {
          text:
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
            '┃ ⏰ *Expires in 48 hours*\n' +
            '┃    Deploy immediately!\n' +
            '┃\n' +
            '┃ 💡 *Need help?*\n' +
            '┃    Join: https://whatsapp.com/channel/0029Vb6RoNb0bIdgZPwcst2Y\n' +
            '╰───────────────━⊷\n' +
            '> *_Made With Love By Admin Blue_*\n' +
            '> *_VANGUARD MD is on Fire 🔥_*'
        })
        console.log(`[${sessionId}] 📤 Fancy message sent`)
        
        // 4. Notify frontend
        sendToClients(sessionId, { 
          status: 'done', 
          message: 'Session ID sent to your WhatsApp!',
          sessionId: vanguardSessionId // Optional: send to frontend too
        })
        
        session.sessionIdSent = true
        
      } catch (err) {
        console.error(`[${sessionId}] ❌ Session processing failed: ${err.message}`)
        sendToClients(sessionId, { 
          error: 'Session created but upload failed. Sending manual file...' 
        })
        
        // Fallback: Send creds.json only - NOW userJid is accessible!
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
            console.log(`[${sessionId}] 📤 Fallback creds.json sent`)
          } else {
            await sock.sendMessage(session.userJid, {
              text: '❌ Critical error: Session files not found. Please pair again.'
            })
          }
        } catch (fallbackErr) {
          console.error(`[${sessionId}] ❌ Fallback failed: ${fallbackErr.message}`)
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
  console.log(`👑 Session ID Edition v2 | Made by Mr.Admin Blue 2026`)
  console.log(`📦 Fixed: Upload logic + userJid scope`)
})
