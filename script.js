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
  loadingPosts: false,
  forumTopics: [],
  forumPosts: [],
  activeForumTopicId: '',
  editingPostId: '',
  profileActivity: { user: null, posts: [], forumPosts: [], forumComments: [] },
  readNotifications: [],
  conversations: [],
  typingByUser: {},
  presence: {},
  pendingOutgoing: new Set(),
  openThreads: new Set(),
  forumTab: 'posts'
};

const TOPICS = ['Blue Team', 'SOC', 'Threat Intel', 'Cloud Security', 'OWASP', 'Malware Analysis'];
let socket = null;
let activityThrottleUntil = 0;
let typingTimeout = null;

const el = (id) => document.getElementById(id);
const decode = (txt) => { try { return atob(txt || ''); } catch { return ''; } };
const sanitize = (txt, max = 500) => String(txt || '').replace(/[<>]/g, '').trim().slice(0, max);

function formatRelativeTime(iso) {
  const diff = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diff < 60) return `${diff} san əvvəl`;
  if (diff < 3600) return `${Math.floor(diff / 60)} dəq əvvəl`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} saat əvvəl`;
  return `${Math.floor(diff / 86400)} gün əvvəl`;
}

function extractTags(text = '') {
  const tags = String(text).match(/#[\w-]+/g) || [];
  return tags.slice(0, 4);
}

function calcWeekStats() {
  const myPosts = state.posts.filter((p) => p.authorId === state.user.id);
  const posts = myPosts.length;
  const replies = state.posts.reduce((acc, p) => acc + (p.comments || []).filter((c) => c.userId === state.user.id).length, 0);
  const likes = myPosts.reduce((acc, p) => acc + (p.likes || []).length, 0);
  return { posts, replies, likes };
}

function dmConversationId(a, b) {
  return [a, b].sort().join(':');
}

function getPresence(userId) {
  const p = state.presence[userId] || { status: 'offline', lastActiveAt: '' };
  return p;
}

function formatPresenceText(userId) {
  const p = getPresence(userId);
  if (p.status === 'online') return 'online';
  if (p.status === 'idle') return 'idle';
  if (!p.lastActiveAt) return 'offline';
  return `last seen ${formatRelativeTime(p.lastActiveAt)}`;
}

function setupSocket() {
  if (!window.io || !state.user?.token) return;
  if (socket) socket.disconnect();
  socket = window.io({ auth: { token: state.user.token } });

  socket.on('presence:update', ({ userId, status, lastActiveAt }) => {
    state.presence[userId] = { status, lastActiveAt };
    if (state.view === 'messages') {
      renderDmFriendList();
      updateActiveChatHeader();
    }
  });

  socket.on('dm:newMessage', (msg) => {
    const target = state.activeChatFriendId;
    if (!target) return;
    const isForOpenChat = (msg.from === target && msg.to === state.user.id) || (msg.from === state.user.id && msg.to === target);
    if (isForOpenChat) renderMessages();
    renderDmFriendList();
  });

  socket.on('dm:typing', ({ from, isTyping }) => {
    state.typingByUser[from] = isTyping;
    if (from === state.activeChatFriendId) {
      el('typing-indicator').classList.toggle('hidden', !isTyping);
    }
  });
}

function emitPresenceActivity(type = 'activity') {
  if (!socket || !socket.connected) return;
  const nowTs = Date.now();
  if (type === 'activity' && nowTs < activityThrottleUntil) return;
  if (type === 'activity') activityThrottleUntil = nowTs + 1200;
  socket.emit('presence:activity', { type });
}

function bindPresenceActivity() {
  ['mousemove', 'keydown', 'scroll', 'click'].forEach((evt) => {
    window.addEventListener(evt, () => emitPresenceActivity('activity'), { passive: true });
  });
  document.addEventListener('visibilitychange', () => {
    emitPresenceActivity(document.hidden ? 'hidden' : 'activity');
  });
}


async function api(path, options = {}) {
  const token = state.user?.token || '';
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      logout();
      throw new Error('Session expired. Please login again.');
    }
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function setAuthMsg(msg, isErr = false) {
  const m = el('auth-message');
  m.style.color = isErr ? '#ff9db0' : '#9fffb0';
  m.textContent = msg;
}

function setNetworkMessage(msg, isErr = false) {
  const m = el('network-message');
  if (!m) return;
  m.style.color = isErr ? '#ff9db0' : '#9fffb0';
  m.textContent = msg;
}


function positionFloatingDropdown(anchorEl, panelEl, width = 320) {
  if (!anchorEl || !panelEl) return;
  const rect = anchorEl.getBoundingClientRect();
  const panelWidth = Math.min(width, window.innerWidth * 0.92);
  let left = rect.right - panelWidth;
  left = Math.max(12, Math.min(left, window.innerWidth - panelWidth - 12));
  panelEl.style.position = 'fixed';
  panelEl.style.top = `${Math.min(window.innerHeight - 20, rect.bottom + 8)}px`;
  panelEl.style.left = `${left}px`;
  panelEl.style.width = `${panelWidth}px`;
}

function showToast(msg, isErr = false) {
  const t = el('ui-toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  t.classList.toggle('error', isErr);
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add('hidden'), 1800);
}

function toggleAuth(showApp) {
  el('auth-panel').classList.toggle('hidden', showApp);
  el('app-panel').classList.toggle('hidden', !showApp);
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  el(`${view}-view`).classList.remove('hidden');
  document.querySelectorAll('.nav-btn, .top-icon-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
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
    state.user = { ...data.user, token: data.user.token };
    localStorage.setItem(SESSION_KEY, JSON.stringify(state.user));
    e.target.reset();
    await renderApp(true);
  } catch (err) {
    setAuthMsg(err.message, true);
  }
}

async function logout() {
  try {
    const token = state.user?.token;
    if (token) {
      await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    }
  } catch {}
  if (socket) {
    socket.emit('presence:logout');
    socket.disconnect();
    socket = null;
  }
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
  const [users, requests, friends, notifications, forumTopics] = await Promise.all([
    api(`/api/users/search?q=${encodeURIComponent(sanitize(el('search-user').value, 30))}`),
    api(`/api/friends/requests/${uid}`),
    api(`/api/friends/list/${uid}`),
    api(`/api/notifications/${uid}`),
    api('/api/forum/topics')
  ]);
  state.users = users.users;
  state.requests = requests.requests;
  state.friends = friends.friends;
  state.notifications = notifications.notifications;
  state.forumTopics = forumTopics.topics;
  if (!state.activeForumTopicId && state.forumTopics[0]) state.activeForumTopicId = state.forumTopics[0].id;
}

function renderHeader() {
  el('profile-name').textContent = state.user.username;
  el('profile-preview').src = state.user.profileImage || DEFAULT_AVATAR;
  el('active-status').textContent = `Status: ${state.user.active ? 'Active 🟢' : 'Away ⚪'}`;
  el('status-text').textContent = `Status message: ${decode(state.user.statusEncrypted) || 'Blue team mode'}`;
  el('status-input').value = decode(state.user.statusEncrypted) || '';

  const badgeWrap = el('badge-list');
  const badges = ['Blue Team Starter', 'OWASP Learner', 'SOC Newbie'];
  badgeWrap.innerHTML = badges.map((b) => `<span class="stat-chip">${b}</span>`).join('');

  const week = calcWeekStats();
  el('stat-posts-week').textContent = week.posts;
  el('stat-replies-week').textContent = week.replies;
  el('stat-likes-week').textContent = week.likes;

  renderNotificationDropdown();
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
  state.pendingOutgoing.add(targetId);
  renderNetwork();
  try {
    await api('/api/friends/request', { method: 'POST', body: JSON.stringify({ to: targetId }) });
    setNetworkMessage('Friend request sent ✅');
    showToast('Friend request sent');
    await renderApp(true);
  } catch (err) {
    if ((err.message || '').toLowerCase().includes('pending')) state.pendingOutgoing.add(targetId);
    else state.pendingOutgoing.delete(targetId);
    setNetworkMessage(err.message, true);
    showToast(err.message, true);
    renderNetwork();
  }
}

async function openUserProfile(user) {
  if (!user) return;
  state.selectedProfile = user;
  const { posts } = await api(`/api/users/${user.id}/posts`);
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
  card.innerHTML = `<div class="row"><div class="profile-mini"><img src="${user.profileImage || DEFAULT_AVATAR}" alt="${user.username}" class="mini-avatar" /><span>@${user.username} profile view • ${user.active ? 'active' : 'away'}</span></div><div class="actions"></div></div>`;
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


function setEditingState(post = null) {
  const indicator = el('editing-indicator');
  const cancelBtn = el('cancel-edit-btn');
  const submitBtn = el('post-submit-btn');
  if (!post) {
    state.editingPostId = '';
    indicator.classList.add('hidden');
    cancelBtn.classList.add('hidden');
    submitBtn.textContent = 'Post';
    return;
  }
  state.editingPostId = post.id;
  indicator.classList.remove('hidden');
  cancelBtn.classList.remove('hidden');
  submitBtn.textContent = 'Save edit';
  el('post-content').value = post.content || '';
  el('post-content').focus();
}

function buildReplyBox(postId) {
  const wrap = document.createElement('div');
  wrap.className = 'reply-wrap';
  const row = document.createElement('div');
  row.className = 'row';
  const input = document.createElement('input');
  input.placeholder = 'Reply yaz...';
  input.maxLength = 200;
  input.className = 'reply-input';
  const send = document.createElement('button');
  send.className = 'reply-send-btn';
  send.textContent = '➤';
  send.title = 'Send reply';
  send.onclick = async (e) => {
    e.stopPropagation();
    const content = sanitize(input.value, 200);
    if (!content) return;
    await api(`/api/posts/${postId}/comment`, { method: 'POST', body: JSON.stringify({ userId: state.user.id, content, kind: 'reply' }) });
    await renderApp(true);
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

    const head = document.createElement('div');
    head.className = 'post-head';
    head.innerHTML = `
      <img class="mini-avatar" src="${post.author?.profileImage || DEFAULT_AVATAR}" alt="${post.author?.username || 'User'}" />
      <div class="post-meta"><strong>${post.author?.username || 'Unknown'}</strong><span class="small">${formatRelativeTime(post.createdAt)}${post.editedAt ? ' • edited' : ''}</span></div>
    `;

    const tags = extractTags(post.content || '');
    const tagRow = document.createElement('div');
    tagRow.className = 'chip-wrap';
    tags.forEach((tag) => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = tag;
      tagRow.appendChild(chip);
    });

    const p = document.createElement('p');
    p.textContent = post.content;
    postEl.append(head);
    if (tags.length) postEl.appendChild(tagRow);
    postEl.appendChild(p);

    if (post.imageData) {
      const postImg = document.createElement('img');
      postImg.src = post.imageData;
      postImg.className = 'post-image';
      postEl.appendChild(postImg);
    }

    const actions = document.createElement('div');
    actions.className = 'actions action-bar';

    const likeBtn = document.createElement('button');
    const liked = post.likes.includes(state.user.id);
    likeBtn.className = `icon-action ${liked ? 'active-like' : ''}`;
    likeBtn.textContent = `${liked ? '♥' : '♡'} ${post.likes.length}`;
    likeBtn.onclick = async (e) => {
      e.stopPropagation();
      const wasLiked = post.likes.includes(state.user.id);
      post.likes = wasLiked ? post.likes.filter((id) => id !== state.user.id) : [...post.likes, state.user.id];
      renderFeed();
      try {
        await api(`/api/posts/${post.id}/like`, { method: 'POST', body: JSON.stringify({ userId: state.user.id }) });
      } catch {
        post.likes = wasLiked ? [...post.likes, state.user.id] : post.likes.filter((id) => id !== state.user.id);
        renderFeed();
      }
    };
    actions.appendChild(likeBtn);

    const replyBtn = document.createElement('button');
    replyBtn.className = 'icon-action';
    replyBtn.textContent = '💬 Reply';
    actions.appendChild(replyBtn);

    const shareBtn = document.createElement('button');
    shareBtn.className = 'icon-action';
    shareBtn.textContent = '↗ Share';
    shareBtn.onclick = () => {
      shareBtn.textContent = '✓ Shared';
      setTimeout(() => { shareBtn.textContent = '↗ Share'; }, 900);
    };
    actions.appendChild(shareBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'icon-action';
    saveBtn.textContent = '🔖 Save';
    saveBtn.onclick = () => saveBtn.classList.toggle('active-like');
    actions.appendChild(saveBtn);

    if (post.authorId === state.user.id) {
      const editBtn = document.createElement('button');
      editBtn.className = 'icon-action';
      editBtn.textContent = '✏️ Edit';
      editBtn.onclick = (e) => {
        e.stopPropagation();
        setEditingState(post);
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
    }

    postEl.appendChild(actions);

    const replyWrap = buildReplyBox(post.id);
    replyBtn.onclick = (e) => {
      e.stopPropagation();
      replyWrap.classList.toggle('open');
    };

    const allComments = post.comments || [];
    const baseComments = allComments.filter((c) => c.kind !== 'reply');
    const threadReplies = allComments.filter((c) => c.kind === 'reply');

    baseComments.forEach((c) => {
      const ce = document.createElement('div');
      ce.className = 'comment';
      ce.innerHTML = `<strong>${c.user?.username || 'Unknown'}</strong> <span class="small">• ${formatRelativeTime(c.createdAt)}</span><p>${c.content}</p>`;
      postEl.appendChild(ce);
    });

    if (threadReplies.length) {
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'thread-toggle';
      const isOpen = state.openThreads.has(post.id);
      toggleBtn.textContent = isOpen ? 'Hide thread' : `View thread (${threadReplies.length})`;
      toggleBtn.onclick = () => {
        if (state.openThreads.has(post.id)) state.openThreads.delete(post.id);
        else state.openThreads.add(post.id);
        renderFeed();
      };
      postEl.appendChild(toggleBtn);

      if (isOpen) {
        const threadWrap = document.createElement('div');
        threadWrap.className = 'thread-wrap';
        threadReplies.forEach((c, i) => {
          const ce = document.createElement('div');
          ce.className = 'comment nested-comment';
          ce.style.marginLeft = `${12 + (i % 3) * 14}px`;
          ce.innerHTML = `<strong>${c.user?.username || 'Unknown'}</strong> <span class="small">• ${formatRelativeTime(c.createdAt)}</span><p>${c.content}</p>`;
          threadWrap.appendChild(ce);
        });
        postEl.appendChild(threadWrap);
      }
    }

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
    item.innerHTML = `<span class="clickable-user">${u.username} (${u.active ? 'active' : 'away'}) • Posts: ${u.postCount}</span><div class="actions"></div>`;
    const actions = item.querySelector('.actions');
    item.querySelector('.clickable-user').onclick = () => openUserProfile(u);

    const viewBtn = document.createElement('button');
    viewBtn.textContent = 'View Posts';
    viewBtn.onclick = () => openUserProfile(u);
    actions.appendChild(viewBtn);

    const btn = document.createElement('button');
    const isPending = state.pendingOutgoing.has(u.id);
    btn.textContent = isFriend ? 'Friends' : (isPending ? 'Pending' : 'Add Friend');
    btn.disabled = isFriend || isPending;
    btn.onclick = () => sendFriendRequest(u.id);
    actions.appendChild(btn);
    if (!isFriend && isPending) {
      const badge = document.createElement('span');
      badge.className = 'pending-badge';
      badge.textContent = 'Request already pending';
      actions.appendChild(badge);
    }

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
    a.onclick = async () => {
      try {
        await api('/api/friends/respond', { method: 'POST', body: JSON.stringify({ requestId: r.id, action: 'accept', userId: state.user.id }) });
        setNetworkMessage('Friend request accepted ✅');
        await renderApp(true);
      } catch (err) {
        setNetworkMessage(err.message, true);
      }
    };
    b.onclick = async () => {
      try {
        await api('/api/friends/respond', { method: 'POST', body: JSON.stringify({ requestId: r.id, action: 'reject', userId: state.user.id }) });
        setNetworkMessage('Friend request rejected');
        await renderApp(true);
      } catch (err) {
        setNetworkMessage(err.message, true);
      }
    };
    item.append(txt, a, b);
    reqWrap.appendChild(item);
  });
}

function renderDmFriendList() {
  const wrap = el('dm-friend-list');
  wrap.innerHTML = '';
  if (!state.conversations.length) {
    wrap.innerHTML = '<div class="dm-empty">Hələ mesaj yoxdur — bir dostuna yaz 💬</div>';
    if (socket?.connected) socket.emit('presence:watch', { userIds: [] });
    return;
  }

  const watchIds = [];
  state.conversations.forEach((c) => {
    const p = getPresence(c.user.id);
    watchIds.push(c.user.id);
    const btn = document.createElement('button');
    btn.className = `dm-friend-item ${state.activeChatFriendId === c.user.id ? 'active' : ''}`;
    btn.type = 'button';
    btn.innerHTML = `
      <div class="dm-conv-head">
        <span class="dm-presence-dot ${p.status}"></span>
        <strong>@${c.user.username}</strong>
        <span class="small">${c.lastMessageAt ? formatRelativeTime(c.lastMessageAt) : ''}</span>
      </div>
      <p class="small dm-preview">${c.lastPreview || 'Yeni söhbət başlat'}</p>
      ${c.unreadCount ? `<span class="dm-unread">${c.unreadCount}</span>` : ''}
    `;
    btn.onclick = async () => {
      state.activeChatFriendId = c.user.id;
      if (socket?.connected) socket.emit('dm:join', { conversationId: dmConversationId(state.user.id, c.user.id), targetId: c.user.id });
      await renderMessages();
    };
    wrap.appendChild(btn);
  });
  if (socket?.connected) socket.emit('presence:watch', { userIds: watchIds });
}

function updateActiveChatHeader() {
  const header = el('dm-chat-header');
  if (!state.activeChatFriendId) {
    header.classList.add('hidden');
    return;
  }
  const conv = state.conversations.find((c) => c.user.id === state.activeChatFriendId);
  if (!conv) return;
  el('dm-chat-avatar').src = conv.user.profileImage || DEFAULT_AVATAR;
  el('dm-chat-name').textContent = `@${conv.user.username}`;
  el('dm-chat-status').textContent = formatPresenceText(conv.user.id);
  header.classList.remove('hidden');
}

function renderOnlineSidebar() {
  const wrap = el('online-friends-list');
  if (!wrap) return;
  const onlineFriends = state.friends.filter((f) => {
    const ps = getPresence(f.id);
    return ps.status === 'online' || ps.status === 'idle';
  });
  wrap.innerHTML = '';
  if (!onlineFriends.length) {
    wrap.innerHTML = '<div class="item small">Heç kim online deyil</div>';
    return;
  }
  onlineFriends.forEach((f) => {
    const row = document.createElement('button');
    row.className = 'dm-friend-item';
    row.type = 'button';
    row.innerHTML = `<div class="dm-conv-head"><span class="dm-presence-dot online"></span><strong>@${f.username}</strong></div>`;
    row.onclick = async () => {
      state.activeChatFriendId = f.id;
      switchView('messages');
      await renderMessages();
    };
    wrap.appendChild(row);
  });
}

async function renderMessages() {
  const thread = el('message-thread');
  const form = el('message-form');
  const empty = el('dm-empty-state');
  const imageName = el('message-image-name');
  const scrollBtn = el('dm-scroll-bottom');
  thread.innerHTML = '';

  const convData = await api('/api/messages/conversations');
  state.conversations = convData.conversations;
  renderDmFriendList();

  if (!state.activeChatFriendId) {
    empty.textContent = 'Conversation seç — real-time chat burada açılacaq.';
    empty.classList.remove('hidden');
    thread.classList.add('hidden');
    form.classList.add('hidden');
    imageName.classList.add('hidden');
    updateActiveChatHeader();
    return;
  }

  empty.classList.add('hidden');
  thread.classList.remove('hidden');
  form.classList.remove('hidden');
  updateActiveChatHeader();

  const data = await api(`/api/messages/thread?targetId=${state.activeChatFriendId}`);
  state.messages = data.messages;

  state.messages.forEach((m) => {
    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${m.from === state.user.id ? 'mine' : ''}`;
    const meta = m.from === state.user.id ? (m.readBy?.includes(state.activeChatFriendId) ? 'read ✓✓' : 'sent ✓') : formatRelativeTime(m.createdAt);
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
    const time = document.createElement('span');
    time.className = 'small';
    time.textContent = `${formatRelativeTime(m.createdAt)} • ${meta}`;
    bubble.appendChild(time);
    thread.appendChild(bubble);
  });

  const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
  if (nearBottom || !thread.dataset.hasManualScroll) thread.scrollTop = thread.scrollHeight;
  el('typing-indicator').classList.toggle('hidden', !state.typingByUser[state.activeChatFriendId]);

  thread.onscroll = () => {
    const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
    thread.dataset.hasManualScroll = atBottom ? '' : '1';
    scrollBtn.classList.toggle('hidden', atBottom);
  };
}


function renderNotificationDropdown() {
  const badge = el('notification-badge');
  const list = el('notification-dropdown-list');
  const unread = state.notifications.filter((n) => !state.readNotifications.includes(n.id));
  badge.textContent = unread.length > 9 ? '9+' : String(unread.length);
  badge.classList.toggle('hidden', unread.length === 0);

  list.innerHTML = '';
  state.notifications.slice(0, 6).forEach((n) => {
    const item = document.createElement('div');
    item.className = `notif-item ${state.readNotifications.includes(n.id) ? '' : 'unread'}`;
    item.innerHTML = `<p>${n.text}</p><span class="small">${formatRelativeTime(n.createdAt)}</span>`;
    list.appendChild(item);
  });
  if (!state.notifications.length) {
    list.innerHTML = '<div class="item small">No notifications yet.</div>';
  }
}

function renderNotifications() {
  const wrap = el('notification-list');
  wrap.innerHTML = '';
  state.notifications.forEach((n) => {
    const item = document.createElement('div');
    item.className = `item ${state.readNotifications.includes(n.id) ? '' : 'notif-row-unread'}`;
    item.textContent = `${new Date(n.createdAt).toLocaleString()} — ${n.text}`;
    wrap.appendChild(item);
  });
  renderNotificationDropdown();
}


function renderForumTopics() {
  const wrap = el('forum-topic-list');
  wrap.innerHTML = '';
  state.forumTopics.forEach((t) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `forum-topic-btn ${state.activeForumTopicId === t.id ? 'active selected-topic-card' : ''}`;
    btn.innerHTML = `<strong>${t.name}</strong><span class="small">${t.description}</span>`;
    btn.onclick = async () => {
      state.activeForumTopicId = t.id;
      await renderForumPosts();
      renderForumTopics();
    };
    wrap.appendChild(btn);
  });
}

function applyForumTab() {
  el('forum-posts-tab').classList.toggle('hidden', state.forumTab !== 'posts');
  el('forum-manage-tab').classList.toggle('hidden', state.forumTab !== 'manage');
  document.querySelectorAll('.forum-tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.forumTab === state.forumTab));
}

async function renderForumPosts() {
  const form = el('forum-post-form');
  const header = el('forum-topic-header');
  const list = el('forum-post-list');
  applyForumTab();
  list.innerHTML = '';

  if (!state.activeForumTopicId) {
    header.textContent = 'Select a topic to join discussion.';
    form.classList.add('hidden');
    return;
  }

  const topic = state.forumTopics.find((t) => t.id === state.activeForumTopicId);
  header.innerHTML = `<strong>${topic?.name || 'Forum Topic'}</strong><p class="small">${topic?.description || ''}</p>`;
  form.classList.remove('hidden');

  const data = await api(`/api/forum/topics/${state.activeForumTopicId}/posts`);
  state.forumPosts = data.posts;
  state.forumPosts.forEach((post) => {
    const item = document.createElement('article');
    item.className = 'forum-post';
    const vis = post.visibility === 'friends' ? 'Friends only' : 'Public';
    item.innerHTML = `<strong>${post.author?.username || 'User'}</strong><p class="small">${new Date(post.createdAt).toLocaleString()} • ${vis}</p><p>${post.content}</p>`;

    const commentsWrap = document.createElement('div');
    commentsWrap.className = 'forum-comments';
    (post.comments || []).forEach((c) => {
      const cEl = document.createElement('div');
      cEl.className = 'forum-comment';
      cEl.textContent = `${c.user?.username || 'User'}: ${c.content}`;
      commentsWrap.appendChild(cEl);
    });

    const form = document.createElement('form');
    form.className = 'forum-comment-form';
    const input = document.createElement('input');
    input.placeholder = 'Write comment...';
    input.maxLength = 300;
    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.textContent = 'Comment';
    form.append(input, btn);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const content = sanitize(input.value, 300);
      if (!content) return;
      await api(`/api/forum/posts/${post.id}/comments`, { method: 'POST', body: JSON.stringify({ userId: state.user.id, content }) });
      await renderForumPosts();
    };

    item.append(commentsWrap, form);
    list.appendChild(item);
  });
}


async function renderProfileView() {
  const data = await api(`/api/users/${state.user.id}/activity`);
  state.profileActivity = data;

  el('profile-activity-summary').innerHTML = `<strong>${data.user.username}</strong><p class="small">Posts: ${data.posts.length} • Forum posts: ${data.forumPosts.length} • Forum comments: ${data.forumComments.length}</p>`;

  const postsWrap = el('my-posts-list');
  postsWrap.innerHTML = '';
  data.posts.forEach((p) => {
    const item = document.createElement('article');
    item.className = 'item';
    item.innerHTML = `<p>${p.content || '(image post)'}</p><p class="small">${new Date(p.createdAt).toLocaleString()}</p>`;
    postsWrap.appendChild(item);
  });

  const forumPostsWrap = el('my-forum-posts-list');
  forumPostsWrap.innerHTML = '';
  data.forumPosts.forEach((p) => {
    const item = document.createElement('article');
    item.className = 'item';
    item.innerHTML = `<p>${p.content}</p><p class="small">${p.topic?.name || 'Topic'} • ${new Date(p.createdAt).toLocaleString()}</p>`;
    forumPostsWrap.appendChild(item);
  });

  const commentsWrap = el('my-forum-comments-list');
  commentsWrap.innerHTML = '';
  data.forumComments.forEach((c) => {
    const item = document.createElement('article');
    item.className = 'item';
    item.innerHTML = `<p>${c.content}</p><p class="small">${c.topic?.name || 'Topic'} • ${new Date(c.createdAt).toLocaleString()}</p>`;
    commentsWrap.appendChild(item);
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
  positionFloatingDropdown(el('top-search-user'), wrap, 420);
}

async function onTopSearchInput() {
  const q = sanitize(el('top-search-user').value, 30);
  if (!q) {
    state.topSearchResults = [];
    return renderTopSearchResults();
  }
  const data = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
  state.topSearchResults = data.users.slice(0, 8);
  renderTopSearchResults();
  positionFloatingDropdown(el('top-search-user'), el('top-search-results'), 420);
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
  renderOnlineSidebar();
  renderNotifications();
  renderForumTopics();
  await renderForumPosts();
  await renderProfileView();
  await renderMessages();
  if (!socket && state.user?.token) setupSocket();
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

document.querySelectorAll('.forum-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.forumTab = btn.dataset.forumTab;
    applyForumTab();
  });
});

el('register-form').addEventListener('submit', registerUser);
el('login-form').addEventListener('submit', loginUser);
el('logout-btn').addEventListener('click', logout);
el('open-messages-btn').addEventListener('click', async () => {
  switchView('messages');
  await renderMessages();
});

el('toggle-active-btn').addEventListener('click', async () => {
  const data = await api(`/api/users/${state.user.id}/active`, { method: 'PUT', body: JSON.stringify({ active: !state.user.active }) });
  state.user = { ...data.user, token: state.user?.token };
  localStorage.setItem(SESSION_KEY, JSON.stringify(state.user));
  await renderApp(true);
});

document.querySelectorAll('.nav-btn').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));
document.querySelectorAll('.top-icon-btn[data-view]').forEach((btn) => btn.addEventListener('click', async () => {
  switchView(btn.dataset.view);
  if (btn.dataset.view === 'messages') await renderMessages();
}));
el('mobile-menu-toggle').addEventListener('click', () => {
  const mobileNav = el('mobile-nav');
  const willShow = mobileNav.classList.contains('hidden');
  mobileNav.classList.toggle('hidden', !willShow);
  el('mobile-menu-toggle').setAttribute('aria-expanded', willShow ? 'true' : 'false');
});

el('search-user').addEventListener('input', async () => {
  try {
    const data = await api(`/api/users/search?q=${encodeURIComponent(sanitize(el('search-user').value, 30))}`);
    state.users = data.users;
    renderNetwork();
  } catch {}
});
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
el('cancel-edit-btn').addEventListener('click', () => {
  el('post-form').reset();
  el('post-image-name').textContent = 'No file selected';
  setEditingState(null);
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

el('edit-status-btn').addEventListener('click', () => {
  switchView('settings');
  el('status-input').focus();
});

el('notification-bell').addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = el('notification-dropdown');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) positionFloatingDropdown(el('notification-bell'), panel, 420);
});

el('mark-all-read').addEventListener('click', () => {
  state.readNotifications = state.notifications.map((n) => n.id);
  renderNotificationDropdown();
  renderNotifications();
});

el('view-all-notifications').addEventListener('click', () => {
  switchView('notifications');
  el('notification-dropdown').classList.add('hidden');
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

window.addEventListener('resize', () => {
  if (!el('notification-dropdown').classList.contains('hidden')) positionFloatingDropdown(el('notification-bell'), el('notification-dropdown'), 420);
  if (!el('top-search-results').classList.contains('hidden')) positionFloatingDropdown(el('top-search-user'), el('top-search-results'), 420);
});

document.addEventListener('click', (event) => {
  if (!el('top-search-results').contains(event.target) && event.target !== el('top-search-user')) {
    state.topSearchResults = [];
    renderTopSearchResults();
  }
  if (!event.target.closest('.notif-wrap')) {
    el('notification-dropdown').classList.add('hidden');
  }
});

el('post-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const content = sanitize(el('post-content').value, 500);
    if (state.editingPostId) {
      if (!content) return;
      await api(`/api/posts/${state.editingPostId}`, { method: 'PUT', body: JSON.stringify({ userId: state.user.id, content }) });
      e.target.reset();
      setEditingState(null);
      await renderApp(true);
      return;
    }

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

el('message-send').addEventListener('click', () => {
  el('message-form').requestSubmit();
});

el('dm-scroll-bottom').addEventListener('click', () => {
  const thread = el('message-thread');
  thread.scrollTop = thread.scrollHeight;
});

el('message-input').addEventListener('input', () => {
  const ta = el('message-input');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 128)}px`;
  const chat = ta.closest('.dm-chat');
  if (chat) chat.style.paddingBottom = `${Math.max(12, ta.offsetHeight - 24)}px`;
});

el('message-input').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    el('message-form').requestSubmit();
    return;
  }
  if (socket?.connected && state.activeChatFriendId) {
    socket.emit('dm:typing', { targetId: state.activeChatFriendId, isTyping: true });
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      socket.emit('dm:typing', { targetId: state.activeChatFriendId, isTyping: false });
    }, 1200);
  }
});

el('message-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const raw = el('message-input').value;
    const content = sanitize(raw, 300);
    const file = el('message-image').files[0];
    ensureSafeImageFile(file);
    const imageData = file ? await fileToDataUrl(file) : '';
    if (!state.activeChatFriendId || (!content && !imageData)) return;
    await api('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ to: state.activeChatFriendId, content, imageData })
    });
    if (socket?.connected) {
      socket.emit('dm:typing', { targetId: state.activeChatFriendId, isTyping: false });
      socket.emit('presence:activity', { type: 'activity' });
    }
    e.target.reset();
    el('message-image-name').textContent = 'No file selected';
    el('message-image-name').classList.add('hidden');
    await renderMessages();
  } catch (err) {
    alert(err.message);
  }
});


el('forum-topic-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const name = sanitize(el('forum-topic-name').value, 60);
    const description = sanitize(el('forum-topic-description').value, 300);
    if (name.length < 3) return;
    const data = await api('/api/forum/topics', {
      method: 'POST',
      body: JSON.stringify({ userId: state.user.id, name, description })
    });
    e.target.reset();
    state.activeForumTopicId = data.topic.id;
    await renderApp(true);
  } catch (err) {
    alert(err.message);
  }
});

el('forum-post-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (!state.activeForumTopicId) return;
    const content = sanitize(el('forum-post-input').value, 3000);
    if (!content) return;
    await api(`/api/forum/topics/${state.activeForumTopicId}/posts`, {
      method: 'POST',
      body: JSON.stringify({ userId: state.user.id, content, visibility: el('forum-visibility').value })
    });
    e.target.reset();
    await renderForumPosts();
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
    state.user = { ...data.user, token: state.user?.token };
    localStorage.setItem(SESSION_KEY, JSON.stringify(state.user));
    el('settings-message').textContent = 'Settings saved.';
    e.target.reset();
    el('profile-image-name').textContent = 'No file selected';
    await renderApp(true);
  } catch (err) {
    el('settings-message').textContent = err.message;
  }
});

connectEmojiButtons();
bindPresenceActivity();
renderApp(true);
