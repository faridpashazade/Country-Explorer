const STORAGE_KEY = 'cyberconnect_db_v1';
const SESSION_KEY = 'cyberconnect_session_v1';

const defaults = {
  users: [],
  posts: [],
  friendRequests: [],
  friendships: [],
  messages: [],
  notifications: [],
  loginThrottle: {}
};

const state = {
  db: loadDb(),
  session: JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'),
  view: 'feed'
};

function loadDb() {
  const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  return parsed ? { ...defaults, ...parsed } : structuredClone(defaults);
}
function saveDb() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.db)); }
function saveSession() { localStorage.setItem(SESSION_KEY, JSON.stringify(state.session)); }

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const hash = (txt) => btoa(unescape(encodeURIComponent(txt)));
const decrypt = (txt) => { try { return decodeURIComponent(escape(atob(txt))); } catch { return 'unreadable'; } };
const sanitize = (txt, max = 500) => String(txt || '').replace(/[<>]/g, '').trim().slice(0, max);

const el = (id) => document.getElementById(id);
const authPanel = el('auth-panel');
const appPanel = el('app-panel');
const authMessage = el('auth-message');

function currentUser() {
  if (!state.session) return null;
  return state.db.users.find((u) => u.id === state.session.userId) || null;
}

function render() {
  const user = currentUser();
  if (!user) {
    authPanel.classList.remove('hidden');
    appPanel.classList.add('hidden');
    return;
  }
  authPanel.classList.add('hidden');
  appPanel.classList.remove('hidden');
  el('profile-name').textContent = user.username;
  el('profile-preview').src = user.profileImage || 'img.png';
  el('active-status').textContent = `Status: ${user.active ? 'Active 🟢' : 'Away ⚪'}`;
  el('encrypted-status').textContent = `Encrypted status: ${user.statusEncrypted || hash('Blue team mode')}`;
  renderNavView();
  renderFeed();
  renderNetwork();
  renderMessages();
  renderNotifications();
  prefillSettings(user);
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  el(`${view}-view`).classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
}
function renderNavView() { switchView(state.view); }

function registerUser(e) {
  e.preventDefault();
  const username = sanitize(el('register-username').value, 20);
  const email = sanitize(el('register-email').value, 120).toLowerCase();
  const password = el('register-password').value;
  if (!/^[\w.-]{3,20}$/.test(username)) return setAuthMsg('Username only letters/numbers/_ and 3-20 chars', true);
  if (!/^\S+@\S+\.\S+$/.test(email)) return setAuthMsg('Email format invalid', true);
  if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) return setAuthMsg('Password min 8 + uppercase + number', true);
  if (state.db.users.some((u) => u.email === email)) return setAuthMsg('Email already exists', true);

  const user = { id: uid(), username, email, passwordHash: hash(password), emailChanged: 0, profileImage: '', active: true, statusEncrypted: hash('Blue team standby'), createdAt: now() };
  state.db.users.push(user);
  saveDb();
  setAuthMsg('Registration completed. You can login now.');
  document.querySelector('[data-auth-tab="login"]').click();
  e.target.reset();
}

function loginUser(e) {
  e.preventDefault();
  const email = sanitize(el('login-email').value, 120).toLowerCase();
  const password = el('login-password').value;
  const throttle = state.db.loginThrottle[email] || { count: 0, blockedUntil: 0 };
  if (Date.now() < throttle.blockedUntil) return setAuthMsg('Temporarily blocked. Try later.', true);

  const user = state.db.users.find((u) => u.email === email && u.passwordHash === hash(password));
  if (!user) {
    throttle.count += 1;
    if (throttle.count >= 5) { throttle.blockedUntil = Date.now() + 60_000; throttle.count = 0; }
    state.db.loginThrottle[email] = throttle;
    saveDb();
    return setAuthMsg('Invalid credentials', true);
  }

  state.db.loginThrottle[email] = { count: 0, blockedUntil: 0 };
  user.active = true;
  state.session = { userId: user.id, token: uid(), lastActivity: Date.now() };
  saveDb();
  saveSession();
  e.target.reset();
  setAuthMsg('');
  render();
}

function logout() {
  state.session = null;
  localStorage.removeItem(SESSION_KEY);
  render();
}

function notify(userId, type, text) {
  state.db.notifications.unshift({ id: uid(), userId, type, text: sanitize(text, 200), createdAt: now() });
}

function renderFeed() {
  const user = currentUser();
  const wrap = el('post-list');
  wrap.innerHTML = '';
  const posts = state.db.posts.slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  posts.forEach((post) => {
    const author = state.db.users.find((u) => u.id === post.authorId);
    const postEl = document.createElement('article');
    postEl.className = 'post';

    const head = document.createElement('div'); head.className = 'row';
    const hTitle = document.createElement('strong'); hTitle.textContent = `${author?.username || 'Unknown'} • ${new Date(post.createdAt).toLocaleString()}`;
    head.appendChild(hTitle);

    const body = document.createElement('p'); body.textContent = post.content;
    const actions = document.createElement('div'); actions.className = 'actions';
    const likeBtn = document.createElement('button');
    const liked = post.likes.includes(user.id);
    likeBtn.textContent = `${liked ? 'Unlike' : 'Like'} (${post.likes.length})`;
    likeBtn.onclick = () => {
      post.likes = liked ? post.likes.filter((id) => id !== user.id) : [...post.likes, user.id];
      if (!liked && post.authorId !== user.id) notify(post.authorId, 'like', `${user.username} liked your post.`);
      saveDb(); renderFeed(); renderNotifications();
    };

    const commentInput = document.createElement('input'); commentInput.placeholder = 'Add comment';
    commentInput.maxLength = 200;
    const commentBtn = document.createElement('button'); commentBtn.textContent = 'Comment';
    commentBtn.onclick = () => {
      const content = sanitize(commentInput.value, 200);
      if (!content) return;
      post.comments.push({ id: uid(), userId: user.id, content, createdAt: now() });
      if (post.authorId !== user.id) notify(post.authorId, 'comment', `${user.username} commented on your post.`);
      saveDb(); renderFeed(); renderNotifications();
    };
    actions.append(likeBtn, commentInput, commentBtn);
    postEl.append(head, body, actions);

    post.comments.forEach((c) => {
      const commenter = state.db.users.find((u) => u.id === c.userId);
      const cEl = document.createElement('div'); cEl.className = 'comment';
      cEl.textContent = `${commenter?.username || 'Unknown'}: ${c.content}`;
      postEl.appendChild(cEl);
    });
    wrap.appendChild(postEl);
  });
}

function renderNetwork() {
  const user = currentUser();
  const term = sanitize(el('search-user').value, 30).toLowerCase();
  const result = el('user-results');
  result.innerHTML = '';

  state.db.users.filter((u) => u.id !== user.id && (!term || u.username.toLowerCase().includes(term))).forEach((u) => {
    const item = document.createElement('div'); item.className = 'item row';
    const isFriend = state.db.friendships.some((f) => f.a === user.id && f.b === u.id || f.a === u.id && f.b === user.id);
    const outgoing = state.db.friendRequests.some((r) => r.from === user.id && r.to === u.id && r.status === 'pending');
    const info = document.createElement('span'); info.textContent = `${u.username} (${u.active ? 'active' : 'away'})`;
    const postCount = state.db.posts.filter((p) => p.authorId === u.id).length;
    const posts = document.createElement('span'); posts.className = 'small'; posts.textContent = `Posts: ${postCount}`;
    const btn = document.createElement('button');
    btn.disabled = isFriend || outgoing;
    btn.textContent = isFriend ? 'Friends' : outgoing ? 'Requested' : 'Add Friend';
    btn.onclick = () => {
      state.db.friendRequests.push({ id: uid(), from: user.id, to: u.id, status: 'pending', createdAt: now() });
      notify(u.id, 'friend', `${user.username} sent you a friend request.`);
      saveDb(); renderNetwork(); renderNotifications();
    };
    item.append(info, posts, btn);
    result.appendChild(item);
  });

  const reqWrap = el('friend-requests');
  reqWrap.innerHTML = '';
  state.db.friendRequests.filter((r) => r.to === user.id && r.status === 'pending').forEach((r) => {
    const sender = state.db.users.find((u) => u.id === r.from);
    const item = document.createElement('div'); item.className = 'item row';
    const txt = document.createElement('span'); txt.textContent = `${sender?.username} sent a request`;
    const accept = document.createElement('button'); accept.textContent = 'Accept';
    const reject = document.createElement('button'); reject.textContent = 'Reject'; reject.className = 'danger';
    accept.onclick = () => {
      r.status = 'accepted';
      state.db.friendships.push({ id: uid(), a: r.from, b: r.to, createdAt: now() });
      notify(r.from, 'friend', `${user.username} accepted your friend request.`);
      saveDb(); renderNetwork(); renderMessages(); renderNotifications();
    };
    reject.onclick = () => {
      r.status = 'rejected';
      notify(r.from, 'friend', `${user.username} rejected your friend request.`);
      saveDb(); renderNetwork(); renderNotifications();
    };
    item.append(txt, accept, reject);
    reqWrap.appendChild(item);
  });
}

function friendsOf(userId) {
  return state.db.friendships.flatMap((f) => {
    if (f.a === userId) return [f.b];
    if (f.b === userId) return [f.a];
    return [];
  });
}

function renderMessages() {
  const user = currentUser();
  const targetSelect = el('message-target');
  const friends = friendsOf(user.id).map((id) => state.db.users.find((u) => u.id === id)).filter(Boolean);
  targetSelect.innerHTML = '';
  friends.forEach((f) => {
    const opt = document.createElement('option'); opt.value = f.id; opt.textContent = f.username;
    targetSelect.appendChild(opt);
  });

  const thread = el('message-thread');
  thread.innerHTML = '';
  const targetId = targetSelect.value;
  if (!targetId) { thread.textContent = 'You can message after becoming friends.'; return; }
  state.db.messages
    .filter((m) => (m.from === user.id && m.to === targetId) || (m.from === targetId && m.to === user.id))
    .forEach((m) => {
      const bubble = document.createElement('div'); bubble.className = 'message-bubble';
      bubble.textContent = `${m.from === user.id ? 'Me' : 'Them'}: ${m.content}`;
      thread.appendChild(bubble);
    });
}

function renderNotifications() {
  const user = currentUser();
  const wrap = el('notification-list');
  wrap.innerHTML = '';
  state.db.notifications.filter((n) => n.userId === user.id).slice(0, 30).forEach((n) => {
    const item = document.createElement('div'); item.className = 'item';
    item.textContent = `${new Date(n.createdAt).toLocaleString()} — ${n.text}`;
    wrap.appendChild(item);
  });
}

function prefillSettings(user) {
  el('profile-image-input').value = user.profileImage || '';
  el('status-input').value = decrypt(user.statusEncrypted || '');
}

function setAuthMsg(msg, isErr = false) {
  authMessage.style.color = isErr ? '#ff9db0' : '#9fffb0';
  authMessage.textContent = msg;
}

document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-auth-tab]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const login = btn.dataset.authTab === 'login';
    el('login-form').classList.toggle('hidden', !login);
    el('register-form').classList.toggle('hidden', login);
    setAuthMsg('');
  });
});

el('register-form').addEventListener('submit', registerUser);
el('login-form').addEventListener('submit', loginUser);
el('logout-btn').addEventListener('click', logout);
el('toggle-active-btn').addEventListener('click', () => {
  const user = currentUser();
  user.active = !user.active;
  saveDb(); render();
});

document.querySelectorAll('.nav-btn').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));
el('search-user').addEventListener('input', renderNetwork);

el('post-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const user = currentUser();
  const content = sanitize(el('post-content').value, 500);
  if (!content) return;
  state.db.posts.push({ id: uid(), authorId: user.id, content, likes: [], comments: [], createdAt: now() });
  saveDb();
  e.target.reset();
  renderFeed();
});

el('message-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const user = currentUser();
  const to = el('message-target').value;
  const content = sanitize(el('message-input').value, 300);
  if (!to || !content) return;
  state.db.messages.push({ id: uid(), from: user.id, to, content, createdAt: now() });
  notify(to, 'message', `${user.username} sent you a message.`);
  saveDb();
  e.target.reset();
  renderMessages();
  renderNotifications();
});

el('message-target').addEventListener('change', renderMessages);

el('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const user = currentUser();
  const img = sanitize(el('profile-image-input').value, 250);
  const statusPlain = sanitize(el('status-input').value, 120);
  const newPass = el('new-password').value;
  const newEmail = sanitize(el('new-email').value, 120).toLowerCase();

  if (img) user.profileImage = img;
  user.statusEncrypted = hash(statusPlain || 'Blue team mode');
  if (newPass) {
    if (newPass.length < 8 || !/[A-Z]/.test(newPass) || !/[0-9]/.test(newPass)) return el('settings-message').textContent = 'Password policy failed';
    user.passwordHash = hash(newPass);
  }
  if (newEmail) {
    if (user.emailChanged >= 1) return el('settings-message').textContent = 'Email can only be changed once';
    if (state.db.users.some((u) => u.email === newEmail && u.id !== user.id)) return el('settings-message').textContent = 'Email already used';
    user.email = newEmail;
    user.emailChanged += 1;
  }
  saveDb();
  el('settings-message').textContent = 'Settings saved.';
  render();
});

setInterval(() => {
  if (!state.session) return;
  if (Date.now() - (state.session.lastActivity || 0) > 30 * 60 * 1000) {
    logout();
    setAuthMsg('Session expired due to inactivity', true);
  }
}, 5000);

document.addEventListener('click', () => {
  if (state.session) {
    state.session.lastActivity = Date.now();
    saveSession();
  }
});

render();
