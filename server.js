const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4173;
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'data', 'db.json');
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const IDLE_MS = 30000;
const OFFLINE_GRACE_MS = 15000;
const ACTIVITY_MIN_INTERVAL_MS = 1000;

const defaultDb = { users: [], posts: [], friendRequests: [], friendships: [], messages: [], notifications: [], loginThrottle: {}, forumTopics: [], forumPosts: [], sessions: [] };

function seedForumTopics(db) {
  if (!db.forumTopics.length) {
    db.forumTopics = [
      { id: uid(), name: 'Blue Team Operations', description: 'SOC workflows, detections and incident response playbooks.' },
      { id: uid(), name: 'OWASP & AppSec', description: 'Secure coding, threat modeling and web vulnerabilities.' },
      { id: uid(), name: 'Cloud Security', description: 'Identity, IAM hardening, CSPM and secure architecture.' }
    ];
  }
}
function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    const db = JSON.parse(JSON.stringify(defaultDb));
    seedForumTopics(db);
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  }
}
function readDb() {
  ensureDb();
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  let changed = false;
  for (const key of Object.keys(defaultDb)) {
    if (db[key] === undefined) {
      db[key] = Array.isArray(defaultDb[key]) ? [] : {};
      changed = true;
    }
  }
  if (!db.forumTopics.length) { seedForumTopics(db); changed = true; }
  if (!Array.isArray(db.sessions)) { db.sessions = []; changed = true; }
  if (Array.isArray(db.messages)) {
    for (const m of db.messages) {
      if (!Array.isArray(m.readBy)) { m.readBy = [m.from].filter(Boolean); changed = true; }
    }
  }
  if (Array.isArray(db.forumPosts)) {
    for (const fp of db.forumPosts) {
      if (!Array.isArray(fp.comments)) { fp.comments = []; changed = true; }
      if (!fp.visibility) { fp.visibility = 'public'; changed = true; }
    }
  }
  if (changed) writeDb(db);
  return db;
}
function writeDb(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
function uid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }
function hash(txt) { return crypto.createHash('sha256').update(String(txt)).digest('hex'); }
function sanitize(txt, max = 500) { return String(txt || '').replace(/[<>]/g, '').trim().slice(0, max); }
function publicUser(u = {}) { return { id: u.id, username: u.username, email: u.email, emailChanged: u.emailChanged, profileImage: u.profileImage, active: u.active, statusEncrypted: u.statusEncrypted, createdAt: u.createdAt }; }
function notify(db, userId, type, text) { db.notifications.unshift({ id: uid(), userId, type, text: sanitize(text, 200), createdAt: now() }); }
function areFriends(db, a, b) { return db.friendships.some((f) => (f.a === a && f.b === b) || (f.a === b && f.b === a)); }
function canAccessForumPost(db, post, viewerId) {
  if (!post) return false;
  if (post.visibility !== 'friends') return true;
  if (!viewerId) return false;
  if (post.authorId === viewerId) return true;
  return areFriends(db, post.authorId, viewerId);
}

function isAdmin(user) {
  return Boolean(user && user.isAdmin === true);
}

function setSecurityHeaders(res, contentType = 'application/json; charset=utf-8') {
  return {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self';",
    'Cache-Control': 'no-store'
  };
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions = (db.sessions || []).filter((s) => s.userId !== userId).slice(0, 199);
  db.sessions.push({ id: uid(), userId, token, createdAt: now() });
  return token;
}

function getUserByToken(db, token) {
  if (!token) return null;
  const session = (db.sessions || []).find((s) => s.token === token);
  if (!session) return null;
  return db.users.find((u) => u.id === session.userId) || null;
}

function getAuthUser(req, db) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return getUserByToken(db, token);
}

function validatePathname(pathname) {
  return !/[<>\"'`]/.test(pathname || '');
}

function validateImageDataUrl(imageData) {
  if (!imageData) return '';
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(imageData);
  if (!match) throw new Error('Invalid image format');
  if (!ALLOWED_IMAGE_TYPES.includes(match[1])) throw new Error('Only image uploads are allowed');
  const size = Buffer.byteLength(match[2], 'base64');
  if (size > MAX_IMAGE_BYTES) throw new Error('Image must be less than 2MB');
  return imageData;
}

function json(res, status, payload) {
  res.writeHead(status, setSecurityHeaders(res));
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > MAX_BODY_BYTES) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let decodedPath = pathname || '/';
  try { decodedPath = decodeURIComponent(decodedPath); } catch { return json(res, 400, { error: 'Invalid path encoding' }); }
  if (!validatePathname(decodedPath)) return json(res, 400, { error: 'Invalid path' });
  let normalized = path.normalize(decodedPath || '/');
  if (normalized.includes('..')) return json(res, 403, { error: 'Forbidden' });
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;

  let filePath = path.join(ROOT, normalized === '/' ? 'index.html' : normalized.slice(1));
  if (!filePath.startsWith(ROOT)) return json(res, 403, { error: 'Forbidden' });

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const looksLikeAsset = /\.[a-zA-Z0-9]+$/.test(normalized);
    if (looksLikeAsset) return json(res, 404, { error: 'File not found' });
    filePath = path.join(ROOT, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'application/javascript; charset=utf-8' : ext === '.png' ? 'image/png' : ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
  res.writeHead(200, setSecurityHeaders(res, type));
  fs.createReadStream(filePath).pipe(res);
}

function withUsers(db, posts) {
  return posts.map((p) => ({
    ...p,
    author: publicUser(db.users.find((u) => u.id === p.authorId)),
    comments: (p.comments || []).map((c) => ({ ...c, user: publicUser(db.users.find((u) => u.id === c.userId)) }))
  }));
}

const presenceState = new Map();
const socketUserMap = new Map();
const socketWatchMap = new Map();
let io = null;

function getPresence(userId) {
  if (!presenceState.has(userId)) {
    presenceState.set(userId, { status: 'offline', lastActiveAt: '', connections: 0, sockets: new Set(), offlineTimer: null, lastBroadcast: 0 });
  }
  return presenceState.get(userId);
}

function computePresenceStatus(p) {
  if (p.connections <= 0) return 'offline';
  const idle = Date.now() - (p.lastActiveAt ? new Date(p.lastActiveAt).getTime() : 0) > IDLE_MS;
  return idle ? 'idle' : 'online';
}

function emitPresenceToWatchers(userId) {
  if (!io) return;
  const p = getPresence(userId);
  const payload = { userId, status: p.status, lastActiveAt: p.lastActiveAt || '' };
  io.to(`user:${userId}`).emit('presence:update', payload);
  for (const [sid, watched] of socketWatchMap.entries()) {
    if (watched.has(userId)) io.to(sid).emit('presence:update', payload);
  }
}

function setPresenceStatus(userId, status, lastActiveAt = now()) {
  const p = getPresence(userId);
  if (p.status === status && p.lastActiveAt === lastActiveAt) return;
  p.status = status;
  p.lastActiveAt = lastActiveAt;
  p.lastBroadcast = Date.now();
  emitPresenceToWatchers(userId);
}

function touchPresence(userId, forceIdle = false) {
  const p = getPresence(userId);
  p.lastActiveAt = now();
  if (forceIdle) {
    setPresenceStatus(userId, 'idle', p.lastActiveAt);
    return;
  }
  const next = computePresenceStatus(p);
  setPresenceStatus(userId, next, p.lastActiveAt);
}

function startOfflineGrace(userId) {
  const p = getPresence(userId);
  if (p.offlineTimer) clearTimeout(p.offlineTimer);
  p.offlineTimer = setTimeout(() => {
    const curr = getPresence(userId);
    if (curr.connections <= 0) setPresenceStatus(userId, 'offline', curr.lastActiveAt || now());
  }, OFFLINE_GRACE_MS);
}

function conversationId(a, b) { return [a, b].sort().join(':'); }

function onlineStateOf(userId) {
  const p = presenceState.get(userId);
  if (!p) return { status: 'offline', lastActiveAt: '' };
  return { status: p.status, lastActiveAt: p.lastActiveAt || '' };
}

setInterval(() => {
  for (const [uid, p] of presenceState.entries()) {
    if (p.connections > 0) {
      const next = computePresenceStatus(p);
      if (next !== p.status) setPresenceStatus(uid, next, p.lastActiveAt || now());
    }
  }
}, 5000);


async function handleApi(req, res, urlObj) {
  const db = readDb();
  const { pathname, searchParams } = urlObj;
  const authUser = getAuthUser(req, db);

  try {
    if (req.method === 'POST' && pathname === '/api/auth/register') {
      const body = await readBody(req);
      const username = sanitize(body.username, 20);
      const email = sanitize(body.email, 120).toLowerCase();
      const password = String(body.password || '');
      if (!/^[\w.-]{3,20}$/.test(username)) return json(res, 400, { error: 'Username invalid' });
      if (!/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { error: 'Email invalid' });
      if (password.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });
      if (db.users.some((u) => u.email === email)) return json(res, 409, { error: 'Email already exists' });
      if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) return json(res, 409, { error: 'Username already exists' });
      db.users.push({ id: uid(), username, email, passwordHash: hash(password), emailChanged: 0, profileImage: '', active: true, statusEncrypted: Buffer.from('Blue team standby').toString('base64'), createdAt: now() });
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await readBody(req);
      const email = sanitize(body.email, 120).toLowerCase();
      const password = String(body.password || '');
      const throttle = db.loginThrottle[email] || { count: 0, blockedUntil: 0 };
      if (Date.now() < throttle.blockedUntil) return json(res, 429, { error: 'Temporarily blocked' });
      const user = db.users.find((u) => u.email === email && u.passwordHash === hash(password));
      if (!user) {
        throttle.count += 1;
        if (throttle.count >= 5) { throttle.blockedUntil = Date.now() + 60000; throttle.count = 0; }
        db.loginThrottle[email] = throttle;
        writeDb(db);
        return json(res, 401, { error: 'Invalid credentials' });
      }
      db.loginThrottle[email] = { count: 0, blockedUntil: 0 };
      user.active = true;
      const token = createSession(db, user.id);
      writeDb(db);
      return json(res, 200, { user: { ...publicUser(user), token } });
    }


    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      if (!authUser) return json(res, 200, { ok: true });
      const auth = String(req.headers.authorization || '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      db.sessions = (db.sessions || []).filter((s) => s.token !== token);
      writeDb(db);
      if (io) io.to(`user:${authUser.id}`).emit('presence:forceOffline');
      const p = getPresence(authUser.id);
      p.connections = 0;
      p.sockets.clear();
      setPresenceStatus(authUser.id, 'offline', now());
      if (io) io.in(`user:${authUser.id}`).disconnectSockets(true);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/users/search') {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const q = sanitize(searchParams.get('q') || '', 30).toLowerCase();
      const users = db.users.filter((u) => u.id !== authUser.id && (!q || u.username.toLowerCase().includes(q))).slice(0, 15).map((u) => ({ ...publicUser(u), postCount: db.posts.filter((p) => p.authorId === u.id).length }));
      return json(res, 200, { users });
    }


    if (req.method === 'GET' && pathname.match(/^\/api\/users\/[^/]+\/posts$/)) {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const targetId = pathname.split('/')[3];
      const user = db.users.find((u) => u.id === targetId);
      if (!user) return json(res, 404, { error: 'User not found' });
      const posts = withUsers(db, db.posts.filter((p) => p.authorId === targetId).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      return json(res, 200, { user: publicUser(user), posts });
    }

    if (req.method === 'GET' && pathname.match(/^\/api\/users\/[^/]+\/activity$/)) {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const targetId = pathname.split('/')[3];
      const viewerId = authUser.id;
      const user = db.users.find((u) => u.id === targetId);
      if (!user) return json(res, 404, { error: 'User not found' });

      const posts = withUsers(db, db.posts.filter((p) => p.authorId === targetId).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      const forumPosts = db.forumPosts
        .filter((p) => p.authorId === targetId && canAccessForumPost(db, p, viewerId))
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((p) => ({ ...p, topic: db.forumTopics.find((t) => t.id === p.topicId), author: publicUser(user) }));
      const forumComments = db.forumPosts
        .filter((p) => canAccessForumPost(db, p, viewerId))
        .flatMap((p) => (p.comments || []).filter((c) => c.userId === targetId).map((c) => ({ ...c, postId: p.id, topic: db.forumTopics.find((t) => t.id === p.topicId), postPreview: sanitize(p.content, 100) })) )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      return json(res, 200, { user: publicUser(user), posts, forumPosts, forumComments });
    }

    if (req.method === 'GET' && pathname === '/api/posts') {
      const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);
      const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '20', 10), 1), 50);
      const sorted = db.posts.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const slice = sorted.slice(offset, offset + limit);
      return json(res, 200, { posts: withUsers(db, slice), total: sorted.length, hasMore: offset + limit < sorted.length, nextOffset: offset + slice.length });
    }

    if (req.method === 'POST' && pathname === '/api/posts') {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const body = await readBody(req);
      const user = authUser;
      const content = sanitize(body.content, 500);
      const imageData = validateImageDataUrl(body.imageData || '');
      if (!user) return json(res, 404, { error: 'User not found' });
      if (!content && !imageData) return json(res, 400, { error: 'Post content required' });
      db.posts.push({ id: uid(), authorId: user.id, content, imageData, likes: [], comments: [], reports: [], createdAt: now(), editedAt: null });
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'PUT' && pathname.match(/^\/api\/posts\/[^/]+$/)) {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const postId = pathname.split('/')[3];
      const body = await readBody(req);
      const post = db.posts.find((p) => p.id === postId);
      if (!post) return json(res, 404, { error: 'Post not found' });
      if (post.authorId !== authUser.id) return json(res, 403, { error: 'Only author can edit' });
      const content = sanitize(body.content, 500);
      if (!content && !post.imageData) return json(res, 400, { error: 'Content required' });
      post.content = content;
      post.editedAt = now();
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && pathname.match(/^\/api\/posts\/[^/]+$/)) {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const postId = pathname.split('/')[3];
      await readBody(req);
      const idx = db.posts.findIndex((p) => p.id === postId);
      if (idx < 0) return json(res, 404, { error: 'Post not found' });
      if (db.posts[idx].authorId !== authUser.id) return json(res, 403, { error: 'Only author can delete' });
      db.posts.splice(idx, 1);
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/posts\/[^/]+\/report$/)) {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const postId = pathname.split('/')[3];
      const body = await readBody(req);
      const post = db.posts.find((p) => p.id === postId);
      const reporter = authUser;
      if (!post || !reporter) return json(res, 404, { error: 'Not found' });
      if (post.authorId === reporter.id) return json(res, 400, { error: 'Cannot report your own post' });
      post.reports = post.reports || [];
      if (post.reports.some((r) => r.userId === reporter.id)) return json(res, 409, { error: 'Already reported' });
      post.reports.push({ id: uid(), userId: reporter.id, reason: sanitize(body.reason, 200) || 'Report', createdAt: now() });
      notify(db, post.authorId, 'report', `${reporter.username} reported your post.`);
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/posts\/[^/]+\/like$/)) {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const postId = pathname.split('/')[3];
      await readBody(req);
      const post = db.posts.find((p) => p.id === postId);
      const user = authUser;
      if (!post || !user) return json(res, 404, { error: 'Not found' });
      const liked = post.likes.includes(user.id);
      post.likes = liked ? post.likes.filter((id) => id !== user.id) : [...post.likes, user.id];
      if (!liked && post.authorId !== user.id) notify(db, post.authorId, 'like', `${user.username} liked your post.`);
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/posts\/[^/]+\/comment$/)) {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const postId = pathname.split('/')[3];
      const body = await readBody(req);
      const post = db.posts.find((p) => p.id === postId);
      const user = authUser;
      const content = sanitize(body.content, 200);
      if (!post || !user) return json(res, 404, { error: 'Not found' });
      if (!content) return json(res, 400, { error: 'Content required' });
      post.comments.push({ id: uid(), userId: user.id, content, kind: body.kind === 'reply' ? 'reply' : 'comment', createdAt: now() });
      if (post.authorId !== user.id) notify(db, post.authorId, 'comment', `${user.username} replied to your post.`);
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && pathname.match(/^\/api\/posts\/[^/]+\/replies\/[^/]+$/)) {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const [, , , postId, , replyId] = pathname.split('/');
      const post = db.posts.find((p) => p.id === postId);
      if (!post) return json(res, 404, { error: 'Post not found' });

      post.comments = Array.isArray(post.comments) ? post.comments : [];
      const replyIndex = post.comments.findIndex((c) => c.id === replyId && c.kind === 'reply');
      if (replyIndex < 0) return json(res, 404, { error: 'Reply not found' });

      const reply = post.comments[replyIndex];
      if (reply.userId !== authUser.id && !isAdmin(authUser)) {
        return json(res, 403, { error: 'Only reply owner or admin can delete' });
      }

      post.comments.splice(replyIndex, 1);
      if (Number.isInteger(post.replyCount)) {
        post.replyCount = Math.max(0, post.replyCount - 1);
      }

      writeDb(db);
      return json(res, 200, { ok: true, deletedReplyId: replyId });
    }


    if (req.method === 'GET' && pathname === '/api/forum/topics') {
      return json(res, 200, { topics: db.forumTopics });
    }

    if (req.method === 'POST' && pathname === '/api/forum/topics') {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const body = await readBody(req);
      const author = authUser;
      const name = sanitize(body.name, 60);
      const description = sanitize(body.description, 300);
      if (!author) return json(res, 404, { error: 'User not found' });
      if (name.length < 3) return json(res, 400, { error: 'Topic name is too short' });
      if (db.forumTopics.some((t) => t.name.toLowerCase() === name.toLowerCase())) return json(res, 409, { error: 'Topic already exists' });
      const topic = { id: uid(), name, description: description || 'Community created topic.' };
      db.forumTopics.push(topic);
      writeDb(db);
      return json(res, 200, { topic });
    }

    if (req.method === 'GET' && pathname.match(/^\/api\/forum\/topics\/[^/]+\/posts$/)) {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const topicId = pathname.split('/')[4];
      const viewerId = authUser.id;
      const posts = db.forumPosts
        .filter((p) => p.topicId === topicId && canAccessForumPost(db, p, viewerId))
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((p) => ({
          ...p,
          author: publicUser(db.users.find((u) => u.id === p.authorId)),
          comments: (p.comments || []).map((c) => ({ ...c, user: publicUser(db.users.find((u) => u.id === c.userId)) }))
        }));
      return json(res, 200, { posts });
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/forum\/topics\/[^/]+\/posts$/)) {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const topicId = pathname.split('/')[4];
      const body = await readBody(req);
      const author = authUser;
      const topic = db.forumTopics.find((t) => t.id === topicId);
      const content = sanitize(body.content, 3000);
      const visibility = body.visibility === 'friends' ? 'friends' : 'public';
      if (!author || !topic) return json(res, 404, { error: 'Not found' });
      if (!content) return json(res, 400, { error: 'Content required' });
      db.forumPosts.push({ id: uid(), topicId, authorId: author.id, content, visibility, comments: [], createdAt: now() });
      writeDb(db);

      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/forum\/posts\/[^/]+\/comments$/)) {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const postId = pathname.split('/')[4];
      const body = await readBody(req);
      const post = db.forumPosts.find((p) => p.id === postId);
      const user = authUser;
      const content = sanitize(body.content, 300);
      if (!post || !user) return json(res, 404, { error: 'Not found' });
      if (!canAccessForumPost(db, post, user.id)) return json(res, 403, { error: 'Not allowed for this forum post' });
      if (!content) return json(res, 400, { error: 'Content required' });
      post.comments = post.comments || [];
      post.comments.push({ id: uid(), userId: user.id, content, createdAt: now() });
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/friends/request') {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const body = await readBody(req);
      const from = authUser;
      const to = db.users.find((u) => u.id === body.to);
      if (!from || !to) return json(res, 404, { error: 'User not found' });
      if (from.id === to.id) return json(res, 400, { error: 'Cannot add yourself' });
      if (areFriends(db, from.id, to.id)) return json(res, 409, { error: 'Already friends' });
      const exists = db.friendRequests.some((r) => ((r.from === from.id && r.to === to.id) || (r.from === to.id && r.to === from.id)) && r.status === 'pending');
      if (exists) return json(res, 409, { error: 'Request already pending' });
      db.friendRequests.push({ id: uid(), from: from.id, to: to.id, status: 'pending', createdAt: now() });
      notify(db, to.id, 'friend', `${from.username} sent you a friend request.`);
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname.match(/^\/api\/friends\/requests\/[^/]+$/)) {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const userId = pathname.split('/').pop();
      if (userId !== authUser.id) return json(res, 403, { error: 'Forbidden' });
      const requests = db.friendRequests.filter((r) => r.to === userId && r.status === 'pending').map((r) => ({ ...r, sender: publicUser(db.users.find((u) => u.id === r.from)) }));
      return json(res, 200, { requests });
    }

    if (req.method === 'POST' && pathname === '/api/friends/respond') {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const body = await readBody(req);
      const request = db.friendRequests.find((r) => r.id === body.requestId && r.to === authUser.id && r.status === 'pending');
      if (!request) return json(res, 404, { error: 'Request not found' });
      const me = authUser;
      request.status = body.action === 'accept' ? 'accepted' : 'rejected';
      if (request.status === 'accepted' && !areFriends(db, request.from, request.to)) db.friendships.push({ id: uid(), a: request.from, b: request.to, createdAt: now() });
      notify(db, request.from, 'friend', `${me.username} ${request.status} your friend request.`);
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname.match(/^\/api\/friends\/list\/[^/]+$/)) {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const userId = pathname.split('/').pop();
      if (userId !== authUser.id) return json(res, 403, { error: 'Forbidden' });
      const ids = db.friendships.flatMap((f) => (f.a === userId ? [f.b] : (f.b === userId ? [f.a] : [])));
      return json(res, 200, { friends: db.users.filter((u) => ids.includes(u.id)).map(publicUser) });
    }

    if (req.method === 'GET' && pathname.match(/^\/api\/notifications\/[^/]+$/)) {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const userId = pathname.split('/').pop();
      if (userId !== authUser.id) return json(res, 403, { error: 'Forbidden' });
      return json(res, 200, { notifications: db.notifications.filter((n) => n.userId === userId).slice(0, 30) });
    }


    if (req.method === 'GET' && pathname === '/api/messages/conversations') {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const userId = authUser.id;
      const friendIds = db.friendships.flatMap((f) => (f.a === userId ? [f.b] : (f.b === userId ? [f.a] : [])));
      const conversations = friendIds.map((fid) => {
        const friend = db.users.find((u) => u.id === fid);
        const msgs = db.messages
          .filter((m) => (m.from === userId && m.to === fid) || (m.from === fid && m.to === userId))
          .slice()
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const last = msgs[0];
        const unreadCount = msgs.filter((m) => m.to === userId && !(m.readBy || []).includes(userId)).length;
        const presence = onlineStateOf(fid);
        return {
          user: publicUser(friend),
          lastPreview: last?.content || (last?.imageData ? '📷 Image' : ''),
          lastMessageAt: last?.createdAt || '',
          unreadCount,
          presence
        };
      }).sort((a, b) => (b.lastMessageAt || '').localeCompare(a.lastMessageAt || ''));
      return json(res, 200, { conversations });
    }

    if (req.method === 'POST' && pathname === '/api/messages') {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const body = await readBody(req);
      const from = authUser;
      const to = db.users.find((u) => u.id === body.to);
      if (!from || !to) return json(res, 404, { error: 'User not found' });
      if (!areFriends(db, from.id, to.id)) return json(res, 403, { error: 'You can message only friends' });
      const content = sanitize(body.content, 300);
      const imageData = validateImageDataUrl(body.imageData || '');
      if (!content && !imageData) return json(res, 400, { error: 'Message is empty' });
      const parentId = sanitize(body.parentId, 80);
      if (parentId && !db.messages.some((m) => m.id === parentId)) return json(res, 400, { error: 'Parent message not found' });
      const message = { id: uid(), from: from.id, to: to.id, content, imageData, parentId: parentId || '', readBy: [from.id], createdAt: now() };
      db.messages.push(message);
      notify(db, to.id, 'message', `${from.username} sent you a message.`);
      writeDb(db);
      if (io) {
        io.to(`user:${from.id}`).emit('dm:newMessage', message);
        io.to(`user:${to.id}`).emit('dm:newMessage', message);
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/messages/thread') {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const userId = authUser.id;
      const targetId = searchParams.get('targetId');
      if (!areFriends(db, userId, targetId)) return json(res, 403, { error: 'Messaging is available for friends only' });
      const messages = db.messages.filter((m) => (m.from === userId && m.to === targetId) || (m.from === targetId && m.to === userId));
      let changed = false;
      for (const m of messages) {
        if (m.to === userId) {
          m.readBy = Array.isArray(m.readBy) ? m.readBy : [];
          if (!m.readBy.includes(userId)) { m.readBy.push(userId); changed = true; }
        }
      }
      if (changed) writeDb(db);
      return json(res, 200, { messages });
    }


    if (req.method === 'DELETE' && pathname.match(/^\/api\/messages\/[^/]+$/)) {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const messageId = pathname.split('/').pop();
      const idx = db.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return json(res, 404, { error: 'Message not found' });
      const msg = db.messages[idx];
      if (msg.from !== authUser.id && !isAdmin(authUser)) return json(res, 403, { error: 'Only owner can delete message' });
      db.messages = db.messages.filter((m) => m.id !== messageId && m.parentId !== messageId);
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'PUT' && pathname.match(/^\/api\/settings\/[^/]+$/)) {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const userId = pathname.split('/').pop();
      if (userId !== authUser.id) return json(res, 403, { error: 'Forbidden' });
      const body = await readBody(req);
      const user = authUser;
      if (!user) return json(res, 404, { error: 'User not found' });
      const status = sanitize(body.status, 120);
      const newPass = String(body.newPassword || '');
      const newEmail = sanitize(body.newEmail, 120).toLowerCase();
      const profileImage = validateImageDataUrl(body.profileImage || '');
      if (profileImage) user.profileImage = profileImage;
      user.statusEncrypted = Buffer.from(status || 'Blue team mode').toString('base64');
      if (newPass) {
        if (newPass.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });
        user.passwordHash = hash(newPass);
      }
      if (newEmail) {
        if (user.emailChanged >= 1) return json(res, 400, { error: 'Email can only be changed once' });
        if (db.users.some((u) => u.email === newEmail && u.id !== user.id)) return json(res, 409, { error: 'Email already used' });
        user.email = newEmail;
        user.emailChanged += 1;
      }
      writeDb(db);
      return json(res, 200, { user: publicUser(user) });
    }

    if (req.method === 'PUT' && pathname.match(/^\/api\/users\/[^/]+\/active$/)) {
      if (!authUser) return json(res, 401, { error: 'Unauthorized' });
      const userId = pathname.split('/')[3];
      if (userId !== authUser.id) return json(res, 403, { error: 'Forbidden' });
      const body = await readBody(req);
      const user = authUser;
      if (!user) return json(res, 404, { error: 'User not found' });
      user.active = !!body.active;
      writeDb(db);
      return json(res, 200, { user: publicUser(user) });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    return json(res, 500, { error: e.message || 'Server error' });
  }
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  if (urlObj.pathname.startsWith('/api/')) return handleApi(req, res, urlObj);
  return serveStatic(req, res, urlObj.pathname);
});

io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || '';
  const db = readDb();
  const user = getUserByToken(db, token);
  if (!user) return next(new Error('Unauthorized'));
  socket.user = user;
  return next();
});

io.on('connection', (socket) => {
  const userId = socket.user.id;
  socket.join(`user:${userId}`);
  socketUserMap.set(socket.id, userId);

  const p = getPresence(userId);
  if (p.offlineTimer) { clearTimeout(p.offlineTimer); p.offlineTimer = null; }
  p.connections += 1;
  p.sockets.add(socket.id);
  touchPresence(userId, false);

  socket.on('presence:watch', ({ userIds = [] } = {}) => {
    const clean = new Set(userIds.filter((id) => typeof id === 'string').slice(0, 100));
    socketWatchMap.set(socket.id, clean);
    for (const watchedId of clean) {
      const pr = onlineStateOf(watchedId);
      socket.emit('presence:update', { userId: watchedId, status: pr.status, lastActiveAt: pr.lastActiveAt });
    }
  });

  let lastActivityAt = 0;
  socket.on('presence:activity', ({ type = 'activity' } = {}) => {
    const nowMs = Date.now();
    if (type === 'activity' && nowMs - lastActivityAt < ACTIVITY_MIN_INTERVAL_MS) return;
    lastActivityAt = nowMs;
    touchPresence(userId, type === 'hidden');
  });

  socket.on('dm:join', ({ conversationId: convId, targetId } = {}) => {
    if (typeof convId !== 'string' || !convId.includes(':')) return;
    if (typeof targetId === 'string') {
      const db = readDb();
      if (!areFriends(db, userId, targetId)) return;
    }
    socket.join(`dm:${convId}`);
    touchPresence(userId, false);
  });

  socket.on('dm:typing', ({ targetId, isTyping } = {}) => {
    if (!targetId || targetId === userId) return;
    const db = readDb();
    if (!areFriends(db, userId, targetId)) return;
    io.to(`user:${targetId}`).emit('dm:typing', { from: userId, isTyping: !!isTyping });
  });

  socket.on('presence:logout', () => {
    const pp = getPresence(userId);
    pp.connections = 0;
    pp.sockets.clear();
    setPresenceStatus(userId, 'offline', now());
  });

  socket.on('disconnect', () => {
    socketUserMap.delete(socket.id);
    socketWatchMap.delete(socket.id);
    const curr = getPresence(userId);
    curr.sockets.delete(socket.id);
    curr.connections = Math.max(0, curr.connections - 1);
    if (curr.connections <= 0) {
      startOfflineGrace(userId);
    } else {
      touchPresence(userId, false);
    }
  });
});

ensureDb();
server.listen(PORT, () => console.log(`CypheraX backend at http://localhost:${PORT}`));
