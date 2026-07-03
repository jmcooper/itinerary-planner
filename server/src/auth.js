import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import path from 'node:path'
import jwt from 'jsonwebtoken'

const scrypt = promisify(scryptCb)

// Also keeps user filenames path-safe: lowercase, starts alphanumeric, 3-30 chars.
export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,29}$/
export const MIN_PASSWORD_LENGTH = 8
export const TOKEN_COOKIE = 'token'
export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

const SCRYPT_KEYLEN = 64
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 }

export function createAuth(dataDir) {
  const usersDir = path.join(dataDir, 'users')
  const secret = loadSecret(dataDir)

  function userFile(username) {
    return path.join(usersDir, `${username}.json`)
  }

  async function readUser(username) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) return null
    try {
      return JSON.parse(await readFile(userFile(username), 'utf8'))
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
  }

  async function createUser(username, password) {
    await mkdir(usersDir, { recursive: true })
    const salt = randomBytes(16)
    const hash = await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS)
    const user = {
      username,
      salt: salt.toString('hex'),
      hash: hash.toString('hex'),
      createdAt: new Date().toISOString(),
    }
    // 'wx' fails if the file exists, so concurrent registrations cannot clobber.
    await writeFile(userFile(username), JSON.stringify(user, null, 2), { flag: 'wx' })
    return user
  }

  async function verifyPassword(user, password) {
    const expected = Buffer.from(user.hash, 'hex')
    const actual = await scrypt(password, Buffer.from(user.salt, 'hex'), SCRYPT_KEYLEN, SCRYPT_OPTS)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  async function listUsernames() {
    try {
      return (await readdir(usersDir))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length))
        .sort()
    } catch (err) {
      if (err.code === 'ENOENT') return []
      throw err
    }
  }

  function signToken(username) {
    return jwt.sign({ sub: username }, secret, { algorithm: 'HS256', expiresIn: '7d' })
  }

  // Middleware: resolves the token cookie to req.username (or null). Never rejects;
  // routes that need a user add requireAuth.
  function authenticate(req, res, next) {
    req.username = null
    const token = req.cookies?.[TOKEN_COOKIE]
    if (token) {
      try {
        const payload = jwt.verify(token, secret, { algorithms: ['HS256'] })
        if (typeof payload.sub === 'string' && USERNAME_RE.test(payload.sub))
          req.username = payload.sub
      } catch {
        // invalid/expired token = anonymous
      }
    }
    next()
  }

  function requireAuth(req, res, next) {
    if (!req.username) return res.status(401).json({ error: 'authentication required' })
    next()
  }

  function setTokenCookie(res, username) {
    res.cookie(TOKEN_COOKIE, signToken(username), {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.COOKIE_SECURE === '1',
      maxAge: TOKEN_TTL_MS,
      path: '/',
    })
  }

  function clearTokenCookie(res) {
    res.clearCookie(TOKEN_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/' })
  }

  return {
    readUser,
    createUser,
    verifyPassword,
    listUsernames,
    authenticate,
    requireAuth,
    setTokenCookie,
    clearTokenCookie,
  }
}

// The signing secret comes from the environment or a generated file in the data
// dir, so tokens survive restarts without a hardcoded fallback.
function loadSecret(dataDir) {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET
  const file = path.join(dataDir, 'jwt-secret')
  mkdirSync(dataDir, { recursive: true })
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  const secret = randomBytes(32).toString('hex')
  writeFileSync(file, secret, { mode: 0o600 })
  return secret
}
