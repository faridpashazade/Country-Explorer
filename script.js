const SESSION_KEY = 'cyberconnect_session_v2';
const state = {
  user: JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'),
  view: 'feed',
  posts: [],
  users: [],
  requests: [],
  friends: [],
  notifications: [],
  messages: [],
  selectedProfile: null,
  topSearchResults: []
};

const el = (id) => document.getElementById(id);
const decode = (txt) => { try { return atob(txt || ''); } catch { return ''; } };
const sanitize = (txt, max = 500) => String(txt || '').replace(/[<>]/g, '').trim().slice(0, max);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function setAuthMsg(msg, isErr = false) {
  const m = el('auth-message');
  m.style.color = isErr ? '#ff9db0' : '#9fffb0';
  m.textContent = msg;
}

function toggleAuth(showApp) {
  el('auth-panel').classList.toggle('hidden', showApp);
  el('app-panel').classList.toggle('hidden', !showApp);
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  el(`${view}-view`).classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const mobileNav = el('mobile-nav');
  const menuBtn = el('mobile-menu-toggle');
  if (mobileNav && menuBtn && window.innerWidth <= 900) {
    mobileNav.classList.add('hidden');
    menuBtn.setAttribute('aria-expanded', 'false');
  }
}

async function registerUser(e) {
  e.preventDefault();
  try {
    await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: sanitize(el('register-username').value, 20),
        email: sanitize(el('register-email').value, 120),
        password: el('register-password').value
      })
    });
    setAuthMsg('Registration successful. Login now.');
    document.querySelector('[data-auth-tab="login"]').click();
    e.target.reset();
  } catch (err) {
    setAuthMsg(err.message, true);
  }
}

async function loginUser(e) {
  e.preventDefault();
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: sanitize(el('login-email').value, 120),
        password: el('login-password').value
      })
    });
    state.user = data.user;
    localStorage.setItem(SESSION_KEY, JSON.stringify(state.user));
    setAuthMsg('');
    e.target.reset();
    await renderApp();
  } catch (err) {
    setAuthMsg(err.message, true);
  }
}

function logout() {
  state.user = null;
  localStorage.removeItem(SESSION_KEY);
  toggleAuth(false);
}

async function fetchAppData() {
  const uid = state.user.id;
  const [posts, users, requests, friends, notifications] = await Promise.all([
    api('/api/posts'),
    api(`/api/users/search?userId=${encodeURIComponent(uid)}&q=${encodeURIComponent(sanitize(el('search-user')?.value || '', 30))}`),
    api(`/api/friends/requests/${uid}`),
    api(`/api/friends/list/${uid}`),
    api(`/api/notifications/${uid}`)
  ]);
  state.posts = posts.posts;
  state.users = users.users;
  state.requests = requests.requests;
  state.friends = friends.friends;
  state.notifications = notifications.notifications;
}

function renderHeader() {
  el('profile-name').textContent = state.user.username;
  el('profile-preview').src = state.user.profileImage || 'img.png';
  el('active-status').textContent = `Status: ${state.user.active ? 'Active 🟢' : 'Away ⚪'}`;
  el('status-text').textContent = `Status message: ${decode(state.user.statusEncrypted) || 'Blue team mode'}`;
  el('profile-image-input').value = state.user.profileImage || '';
  el('status-input').value = decode(state.user.statusEncrypted) || '';
}

async function sendFriendRequest(targetId) {
  await api('/api/friends/request', { method: 'POST', body: JSON.stringify({ from: state.user.id, to: targetId }) });
  await renderApp();
}

async function openUserProfile(user) {
  if (!user) return;
  state.selectedProfile = user;
  const { posts } = await api(`/api/users/${user.id}/posts?viewerId=${state.user.id}`);
  state.posts = posts;
  switchView('feed');
  renderSelectedProfileCard();
  renderFeed();
}

function renderSelectedProfileCard() {
  const card = el('selected-profile-card');
  if (!state.selectedProfile) {
    card.classList.add('hidden');
    return;
  }

  const user = state.selectedProfile;
  const isFriend = state.friends.some((f) => f.id === user.id);
  card.innerHTML = '';

  const row = document.createElement('div');
  row.className = 'row';
  const text = document.createElement('span');
  text.textContent = `@${user.username} profile view • Posts: ${user.postCount || 0}`;

  const actions = document.createElement('div');
  actions.className = 'actions';

  if (!isFriend) {
    const addBtn = document.createElement('button');
    addBtn.textContent = 'Add Friend';
    addBtn.onclick = async () => sendFriendRequest(user.id);
    actions.appendChild(addBtn);
  } else {
    const msgBtn = document.createElement('button');
    msgBtn.textContent = 'Message';
    msgBtn.onclick = () => {
      switchView('messages');
      el('message-target').value = user.id;
      renderMessages();
    };
    actions.appendChild(msgBtn);
  }

  const clearBtn = document.createElement('button');
  clearBtn.className = 'danger';
  clearBtn.textContent = 'Back to all posts';
  clearBtn.onclick = async () => {
    state.selectedProfile = null;
    await renderApp();
  };
  actions.appendChild(clearBtn);

  row.append(text, actions);
  card.appendChild(row);
  card.classList.remove('hidden');
}

function renderFeed() {
  el('feed-title').textContent = state.selectedProfile ? `Posts by @${state.selectedProfile.username}` : 'Community Feed';
  const wrap = el('post-list');
  wrap.innerHTML = '';
  state.posts.forEach((post) => {
    const postEl = document.createElement('article');
    postEl.className = 'post';
    const title = document.createElement('strong');
    title.textContent = `${post.author?.username || 'Unknown'} • ${new Date(post.createdAt).toLocaleString()}`;
    const p = document.createElement('p');
    p.textContent = post.content;

    const actions = document.createElement('div');
    actions.className = 'actions';
    const liked = post.likes.includes(state.user.id);
    const likeBtn = document.createElement('button');
    likeBtn.textContent = `${liked ? 'Unlike' : 'Like'} (${post.likes.length})`;
    likeBtn.onclick = async () => {
      await api(`/api/posts/${post.id}/like`, { method: 'POST', body: JSON.stringify({ userId: state.user.id }) });
      await renderApp();
    };

    const input = document.createElement('input');
    input.placeholder = 'Add comment';
    input.maxLength = 200;
    const cBtn = document.createElement('button');
    cBtn.textContent = 'Comment';
    cBtn.onclick = async () => {
      const content = sanitize(input.value, 200);
      if (!content) return;
      await api(`/api/posts/${post.id}/comment`, { method: 'POST', body: JSON.stringify({ userId: state.user.id, content }) });
      await renderApp();
    };
    actions.append(likeBtn, input, cBtn);

    postEl.append(title, p, actions);
    post.comments.forEach((c) => {
      const ce = document.createElement('div');
      ce.className = 'comment';
      ce.textContent = `${c.user?.username || 'Unknown'}: ${c.content}`;
      postEl.appendChild(ce);
    });
    wrap.appendChild(postEl);
  });
}

function renderNetwork() {
  const result = el('user-results');
  result.innerHTML = '';
  state.users.forEach((u) => {
    const item = document.createElement('div');
    item.className = 'item row';
    const isFriend = state.friends.some((f) => f.id === u.id);
    const text = document.createElement('span');
    text.textContent = `${u.username} (${u.active ? 'active' : 'away'}) • Posts: ${u.postCount}`;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const viewBtn = document.createElement('button');
    viewBtn.textContent = 'View Posts';
    viewBtn.onclick = () => openUserProfile(u);
    actions.appendChild(viewBtn);

    const btn = document.createElement('button');
    btn.textContent = isFriend ? 'Friends' : 'Add Friend';
    btn.disabled = isFriend;
    btn.onclick = async () => sendFriendRequest(u.id);
    actions.appendChild(btn);

    item.append(text, actions);
    result.appendChild(item);
  });

  const reqWrap = el('friend-requests');
  reqWrap.innerHTML = '';
  state.requests.forEach((r) => {
    const item = document.createElement('div');
    item.className = 'item row';
    const txt = document.createElement('span');
    txt.textContent = `${r.sender?.username || 'User'} sent request`;
    const a = document.createElement('button'); a.textContent = 'Accept';
    const b = document.createElement('button'); b.textContent = 'Reject'; b.className = 'danger';
    a.onclick = async () => { await api('/api/friends/respond', { method: 'POST', body: JSON.stringify({ requestId: r.id, action: 'accept', userId: state.user.id }) }); await renderApp(); };
    b.onclick = async () => { await api('/api/friends/respond', { method: 'POST', body: JSON.stringify({ requestId: r.id, action: 'reject', userId: state.user.id }) }); await renderApp(); };
    item.append(txt, a, b);
    reqWrap.appendChild(item);
  });
}

async function renderMessages() {
  const select = el('message-target');
  const prev = select.value;
  select.innerHTML = '';
  state.friends.forEach((f) => {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = f.username;
    select.appendChild(o);
  });
  if (prev && state.friends.some((f) => f.id === prev)) select.value = prev;

  const thread = el('message-thread');
  thread.innerHTML = '';
  if (!select.value) { thread.textContent = 'You can message only your friends.'; return; }
  const data = await api(`/api/messages/thread?userId=${state.user.id}&targetId=${select.value}`);
  state.messages = data.messages;
  state.messages.forEach((m) => {
    const b = document.createElement('div');
    b.className = 'message-bubble';

    const who = document.createElement('strong');
    who.textContent = m.from === state.user.id ? 'Me' : 'Them';
    b.appendChild(who);

    if (m.content) {
      const text = document.createElement('p');
      text.textContent = m.content;
      b.appendChild(text);
    }

    if (m.imageData) {
      const img = document.createElement('img');
      img.src = m.imageData;
      img.alt = 'message attachment';
      img.className = 'message-image';
      b.appendChild(img);
    }

    thread.appendChild(b);
  });
}

function renderNotifications() {
  const wrap = el('notification-list');
  wrap.innerHTML = '';
  state.notifications.forEach((n) => {
    const item = document.createElement('div');
    item.className = 'item';
    item.textContent = `${new Date(n.createdAt).toLocaleString()} — ${n.text}`;
    wrap.appendChild(item);
  });
}

function renderTopSearchResults() {
  const wrap = el('top-search-results');
  wrap.innerHTML = '';
  if (!state.topSearchResults.length) {
    wrap.classList.add('hidden');
    return;
  }

  state.topSearchResults.forEach((u) => {
    const btn = document.createElement('button');
    btn.className = 'search-result-item';
    btn.type = 'button';
    btn.textContent = `${u.username} • ${u.postCount} posts`;
    btn.onclick = async () => {
      el('top-search-user').value = '';
      state.topSearchResults = [];
      renderTopSearchResults();
      await openUserProfile(u);
    };
    wrap.appendChild(btn);
  });
  wrap.classList.remove('hidden');
}

async function onTopSearchInput() {
  const q = sanitize(el('top-search-user').value, 30);
  if (q.length < 1) {
    state.topSearchResults = [];
    renderTopSearchResults();
    return;
  }
  const data = await api(`/api/users/search?userId=${encodeURIComponent(state.user.id)}&q=${encodeURIComponent(q)}`);
  state.topSearchResults = data.users.slice(0, 8);
  renderTopSearchResults();
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}

async function renderApp() {
  if (!state.user) return toggleAuth(false);
  toggleAuth(true);
  await fetchAppData();
  renderHeader();
  switchView(state.view);
  renderSelectedProfileCard();
  renderFeed();
  renderNetwork();
  renderNotifications();
  await renderMessages();
}

// events
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

el('toggle-active-btn').addEventListener('click', async () => {
  const active = !state.user.active;
  const data = await api(`/api/users/${state.user.id}/active`, { method: 'PUT', body: JSON.stringify({ active }) });
  state.user = data.user;
  localStorage.setItem(SESSION_KEY, JSON.stringify(state.user));
  await renderApp();
});

document.querySelectorAll('.nav-btn').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));
const mobileMenuBtn = el('mobile-menu-toggle');
if (mobileMenuBtn) {
  mobileMenuBtn.addEventListener('click', () => {
    const mobileNav = el('mobile-nav');
    const willShow = mobileNav.classList.contains('hidden');
    mobileNav.classList.toggle('hidden', !willShow);
    mobileMenuBtn.setAttribute('aria-expanded', willShow ? 'true' : 'false');
  });
}

el('search-user').addEventListener('input', renderApp);
el('top-search-user').addEventListener('input', onTopSearchInput);
document.addEventListener('click', (event) => {
  if (!el('top-search-results').contains(event.target) && event.target !== el('top-search-user')) {
    state.topSearchResults = [];
    renderTopSearchResults();
  }
});
el('message-target').addEventListener('change', renderMessages);

el('post-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = sanitize(el('post-content').value, 500);
  if (!content) return;
  await api('/api/posts', { method: 'POST', body: JSON.stringify({ userId: state.user.id, content }) });
  e.target.reset();
  await renderApp();
});

el('message-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const to = el('message-target').value;
    const content = sanitize(el('message-input').value, 300);
    const file = el('message-image').files[0];
    let imageData = '';

    if (file) {
      const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
      if (!allowed.includes(file.type)) throw new Error('Only image files are allowed.');
      if (file.size > 2 * 1024 * 1024) throw new Error('Image must be less than 2MB.');
      imageData = await fileToDataUrl(file);
    }

    if (!to || (!content && !imageData)) return;
    await api('/api/messages', { method: 'POST', body: JSON.stringify({ from: state.user.id, to, content, imageData }) });
    e.target.reset();
    await renderApp();
  } catch (err) {
    alert(err.message);
  }
});

el('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api(`/api/settings/${state.user.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        profileImage: sanitize(el('profile-image-input').value, 250),
        status: sanitize(el('status-input').value, 120),
        newPassword: el('new-password').value,
        newEmail: sanitize(el('new-email').value, 120)
      })
    });
    state.user = data.user;
    localStorage.setItem(SESSION_KEY, JSON.stringify(state.user));
    el('settings-message').textContent = 'Settings saved.';
    e.target.reset();
    await renderApp();
  } catch (err) {
    el('settings-message').textContent = err.message;
  }
});

renderApp();
