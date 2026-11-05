// QuickLend push server.
// Watches Firestore and sends a push (Firebase Cloud Messaging) to the customer's phone when:
//   1. the admin sends a chat message      -> chats/{email}/messages/{id}   (sender is not "user")
//   2. a loan update is created for a user -> notifications/{id}            (audience == "user")
//      (approved, rejected, money disbursed)
//
// Phones register their token in users/{email}.fcmTokens (done by the Flutter app after login).
// It also sends Telegram alerts to the admin (see telegram.js):
//   3. a new loan request is submitted   -> loan_applications/{id}   (status pending)
//   4. a customer payment is received    -> payments/{id}            (status paid)
// It also sends a payment reminder push to customers once per day, from 5 days before the due date
// until the due date (see section 5). Late fee: $10 per late day.
// Keep serviceAccountKey.json PRIVATE. Never put it in the app or the admin website.
const fs = require('fs')
const path = require('path')
const admin = require('firebase-admin')
const telegram = require('./telegram')
const startStaffApi = require('./staff-api')

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'serviceAccountKey.json')
if (!fs.existsSync(keyPath)) {
  console.error(`\nMissing ${keyPath}\nDownload it: Firebase Console > Project settings > Service accounts > Generate new private key.\nSave it next to push-server.js and name it serviceAccountKey.json\n`)
  process.exit(1)
}

admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) })
const db = admin.firestore()
const CHANNEL_ID = 'high_importance_channel' // same id the Flutter app creates

const log = (...args) => console.log(new Date().toLocaleTimeString(), ...args)

async function findUser(email) {
  const ids = [...new Set([email, String(email).trim(), String(email).trim().toLowerCase()])]
  for (const id of ids) {
    const ref = db.collection('users').doc(id)
    const snap = await ref.get()
    if (snap.exists) return { ref, data: snap.data() }
  }
  return null
}

// Number shown on the app icon: unread loan notifications + unread chat replies.
async function unreadCount(email) {
  try {
    const lower = String(email).trim().toLowerCase()
    const [notes, chat] = await Promise.all([
      db.collection('notifications').where('userEmail', '==', email).get(),
      db.collection('chats').doc(lower).get(),
    ])
    const loan = notes.docs.filter((d) => d.data().audience === 'user' && d.data().read !== true).length
    const raw = chat.exists ? Number(chat.data().unreadUser) : 0
    return loan + (Number.isFinite(raw) ? raw : 0)
  } catch {
    return 0
  }
}

async function pushTo(email, { title, body, data = {} }) {
  const user = await findUser(email)
  if (user?.data?.notificationsEnabled === false) {
    log(`- ${email} turned notifications off, skipped`)
    return
  }
  const tokens = user?.data?.fcmTokens
  if (!Array.isArray(tokens) || tokens.length === 0) {
    log(`- no phone registered for ${email} (user must log in on the phone once)`)
    return
  }

  const count = Math.max(1, await unreadCount(email))
  // PUSH_MODE=system (default): Android draws the notification itself. Reliable, also when the app is closed.
  //                             Shows the white QuickLend logo as small icon.
  // PUSH_MODE=app             : data-only; the app draws it with the full-colour logo. Less reliable when the app is closed.
  const mode = String(process.env.PUSH_MODE || 'system').toLowerCase()
  const payloadData = {
    ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? '')])),
    title: String(title ?? ''),
    body: String(body ?? ''),
    count: String(count),
  }
  const message = mode === 'app'
    ? { tokens, data: payloadData, android: { priority: 'high' } }
    : {
        tokens,
        notification: { title, body },
        data: payloadData,
        android: {
          priority: 'high',
          notification: {
            channelId: CHANNEL_ID,
            sound: 'default',
            icon: 'ic_stat_logo', // res/drawable-*/ic_stat_logo.png (white logo)
            color: '#1677FF',
            notificationCount: count,
          },
        },
      }
  const response = await admin.messaging().sendEachForMulticast(message)
  log(`> push to ${email}: ${response.successCount} sent, ${response.failureCount} failed - "${title}: ${body}"`)

  // Remove tokens that are no longer valid (app uninstalled, logged out...).
  const dead = []
  response.responses.forEach((result, index) => {
    const code = result.error?.code
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
      dead.push(tokens[index])
    }
  })
  if (dead.length) await user.ref.update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead) })
}

function preview(message) {
  if (message.deletedForEveryone || message.type === 'deleted') return null
  switch (message.type) {
    case 'image': return 'Sent you a photo'
    case 'video': return 'Sent you a video'
    case 'file': return message.fileName ? `Sent a file: ${message.fileName}` : 'Sent you a file'
    case 'location': return 'Shared a location'
    default: return message.text || 'New message'
  }
}

const done = new Set() // avoids sending the same record twice
function once(id) {
  if (done.has(id)) return false
  done.add(id)
  if (done.size > 5000) done.delete(done.values().next().value)
  return true
}

function watch(name, query, onAdded) {
  let first = true // the first snapshot is old data: do not push it
  const start = () => query.onSnapshot(
    (snapshot) => {
      if (first) {
        first = false
        log(`watching ${name} (${snapshot.size} existing records ignored)`)
        return
      }
      snapshot.docChanges().forEach((change) => {
        if (change.type !== 'added') return
        if (!once(change.doc.ref.path)) return
        onAdded(change.doc).catch((error) => log(`! ${name} error:`, error.message))
      })
    },
    (error) => {
      log(`! ${name} listener stopped: ${error.message} - retrying in 10s`)
      setTimeout(start, 10000)
    },
  )
  start()
}

// 1. Chat messages written by the admin.
watch('chat messages', db.collectionGroup('messages'), async (doc) => {
  const chatRef = doc.ref.parent.parent
  if (!chatRef || chatRef.parent.id !== 'chats') return
  const message = doc.data()
  if (message.sender === 'user') return // the customer's own message
  const body = preview(message)
  if (!body) return
  await pushTo(chatRef.id, {
    title: 'QuickLend Support',
    body,
    data: { type: 'chat', chatId: chatRef.id },
  })
})

// 2. Loan updates for customers (approved / rejected / money sent).
watch('loan notifications', db.collection('notifications').where('audience', '==', 'user'), async (doc) => {
  const note = doc.data()
  if (!note.userEmail || note.read === true) return
  await pushTo(note.userEmail, {
    title: note.title || 'QuickLend',
    body: note.message || '',
    data: { type: 'loan', applicationId: note.applicationId || '' },
  })
})

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const money = (v) => `$${num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const esc = telegram.escapeHtml

const TZ = process.env.TZ_NAME || 'Asia/Phnom_Penh'
const DIV = '------------------------------------'
const adminLink = () => (process.env.ADMIN_URL ? `\nLink: ${esc(process.env.ADMIN_URL)}` : '')
const footer = () => `<b>Best regards,</b>\n<i>QuickLend System</i>🚀${adminLink()}`

// Same loan math as the mobile app (EMI).
function estimate(a) {
  const amount = num(a.approvedAmount ?? a.loanAmount ?? a.amount)
  const months = Math.round(num(a.loanTermMonths ?? a.duration ?? a.loanTerm) || num(a.loanTermYears) * 12) || 12
  const rate = num(a.rate ?? a.interestRate) || (amount >= 10000 ? 7 : amount >= 1000 ? 6 : amount >= 500 ? 5 : amount > 0 ? 4 : 0)
  const r = rate / 100 / 12
  const emi = r > 0 ? (amount * r * (1 + r) ** months) / ((1 + r) ** months - 1) : amount / Math.max(months, 1)
  return { amount, months, rate, emi }
}
const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-')
const toDate = (v) => (v && typeof v.toDate === 'function' ? v.toDate() : v ? new Date(v) : new Date())

// 3. New loan request -> Telegram admin.
watch('loan requests', db.collection('loan_applications'), async (doc) => {
  const a = doc.data()
  if (String(a.status || 'pending').toLowerCase() !== 'pending') return
  const email = a.email || a.userEmail || ''
  const name = a.fullName || a.name || a.customerName || email
  const e = estimate(a)
  await telegram.send([
    '🆕 <b>New Loan Request (Pending)</b>',
    `Loan ID: <b>${esc(doc.id)}</b>`,
    `Applicant: <b>${esc(name)}</b>`,
    `Request Date: <b>${fmtDate(toDate(a.createdAt))}</b>`,
    DIV,
    'Dear <b>Admin</b>,',
    '',
    `A new loan request was submitted by <b>${esc(name)}</b> (${esc(email)}).`,
    '',
    `💰 Requested Amount: <b>${money(e.amount)}</b>`,
    `🗓 Loan Duration: <b>${e.months} Months</b>`,
    `📈 Interest Rate: <b>${e.rate}% / year</b>`,
    `💳 Est. Monthly Payment: <b>${money(e.emi)}</b>`,
    '',
    'Please review and approve or reject this request.',
    '',
    footer(),
  ].join('\n'))
})

// 4. Payment received -> Telegram admin.
watch('payments', db.collection('payments'), async (doc) => {
  const p = doc.data()
  const status = String(p.status || '').toLowerCase()
  if (!['paid', 'pending'].includes(status)) return // 'pending' = invoice uploaded (other methods)
  const email = p.userEmail || p.email || ''
  const loanId = p.loanDocId || p.loanId || ''
  const [user, loanSnap] = await Promise.all([
    email ? findUser(email) : null,
    loanId ? db.collection('loan_applications').doc(loanId).get().catch(() => null) : null,
  ])
  const name = user?.data?.name || user?.data?.fullName || p.customerName || email
  const month = Number(String(p.period || '').replace(/\D/g, '')) || 0
  const total = loanSnap?.exists ? estimate(loanSnap.data()).months : 0
  const paid = status === 'paid'
  const late = num(p.lateDays)
  await telegram.send([
    paid ? '✅ <b>Loan Repayment (Paid)</b>' : '⏳ <b>Loan Repayment (Pending Review)</b>',
    `Loan ID: <b>${esc(loanId)}</b>`,
    `Borrower: <b>${esc(name)}</b>`,
    `Payment Date: <b>${fmtDate(toDate(p.paidAt))}</b>`,
    DIV,
    'Dear <b>Admin</b>,',
    '',
    paid
      ? `<b>${esc(name)}</b> has successfully paid the loan installment.`
      : `<b>${esc(name)}</b> uploaded a payment invoice. Please check and confirm.`,
    '',
    `💵 Paid Amount: <b>${money(p.amountPaid ?? p.amount)}</b>`,
    `🗓 Installment: <b>${month ? `Month ${month}${total ? ` of ${total}` : ''}` : '-'}</b>`,
    `🏦 Payment Method: <b>${esc(String(p.method || '-').toUpperCase())}${p.source === 'admin' ? ' (admin)' : ''}</b>`,
    `⏱ Late Days: <b>${late} Day${late === 1 ? '' : 's'}</b>`,
    `⚠️ Penalty: <b>${money(p.penalty)}</b>`,
    p.invoiceUrl ? `🧾 Invoice: <a href="${esc(p.invoiceUrl)}">View invoice</a>` : '🧾 Invoice: none',
    '',
    footer(),
  ].join('\n'))
})

// 5. Payment reminders: once per day, starting 5 days before each unpaid installment is due.
const REMIND_DAYS = Number(process.env.REMIND_DAYS_BEFORE || 5)
const REMIND_HOUR = Number(process.env.REMIND_HOUR || 9) // local hour (TZ_NAME) when the daily reminder goes out
const PENALTY_PER_DAY = Number(process.env.PENALTY_PER_DAY || 10)

const localParts = (date) => {
  const [y, m, d] = new Date(date).toLocaleDateString('en-CA', { timeZone: TZ }).split('-').map(Number)
  return { y, m, d }
}
const dayNumber = ({ y, m, d }) => Math.floor(Date.UTC(y, m - 1, d) / 86400000)
// Same as dayjs().add(n, 'month'): keeps the day, or the last day of a shorter month.
function addMonths({ y, m, d }, n) {
  const index = y * 12 + (m - 1) + n
  const year = Math.floor(index / 12)
  const month = index % 12
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return { y: year, m: month + 1, d: Math.min(d, last) }
}
const pretty = ({ y, m, d }) => fmtDate(Date.UTC(y, m - 1, d))

async function runReminders() {
  const today = localParts(new Date())
  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: TZ })
  const todayNo = dayNumber(today)

  const [loans, payments, repayments] = await Promise.all([
    db.collection('loan_applications').get(),
    db.collection('payments').get(),
    db.collection('repayments').get().catch(() => ({ docs: [] })),
  ])
  // month numbers that are already paid (or an invoice is waiting for review) per loan
  const settled = new Map()
  ;[...payments.docs, ...repayments.docs].forEach((doc) => {
    const p = doc.data()
    const status = String(p.status || '').toLowerCase()
    if (!['paid', 'completed', 'pending'].includes(status)) return
    const loanId = p.loanDocId || p.loanId
    const month = Number(String(p.period || '').replace(/\D/g, ''))
    if (!loanId || !month) return
    if (!settled.has(loanId)) settled.set(loanId, new Set())
    settled.get(loanId).add(month)
  })

  let sent = 0
  for (const doc of loans.docs) {
    const a = doc.data()
    const status = String(a.status || '').toUpperCase()
    if (!['DISBURSED', 'ACTIVE', 'OVERDUE'].includes(status)) continue
    const email = a.email || a.userEmail
    if (!email) continue
    const e = estimate(a)
    const start = localParts(toDate(a.disbursedAt || a.approvedAt || a.createdAt))
    for (let month = 1; month <= e.months; month += 1) {
      if (settled.get(doc.id)?.has(month)) continue
      const due = addMonths(start, month)
      const daysLeft = dayNumber(due) - todayNo
      if (daysLeft < 0 || daysLeft > REMIND_DAYS) continue

      const logRef = db.collection('reminder_log').doc(`${doc.id}_${month}_${todayKey}`)
      if ((await logRef.get()).exists) continue
      await logRef.set({ loanId: doc.id, month, email, date: todayKey, sentAt: admin.firestore.FieldValue.serverTimestamp() })

      const when = daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`
      // Saved in "notifications" -> section 2 above turns it into a push and the app lists it.
      await db.collection('notifications').add({
        audience: 'user',
        type: 'payment_reminder',
        userEmail: email,
        applicationId: doc.id,
        title: daysLeft === 0 ? 'Payment due today' : `Payment due ${when}`,
        message: `Your Month ${month} installment of ${money(e.emi)} is due ${when} (${pretty(due)}). Pay on time to avoid a ${money(PENALTY_PER_DAY)} late fee per day.`,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      sent += 1
      log(`> reminder queued for ${email}: Month ${month} due ${when}`)
    }
  }
  if (sent) log(`reminders: ${sent} queued`)
}

async function reminderTick() {
  const hour = Number(new Date().toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }))
  if (hour < REMIND_HOUR) return
  try { await runReminders() } catch (error) { log('! reminders error:', error.message) }
}
setTimeout(reminderTick, 5000)             // also right after start (skipped if already sent today)
setInterval(reminderTick, 30 * 60 * 1000)  // then check every 30 minutes; each reminder is sent once per day

startStaffApi({ admin, db, log })
log(telegram.enabled ? 'Telegram alerts: ON' : 'Telegram alerts: OFF (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env)')
log(`Payment reminders: ON (${REMIND_DAYS} days before the due date, daily at ${REMIND_HOUR}:00 ${TZ})`)
log('QuickLend push server is running. Press Ctrl+C to stop.')
