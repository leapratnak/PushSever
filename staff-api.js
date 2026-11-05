// Staff account API (runs inside push-server.js).
// Lets a SUPER_ADMIN change another staff member's sign-in email and password.
// The browser cannot do this itself: it needs the Firebase Admin SDK.
//
//   POST /staff/update   Authorization: Bearer <Firebase ID token of the logged-in admin>
//   body: { id, name, role, phone, email?, password? }
const http = require('http')

const normalizeRole = (r) => String(r || '').trim().toUpperCase().replace(/[\s-]+/g, '_')

module.exports = function startStaffApi({ admin, db, log }) {
  const port = Number(process.env.STAFF_API_PORT || 8787)
  const origins = String(process.env.ADMIN_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map((s) => s.trim()).filter(Boolean)

  const send = (res, code, body, origin) => {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origins.includes(origin) ? origin : origins[0],
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      Vary: 'Origin',
    })
    res.end(JSON.stringify(body))
  }

  async function update(req, body) {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (!token) throw Object.assign(new Error('Not signed in'), { code: 401 })
    let caller
    try { caller = await admin.auth().verifyIdToken(token) } catch { throw Object.assign(new Error('Invalid session, sign in again'), { code: 401 }) }
    const callerEmail = String(caller.email || '').toLowerCase()
    const callerDoc = await db.collection('users').doc(callerEmail).get()
    if (normalizeRole(callerDoc.data()?.role) !== 'SUPER_ADMIN') {
      throw Object.assign(new Error('Only a Super admin can change email or password'), { code: 403 })
    }

    const oldId = String(body.id || '').toLowerCase()
    const newEmail = String(body.email || oldId).trim().toLowerCase()
    const password = body.password ? String(body.password) : ''
    if (!oldId) throw Object.assign(new Error('Missing user id'), { code: 400 })
    if (password && password.length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { code: 400 })
    const oldRef = db.collection('users').doc(oldId)
    const oldSnap = await oldRef.get()
    if (!oldSnap.exists) throw Object.assign(new Error('Staff profile not found'), { code: 404 })
    if (newEmail !== oldId && (await db.collection('users').doc(newEmail).get()).exists) {
      throw Object.assign(new Error('Another user already uses this email'), { code: 409 })
    }

    // 1. Sign-in account (Firebase Authentication)
    let authUser = null
    try { authUser = await admin.auth().getUserByEmail(oldId) } catch (e) { if (e.code !== 'auth/user-not-found') throw e }
    const changes = {}
    if (newEmail !== oldId) changes.email = newEmail
    if (password) changes.password = password
    if (authUser) {
      if (Object.keys(changes).length) await admin.auth().updateUser(authUser.uid, changes)
    } else if (password) {
      await admin.auth().createUser({ email: newEmail, password })
    }

    // 2. Profile (Firestore users/{email}); the document id is the email, so move it when it changes.
    const profile = {
      ...oldSnap.data(),
      name: body.name ?? oldSnap.data().name,
      fullName: body.name ?? oldSnap.data().fullName,
      role: body.role ?? oldSnap.data().role,
      phone: body.phone ?? oldSnap.data().phone ?? '',
      email: newEmail,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }
    delete profile.password
    if (newEmail !== oldId) {
      await db.collection('users').doc(newEmail).set(profile)
      await oldRef.delete()
    } else {
      await oldRef.set(profile, { merge: true })
    }
    log(`> staff updated by ${callerEmail}: ${oldId}${newEmail !== oldId ? ` -> ${newEmail}` : ''}${password ? ' (password changed)' : ''}`)
    return { id: newEmail }
  }

  http.createServer((req, res) => {
    const origin = req.headers.origin
    if (req.method === 'OPTIONS') return send(res, 204, {}, origin)
    if (req.method !== 'POST' || req.url !== '/staff/update') return send(res, 404, { message: 'Not found' }, origin)
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy() })
    req.on('end', async () => {
      try {
        send(res, 200, await update(req, JSON.parse(raw || '{}')), origin)
      } catch (error) {
        send(res, error.code >= 400 && error.code < 600 ? error.code : 500, { message: error.message }, origin)
      }
    })
  }).listen(port, () => log(`Staff API: ON (http://localhost:${port}, allowed origins: ${origins.join(', ')})`))
}
