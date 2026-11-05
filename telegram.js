// Telegram alerts for the admin. Config comes from .env (next to this file) or real environment variables:
//   TELEGRAM_BOT_TOKEN=123456:ABC...        (from @BotFather)
//   ADMIN_URL=https://your-admin-site     (optional: adds an "Open admin console" button; must be a public https link)
//   TELEGRAM_CHAT_ID=123456789              (your chat id; several allowed, separated by commas; groups start with -)
const fs = require('fs')
const path = require('path')

const envFile = path.join(__dirname, '.env')
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  })
}

const token = process.env.TELEGRAM_BOT_TOKEN
const chatIds = String(process.env.TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean)
const enabled = Boolean(token && chatIds.length)

const escapeHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

async function api(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const json = await res.json().catch(() => ({}))
  if (!json.ok) throw new Error(json.description || `Telegram HTTP ${res.status}`)
  return json.result
}

async function send(text) {
  if (!enabled) return
  for (const chat_id of chatIds) {
    try {
      const payload = { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }
      await api('sendMessage', payload)
      console.log(new Date().toLocaleTimeString(), `> telegram sent to ${chat_id}`)
    } catch (error) {
      console.log(new Date().toLocaleTimeString(), `! telegram failed for ${chat_id}: ${error.message}`)
    }
  }
}

// `node telegram.js` -> prints the chat ids that messaged the bot (send /start to the bot first).
if (require.main === module) {
  if (!token) { console.error('Set TELEGRAM_BOT_TOKEN in .env first.'); process.exit(1) }
  api('getUpdates').then((updates) => {
    const seen = new Map()
    updates.forEach((u) => {
      const chat = (u.message || u.channel_post || u.my_chat_member)?.chat
      if (chat) seen.set(chat.id, chat.title || chat.username || chat.first_name || '')
    })
    if (!seen.size) return console.log('No chats yet. Open your bot in Telegram, press Start, send "hi", then run this again.')
    seen.forEach((name, id) => console.log(`TELEGRAM_CHAT_ID=${id}   (${name})`))
  }).catch((e) => console.error('Error:', e.message))
}

module.exports = { send, enabled, escapeHtml }
