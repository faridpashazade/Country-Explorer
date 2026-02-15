const SESSION_KEY = 'cypherax_session_v3';
const DEFAULT_AVATAR = 'default-avatar.svg';

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
  topSearchResults: [],
  activeChatFriendId: ''
};

const TOPICS = ['Blue Team', 'SOC', 'Threat Intel', 'Cloud Security', 'OWASP', 'Malware Analysis'];

const el = (id) => document.getElementById(id);
const decode = (txt) => { try { return atob(txt || ''); } catch { return ''; } };
const sanitize = (txt, max = 500) => String(txt || '').replace(/[<>]/g, '').trim().slice(0, max);

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
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
  if (window.innerWidth <= 900) {
    el('mobile-nav').classList.add('hidden');
    el('mobile-menu-toggle').setAttribute('aria-expanded', 'false');
  }
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}

function ensureSafeImageFile(file) {
  if (!file) return;
  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.type)) throw new Error('Only image upload is allowed.');
  if (file.size > 2 * 1024 * 1024) throw new Error('Image must be less than 2MB.');
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
      body: JSON.stringify({ email: sanitize(el('login-email').value, 120), password: el('login-password').value })
    });
    state.user = data.user;
    localStorage.setItem(SESSION_KEY, JSON.stringify(state.user));
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
    api(`/api/users/search?userId=${encodeURIComponent(uid)}&q=${encodeURIComponent(sanitize(el('search-user').value, 30))}`),
    api(`/api/friends/requests/${uid}`),
    api(`/api/friends/list/${uid}`),
    api(`/api/notifications/${uid}`)
  ]);
  state.posts = posts.posts;
  state.users = users.users;
  state.requests = requests.requests;
  state.friends = friends.friends;
  state.notifications = notifications.notifications;
  if (!state.activeChatFriendId && state.friends[0]) state.activeChatFriendId = state.friends[0].id;
}

function renderHeader() {
  el('profile-name').textContent = state.user.username;
  el('profile-preview').src = state.user.profileImage || DEFAULT_AVATAR;
  el('active-status').textContent = `Status: ${state.user.active ? 'Active 🟢' : 'Away ⚪'}`;
  el('status-text').textContent = `Status message: ${decode(state.user.statusEncrypted) || 'Blue team mode'}`;
  el('status-input').value = decode(state.user.statusEncrypted) || '';
}

function renderTopics() {
  const wrap = el('topic-list');
  wrap.innerHTML = '';
  TOPICS.forEach((topic) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'topic-chip';
    chip.textContent = `#${topic}`;
    chip.onclick = () => {
      const area = el('post-content');
      area.value = `${area.value} #${topic.replace(/\s+/g, '')}`.trim();
      area.focus();
    };
    wrap.appendChild(chip);
  });
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
  if (!state.selectedProfile) return card.classList.add('hidden');
  const user = state.selectedProfile;
  const isFriend = state.friends.some((f) => f.id === user.id);
  card.classList.remove('hidden');
  card.innerHTML = `<div class="row"><span>@${user.username} profile view</span><div class="actions"></div></div>`;
  const actions = card.querySelector('.actions');

  if (!isFriend) {
    const addBtn = document.createElement('button');
    addBtn.textContent = 'Add Friend';
    addBtn.onclick = () => sendFriendRequest(user.id);
    actions.appendChild(addBtn);
  } else {
    const msgBtn = document.createElement('button');
    msgBtn.textContent = 'Message ✉️';
    msgBtn.onclick = async () => {
      state.activeChatFriendId = user.id;
      switchView('messages');
      await renderMessages();
    };
    actions.appendChild(msgBtn);
  }

  const clearBtn = document.createElement('button');
  clearBtn.className = 'danger';
  clearBtn.textContent = 'Back';
  clearBtn.onclick = async () => { state.selectedProfile = null; await renderApp(); };
  actions.appendChild(clearBtn);
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
    postEl.append(title, p);

    if (post.imageData) {
      const postImg = document.createElement('img');
      postImg.src = post.imageData;
      postImg.className = 'post-image';
      postEl.appendChild(postImg);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    const likeBtn = document.createElement('button');
    const liked = post.likes.includes(state.user.id);
    likeBtn.textContent = `${liked ? 'Unlike' : 'Like'} (${post.likes.length})`;
    likeBtn.onclick = async () => {
      await api(`/api/posts/${post.id}/like`, { method: 'POST', body: JSON.stringify({ userId: state.user.id }) });
      await renderApp();
    };
    const input = document.createElement('input');
    input.placeholder = 'Comment...';
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
    postEl.appendChild(actions);

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
    item.innerHTML = `<span>${u.username} (${u.active ? 'active' : 'away'}) • Posts: ${u.postCount}</span><div class="actions"></div>`;
    const actions = item.querySelector('.actions');

    const viewBtn = document.createElement('button');
    viewBtn.textContent = 'View Posts';
    viewBtn.onclick = () => openUserProfile(u);
    actions.appendChild(viewBtn);

    const btn = document.createElement('button');
    btn.textContent = isFriend ? 'Friends' : 'Add Friend';
    btn.disabled = isFriend;
    btn.onclick = () => sendFriendRequest(u.id);
    actions.appendChild(btn);

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

function renderDmFriendList() {
  const wrap = el('dm-friend-list');
  wrap.innerHTML = '';
  if (!state.friends.length) {
    wrap.textContent = 'No friends yet.';
    return;
  }
  state.friends.forEach((f) => {
    const btn = document.createElement('button');
    btn.className = `dm-friend-item ${state.activeChatFriendId === f.id ? 'active' : ''}`;
    btn.type = 'button';
    btn.textContent = `@${f.username}`;
    btn.onclick = async () => { state.activeChatFriendId = f.id; await renderMessages(); };
    wrap.appendChild(btn);
  });
}

async function renderMessages() {
  renderDmFriendList();
  const thread = el('message-thread');
  thread.innerHTML = '';
  if (!state.activeChatFriendId) {
    thread.textContent = 'You can message only your friends.';
    return;
  }

  const data = await api(`/api/messages/thread?userId=${state.user.id}&targetId=${state.activeChatFriendId}`);
  state.messages = data.messages;
  state.messages.forEach((m) => {
    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${m.from === state.user.id ? 'mine' : ''}`;
    bubble.innerHTML = `<strong>${m.from === state.user.id ? 'Me' : 'Friend'}</strong>`;
    if (m.content) {
      const text = document.createElement('p');
      text.textContent = m.content;
      bubble.appendChild(text);
    }
    if (m.imageData) {
      const img = document.createElement('img');
      img.src = m.imageData;
      img.alt = 'message attachment';
      img.className = 'message-image';
      bubble.appendChild(img);
    }
    thread.appendChild(bubble);
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
  if (!state.topSearchResults.length) return wrap.classList.add('hidden');

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
  if (!q) {
    state.topSearchResults = [];
    return renderTopSearchResults();
  }
  const data = await api(`/api/users/search?userId=${encodeURIComponent(state.user.id)}&q=${encodeURIComponent(q)}`);
  state.topSearchResults = data.users.slice(0, 8);
  renderTopSearchResults();
}

function connectEmojiButtons() {
  document.querySelectorAll('.emoji-bar').forEach((bar) => {
    const target = el(bar.dataset.target);
    bar.querySelectorAll('.emoji-btn').forEach((btn) => {
      btn.onclick = () => {
        target.value = `${target.value}${btn.textContent}`;
        target.focus();
      };
    });
  });
}

async function renderApp() {
  if (!state.user) return toggleAuth(false);
  toggleAuth(true);
  await fetchAppData();
  renderHeader();
  renderTopics();
  switchView(state.view);
  renderSelectedProfileCard();
  renderFeed();
  renderNetwork();
  renderNotifications();
  await renderMessages();
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
el('open-messages-btn').addEventListener('click', async () => { switchView('messages'); await renderMessages(); });

el('toggle-active-btn').addEventListener('click', async () => {
  const data = await api(`/api/users/${state.user.id}/active`, { method: 'PUT', body: JSON.stringify({ active: !state.user.active }) });
  state.user = data.user;
  localStorage.setItem(SESSION_KEY, JSON.stringify(state.user));
  await renderApp();
});

document.querySelectorAll('.nav-btn').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));
el('mobile-menu-toggle').addEventListener('click', () => {
  const mobileNav = el('mobile-nav');
  const willShow = mobileNav.classList.contains('hidden');
  mobileNav.classList.toggle('hidden', !willShow);
  el('mobile-menu-toggle').setAttribute('aria-expanded', willShow ? 'true' : 'false');
});

el('search-user').addEventListener('input', renderApp);
el('top-search-user').addEventListener('input', onTopSearchInput);
document.addEventListener('click', (event) => {
  if (!el('top-search-results').contains(event.target) && event.target !== el('top-search-user')) {
    state.topSearchResults = [];
    renderTopSearchResults();
  }
});

el('post-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const content = sanitize(el('post-content').value, 500);
    const file = el('post-image').files[0];
    ensureSafeImageFile(file);
    const imageData = file ? await fileToDataUrl(file) : '';
    if (!content && !imageData) return;
    await api('/api/posts', { method: 'POST', body: JSON.stringify({ userId: state.user.id, content, imageData }) });
    e.target.reset();
    await renderApp();
  } catch (err) {
    alert(err.message);
  }
});

el('message-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const content = sanitize(el('message-input').value, 300);
    const file = el('message-image').files[0];
    ensureSafeImageFile(file);
    const imageData = file ? await fileToDataUrl(file) : '';
    if (!state.activeChatFriendId || (!content && !imageData)) return;
    await api('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ from: state.user.id, to: state.activeChatFriendId, content, imageData })
    });
    e.target.reset();
    await renderMessages();
  } catch (err) {
    alert(err.message);
  }
});

el('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const file = el('profile-image-file').files[0];
    ensureSafeImageFile(file);
    const profileImage = file ? await fileToDataUrl(file) : '';
    const data = await api(`/api/settings/${state.user.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        profileImage,
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

connectEmojiButtons();
renderApp();
