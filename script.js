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
  activeChatFriendId: '',
  feedOffset: 0,
  feedLimit: 20,
  hasMorePosts: true,
  loadingPosts: false
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
    await renderApp(true);
  } catch (err) {
    setAuthMsg(err.message, true);
  }
}

function logout() {
  state.user = null;
  localStorage.removeItem(SESSION_KEY);
  toggleAuth(false);
}

async function fetchPosts(reset = false) {
  if (state.loadingPosts) return;
  if (!state.hasMorePosts && !reset) return;
  state.loadingPosts = true;
  try {
    if (reset) {
      state.feedOffset = 0;
      state.hasMorePosts = true;
      state.posts = [];
    }
    const data = await api(`/api/posts?offset=${state.feedOffset}&limit=${state.feedLimit}`);
    state.posts = reset ? data.posts : [...state.posts, ...data.posts];
    state.feedOffset = data.nextOffset;
    state.hasMorePosts = data.hasMore;
  } finally {
    state.loadingPosts = false;
    renderFeedControls();
  }
}

async function fetchAppMeta() {
  const uid = state.user.id;
  const [users, requests, friends, notifications] = await Promise.all([
    api(`/api/users/search?userId=${encodeURIComponent(uid)}&q=${encodeURIComponent(sanitize(el('search-user').value, 30))}`),
    api(`/api/friends/requests/${uid}`),
    api(`/api/friends/list/${uid}`),
    api(`/api/notifications/${uid}`)
  ]);
  state.users = users.users;
  state.requests = requests.requests;
  state.friends = friends.friends;
  state.notifications = notifications.notifications;
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
  await renderApp(false);
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
  clearBtn.onclick = async () => {
    state.selectedProfile = null;
    await fetchPosts(true);
    renderFeed();
    renderSelectedProfileCard();
  };
  actions.appendChild(clearBtn);
}

function renderFeedControls() {
  const btn = el('load-more-posts');
  btn.classList.toggle('hidden', !state.hasMorePosts || state.selectedProfile);
  btn.disabled = state.loadingPosts;
  btn.textContent = state.loadingPosts ? 'Loading...' : 'Load more';
}

function buildReplyBox(postId) {
  const wrap = document.createElement('div');
  wrap.className = 'reply-wrap hidden';
  const row = document.createElement('div');
  row.className = 'row';
  const input = document.createElement('input');
  input.placeholder = '↪ Reply...';
  input.maxLength = 200;
  const send = document.createElement('button');
  send.textContent = 'Reply';
  send.onclick = async (e) => {
    e.stopPropagation();
    const content = sanitize(input.value, 200);
    if (!content) return;
    await api(`/api/posts/${postId}/comment`, { method: 'POST', body: JSON.stringify({ userId: state.user.id, content, kind: 'reply' }) });
    await renderApp(false);
  };
  row.append(input, send);
  wrap.appendChild(row);
  return wrap;
}

function renderFeed() {
  el('feed-title').textContent = state.selectedProfile ? `Posts by @${state.selectedProfile.username}` : 'Community Feed';
  const wrap = el('post-list');
  wrap.innerHTML = '';

  state.posts.forEach((post) => {
    const postEl = document.createElement('article');
    postEl.className = 'post';

    const title = document.createElement('strong');
    title.textContent = `${post.author?.username || 'Unknown'} • ${new Date(post.createdAt).toLocaleString()}${post.editedAt ? ' • edited' : ''}`;
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
    likeBtn.onclick = async (e) => {
      e.stopPropagation();
      await api(`/api/posts/${post.id}/like`, { method: 'POST', body: JSON.stringify({ userId: state.user.id }) });
      await renderApp(false);
    };
    actions.appendChild(likeBtn);

    const replyBtn = document.createElement('button');
    replyBtn.textContent = '↪ Reply';
    actions.appendChild(replyBtn);

    if (post.authorId === state.user.id) {
      const editBtn = document.createElement('button');
      editBtn.textContent = 'Edit';
      editBtn.onclick = async (e) => {
        e.stopPropagation();
        const updated = prompt('Edit your post', post.content || '');
        if (updated === null) return;
        await api(`/api/posts/${post.id}`, { method: 'PUT', body: JSON.stringify({ userId: state.user.id, content: sanitize(updated, 500) }) });
        await renderApp(false);
      };

      const delBtn = document.createElement('button');
      delBtn.className = 'danger';
      delBtn.textContent = 'Delete';
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this post?')) return;
        await api(`/api/posts/${post.id}`, { method: 'DELETE', body: JSON.stringify({ userId: state.user.id }) });
        await renderApp(true);
      };
      actions.append(editBtn, delBtn);
    } else {
      const reportBtn = document.createElement('button');
      reportBtn.textContent = 'Report';
      reportBtn.onclick = async (e) => {
        e.stopPropagation();
        const reason = prompt('Report reason', 'Spam') || 'Spam';
        await api(`/api/posts/${post.id}/report`, { method: 'POST', body: JSON.stringify({ userId: state.user.id, reason }) });
        alert('Reported');
      };
      actions.appendChild(reportBtn);
    }

    postEl.appendChild(actions);

    const replyWrap = buildReplyBox(post.id);
    replyBtn.onclick = (e) => { e.stopPropagation(); replyWrap.classList.toggle('hidden'); };

    postEl.addEventListener('click', (event) => {
      if (event.target.closest('button') || event.target.closest('input') || event.target.closest('textarea')) return;
      replyWrap.classList.toggle('hidden');
    });

    post.comments.forEach((c) => {
      const ce = document.createElement('div');
      ce.className = 'comment';
      ce.textContent = `${c.kind === 'reply' ? '↪ ' : ''}${c.user?.username || 'Unknown'}: ${c.content}`;
      postEl.appendChild(ce);
    });

    postEl.appendChild(replyWrap);
    wrap.appendChild(postEl);
  });

  renderFeedControls();
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
    a.onclick = async () => { await api('/api/friends/respond', { method: 'POST', body: JSON.stringify({ requestId: r.id, action: 'accept', userId: state.user.id }) }); await renderApp(false); };
    b.onclick = async () => { await api('/api/friends/respond', { method: 'POST', body: JSON.stringify({ requestId: r.id, action: 'reject', userId: state.user.id }) }); await renderApp(false); };
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
  const form = el('message-form');
  const empty = el('dm-empty-state');
  const imageName = el('message-image-name');

  thread.innerHTML = '';
  if (!state.activeChatFriendId) {
    empty.classList.remove('hidden');
    thread.classList.add('hidden');
    form.classList.add('hidden');
    imageName.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  thread.classList.remove('hidden');
  form.classList.remove('hidden');

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

async function renderApp(resetFeed = false) {
  if (!state.user) return toggleAuth(false);
  toggleAuth(true);
  await fetchAppMeta();
  if (!state.selectedProfile) await fetchPosts(resetFeed);
  renderHeader();
  renderTopics();
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
el('open-messages-btn').addEventListener('click', async () => {
  if (state.view === 'messages') {
    switchView('feed');
    return;
  }
  switchView('messages');
  await renderMessages();
});

el('toggle-active-btn').addEventListener('click', async () => {
  const data = await api(`/api/users/${state.user.id}/active`, { method: 'PUT', body: JSON.stringify({ active: !state.user.active }) });
  state.user = data.user;
  localStorage.setItem(SESSION_KEY, JSON.stringify(state.user));
  await renderApp(false);
});

document.querySelectorAll('.nav-btn').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));
el('mobile-menu-toggle').addEventListener('click', () => {
  const mobileNav = el('mobile-nav');
  const willShow = mobileNav.classList.contains('hidden');
  mobileNav.classList.toggle('hidden', !willShow);
  el('mobile-menu-toggle').setAttribute('aria-expanded', willShow ? 'true' : 'false');
});

el('search-user').addEventListener('input', () => renderApp(false));
el('top-search-user').addEventListener('input', onTopSearchInput);
el('message-emoji').addEventListener('click', () => {
  const input = el('message-input');
  input.value = `${input.value}😀`;
  input.focus();
});
el('post-image').addEventListener('change', () => {
  const file = el('post-image').files[0];
  el('post-image-name').textContent = file ? file.name : 'No file selected';
});
el('message-image').addEventListener('change', () => {
  const file = el('message-image').files[0];
  const label = el('message-image-name');
  label.textContent = file ? file.name : 'No file selected';
  label.classList.toggle('hidden', !file);
});
el('profile-image-file').addEventListener('change', () => {
  const file = el('profile-image-file').files[0];
  el('profile-image-name').textContent = file ? file.name : 'No file selected';
});

el('load-more-posts').addEventListener('click', async () => {
  await fetchPosts(false);
  renderFeed();
});
window.addEventListener('scroll', async () => {
  if (state.view !== 'feed' || state.selectedProfile || !state.hasMorePosts || state.loadingPosts) return;
  if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 260) {
    await fetchPosts(false);
    renderFeed();
  }
});

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
    el('post-image-name').textContent = 'No file selected';
    state.selectedProfile = null;
    await renderApp(true);
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
    el('message-image-name').textContent = 'No file selected';
    el('message-image-name').classList.add('hidden');
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
    el('profile-image-name').textContent = 'No file selected';
    await renderApp(false);
  } catch (err) {
    el('settings-message').textContent = err.message;
  }
});

connectEmojiButtons();
renderApp(true);
