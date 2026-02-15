const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 4173;
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'data', 'db.json');
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const defaultDb = { users: [], posts: [], friendRequests: [], friendships: [], messages: [], notifications: [], loginThrottle: {}, forumTopics: [], forumPosts: [] };

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
  if (Array.isArray(db.forumPosts)) {
    for (const fp of db.forumPosts) {
      if (!Array.isArray(fp.comments)) { fp.comments = []; changed = true; }
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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
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
  let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname.slice(1));
  if (!filePath.startsWith(ROOT)) return json(res, 403, { error: 'Forbidden' });
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(ROOT, 'index.html');
  const ext = path.extname(filePath).toLowerCase();
  const type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : ext === '.png' ? 'image/png' : ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(filePath).pipe(res);
}

function withUsers(db, posts) {
  return posts.map((p) => ({
    ...p,
    author: publicUser(db.users.find((u) => u.id === p.authorId)),
    comments: (p.comments || []).map((c) => ({ ...c, user: publicUser(db.users.find((u) => u.id === c.userId)) }))
  }));
}

async function handleApi(req, res, urlObj) {
  const db = readDb();
  const { pathname, searchParams } = urlObj;

  try {
    if (req.method === 'POST' && pathname === '/api/auth/register') {
      const body = await readBody(req);
      const username = sanitize(body.username, 20);
      const email = sanitize(body.email, 120).toLowerCase();
      const password = String(body.password || '');
      if (!/^[\w.-]{3,20}$/.test(username)) return json(res, 400, { error: 'Username invalid' });
      if (!/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { error: 'Email invalid' });
      if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) return json(res, 400, { error: 'Password policy failed' });
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
      writeDb(db);
      return json(res, 200, { user: publicUser(user) });
    }

    if (req.method === 'GET' && pathname === '/api/users/search') {
      const userId = searchParams.get('userId');
      const q = sanitize(searchParams.get('q') || '', 30).toLowerCase();
      const users = db.users.filter((u) => u.id !== userId && (!q || u.username.toLowerCase().includes(q))).slice(0, 15).map((u) => ({ ...publicUser(u), postCount: db.posts.filter((p) => p.authorId === u.id).length }));
      return json(res, 200, { users });
    }

    if (req.method === 'GET' && pathname.match(/^\/api\/users\/[^/]+\/posts$/)) {
      const targetId = pathname.split('/')[3];
      const user = db.users.find((u) => u.id === targetId);
      if (!user) return json(res, 404, { error: 'User not found' });
      const posts = withUsers(db, db.posts.filter((p) => p.authorId === targetId).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      return json(res, 200, { user: publicUser(user), posts });
    }

    if (req.method === 'GET' && pathname === '/api/posts') {
      const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);
      const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '20', 10), 1), 50);
      const sorted = db.posts.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const slice = sorted.slice(offset, offset + limit);
      return json(res, 200, { posts: withUsers(db, slice), total: sorted.length, hasMore: offset + limit < sorted.length, nextOffset: offset + slice.length });
    }

    if (req.method === 'POST' && pathname === '/api/posts') {
      const body = await readBody(req);
      const user = db.users.find((u) => u.id === body.userId);
      const content = sanitize(body.content, 500);
      const imageData = validateImageDataUrl(body.imageData || '');
      if (!user) return json(res, 404, { error: 'User not found' });
      if (!content && !imageData) return json(res, 400, { error: 'Post content required' });
      db.posts.push({ id: uid(), authorId: user.id, content, imageData, likes: [], comments: [], reports: [], createdAt: now(), editedAt: null });
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'PUT' && pathname.match(/^\/api\/posts\/[^/]+$/)) {
      const postId = pathname.split('/')[3];
      const body = await readBody(req);
      const post = db.posts.find((p) => p.id === postId);
      if (!post) return json(res, 404, { error: 'Post not found' });
      if (post.authorId !== body.userId) return json(res, 403, { error: 'Only author can edit' });
      const content = sanitize(body.content, 500);
      if (!content && !post.imageData) return json(res, 400, { error: 'Content required' });
      post.content = content;
      post.editedAt = now();
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && pathname.match(/^\/api\/posts\/[^/]+$/)) {
      const postId = pathname.split('/')[3];
      const body = await readBody(req);
      const idx = db.posts.findIndex((p) => p.id === postId);
      if (idx < 0) return json(res, 404, { error: 'Post not found' });
      if (db.posts[idx].authorId !== body.userId) return json(res, 403, { error: 'Only author can delete' });
      db.posts.splice(idx, 1);
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/posts\/[^/]+\/report$/)) {
      const postId = pathname.split('/')[3];
      const body = await readBody(req);
      const post = db.posts.find((p) => p.id === postId);
      const reporter = db.users.find((u) => u.id === body.userId);
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
      const postId = pathname.split('/')[3];
      const body = await readBody(req);
      const post = db.posts.find((p) => p.id === postId);
      const user = db.users.find((u) => u.id === body.userId);
      if (!post || !user) return json(res, 404, { error: 'Not found' });
      const liked = post.likes.includes(user.id);
      post.likes = liked ? post.likes.filter((id) => id !== user.id) : [...post.likes, user.id];
      if (!liked && post.authorId !== user.id) notify(db, post.authorId, 'like', `${user.username} liked your post.`);
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/posts\/[^/]+\/comment$/)) {
      const postId = pathname.split('/')[3];
      const body = await readBody(req);
      const post = db.posts.find((p) => p.id === postId);
      const user = db.users.find((u) => u.id === body.userId);
      const content = sanitize(body.content, 200);
      if (!post || !user) return json(res, 404, { error: 'Not found' });
      if (!content) return json(res, 400, { error: 'Content required' });
      post.comments.push({ id: uid(), userId: user.id, content, kind: body.kind === 'reply' ? 'reply' : 'comment', createdAt: now() });
      if (post.authorId !== user.id) notify(db, post.authorId, 'comment', `${user.username} replied to your post.`);
      writeDb(db);
      return json(res, 200, { ok: true });
    }


    if (req.method === 'GET' && pathname === '/api/forum/topics') {
      return json(res, 200, { topics: db.forumTopics });
    }

    if (req.method === 'GET' && pathname.match(/^\/api\/forum\/topics\/[^/]+\/posts$/)) {
      const topicId = pathname.split('/')[4];
      const posts = db.forumPosts
        .filter((p) => p.topicId === topicId)
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
      const topicId = pathname.split('/')[4];
      const body = await readBody(req);
      const author = db.users.find((u) => u.id === body.userId);
      const topic = db.forumTopics.find((t) => t.id === topicId);
      const content = sanitize(body.content, 700);
      if (!author || !topic) return json(res, 404, { error: 'Not found' });
      if (!content) return json(res, 400, { error: 'Content required' });
      db.forumPosts.push({ id: uid(), topicId, authorId: author.id, content, comments: [], createdAt: now() });
      writeDb(db);

      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/forum\/posts\/[^/]+\/comments$/)) {
      const postId = pathname.split('/')[4];
      const body = await readBody(req);
      const post = db.forumPosts.find((p) => p.id === postId);
      const user = db.users.find((u) => u.id === body.userId);
      const content = sanitize(body.content, 300);
      if (!post || !user) return json(res, 404, { error: 'Not found' });
      if (!content) return json(res, 400, { error: 'Content required' });
      post.comments = post.comments || [];
      post.comments.push({ id: uid(), userId: user.id, content, createdAt: now() });
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/friends/request') {

      const body = await readBody(req);
      const from = db.users.find((u) => u.id === body.from);
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
      const userId = pathname.split('/').pop();
      const requests = db.friendRequests.filter((r) => r.to === userId && r.status === 'pending').map((r) => ({ ...r, sender: publicUser(db.users.find((u) => u.id === r.from)) }));
      return json(res, 200, { requests });
    }

    if (req.method === 'POST' && pathname === '/api/friends/respond') {
      const body = await readBody(req);
      const request = db.friendRequests.find((r) => r.id === body.requestId && r.to === body.userId && r.status === 'pending');
      if (!request) return json(res, 404, { error: 'Request not found' });
      const me = db.users.find((u) => u.id === body.userId);
      request.status = body.action === 'accept' ? 'accepted' : 'rejected';
      if (request.status === 'accepted' && !areFriends(db, request.from, request.to)) db.friendships.push({ id: uid(), a: request.from, b: request.to, createdAt: now() });
      notify(db, request.from, 'friend', `${me.username} ${request.status} your friend request.`);
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname.match(/^\/api\/friends\/list\/[^/]+$/)) {
      const userId = pathname.split('/').pop();
      const ids = db.friendships.flatMap((f) => (f.a === userId ? [f.b] : (f.b === userId ? [f.a] : [])));
      return json(res, 200, { friends: db.users.filter((u) => ids.includes(u.id)).map(publicUser) });
    }

    if (req.method === 'GET' && pathname.match(/^\/api\/notifications\/[^/]+$/)) {
      const userId = pathname.split('/').pop();
      return json(res, 200, { notifications: db.notifications.filter((n) => n.userId === userId).slice(0, 30) });
    }

    if (req.method === 'POST' && pathname === '/api/messages') {
      const body = await readBody(req);
      const from = db.users.find((u) => u.id === body.from);
      const to = db.users.find((u) => u.id === body.to);
      if (!from || !to) return json(res, 404, { error: 'User not found' });
      if (!areFriends(db, from.id, to.id)) return json(res, 403, { error: 'You can message only friends' });
      const content = sanitize(body.content, 300);
      const imageData = validateImageDataUrl(body.imageData || '');
      if (!content && !imageData) return json(res, 400, { error: 'Message is empty' });
      db.messages.push({ id: uid(), from: from.id, to: to.id, content, imageData, createdAt: now() });
      notify(db, to.id, 'message', `${from.username} sent you a message.`);
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/messages/thread') {
      const userId = searchParams.get('userId');
      const targetId = searchParams.get('targetId');
      if (!areFriends(db, userId, targetId)) return json(res, 403, { error: 'Messaging is available for friends only' });
      const messages = db.messages.filter((m) => (m.from === userId && m.to === targetId) || (m.from === targetId && m.to === userId));
      return json(res, 200, { messages });
    }

    if (req.method === 'PUT' && pathname.match(/^\/api\/settings\/[^/]+$/)) {
      const userId = pathname.split('/').pop();
      const body = await readBody(req);
      const user = db.users.find((u) => u.id === userId);
      if (!user) return json(res, 404, { error: 'User not found' });
      const status = sanitize(body.status, 120);
      const newPass = String(body.newPassword || '');
      const newEmail = sanitize(body.newEmail, 120).toLowerCase();
      const profileImage = validateImageDataUrl(body.profileImage || '');
      if (profileImage) user.profileImage = profileImage;
      user.statusEncrypted = Buffer.from(status || 'Blue team mode').toString('base64');
      if (newPass) {
        if (newPass.length < 8 || !/[A-Z]/.test(newPass) || !/[0-9]/.test(newPass)) return json(res, 400, { error: 'Password policy failed' });
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
      const userId = pathname.split('/')[3];
      const body = await readBody(req);
      const user = db.users.find((u) => u.id === userId);
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

ensureDb();
server.listen(PORT, () => console.log(`CypheraX backend at http://localhost:${PORT}`));
