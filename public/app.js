const API =
  (window.__COYOTE_CONFIG__ && window.__COYOTE_CONFIG__.apiBase) || "/api/v1";
const API_USE_CORS = typeof API === "string" && API.startsWith("http");

function resolveApiUrl(url) {
  if (!url || url.startsWith("http")) return url;
  if (API_USE_CORS && url.startsWith("/api/")) {
    return new URL(API).origin + url;
  }
  return url;
}

let sessionDoctorId = null;
let chatPollInterval = null;

function stopChatPoll() {
  if (chatPollInterval !== null) {
    clearInterval(chatPollInterval);
    chatPollInterval = null;
  }
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (
    options.body &&
    typeof options.body === "string" &&
    !headers["Content-Type"]
  ) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(API + path, {
    credentials: API_USE_CORS ? "include" : "same-origin",
    ...options,
    headers,
  });
  return res;
}

function parseHashQuery() {
  const full = (location.hash || "#/").replace(/^#/, "");
  const qi = full.indexOf("?");
  const pathRaw = (qi >= 0 ? full.slice(0, qi) : full).replace(/^\/+/, "");
  const qs = qi >= 0 ? full.slice(qi + 1) : "";
  const params = new URLSearchParams(qs);
  let page = parseInt(params.get("p") || "1", 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  let pageSize = parseInt(params.get("ps") || "20", 10);
  if (![10, 20, 50].includes(pageSize)) pageSize = 20;
  return { path: pathRaw, page, pageSize };
}

function parseHash() {
  const { path, page, pageSize } = parseHashQuery();
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "conversations" && parts[1] && parts[2] === "chat") {
    return {
      view: "chat",
      conversationId: parseInt(parts[1], 10),
      page,
      pageSize,
    };
  }
  if (parts[0] === "conversations" && parts[1] && parts[2] === "files") {
    return {
      view: "files",
      conversationId: parseInt(parts[1], 10),
      page,
      pageSize,
    };
  }
  if (parts[0] === "login") {
    return { view: "login", page: 1, pageSize: 20 };
  }
  if (parts[0] === "change-password") {
    return { view: "change-password", page: 1, pageSize: 20 };
  }
  return { view: "list", page, pageSize };
}

/**
 * @param {"list"|"chat"|"files"} view
 * @param {{ conversationId?: number, page?: number, pageSize?: number }} opts
 */
function navTo(view, opts = {}) {
  const page = opts.page != null ? opts.page : 1;
  const pageSize = opts.pageSize != null ? opts.pageSize : 20;
  const qs = new URLSearchParams();
  qs.set("p", String(page));
  qs.set("ps", String(pageSize));
  const q = qs.toString();
  if (view === "list") {
    location.hash = `#/?${q}`;
  } else if (view === "chat" && opts.conversationId != null) {
    location.hash = `#/conversations/${opts.conversationId}/chat?${q}`;
  } else if (view === "files" && opts.conversationId != null) {
    location.hash = `#/conversations/${opts.conversationId}/files?${q}`;
  } else {
    location.hash = `#/?${q}`;
  }
}

function setTopbarAuthVisible(show) {
  const actions = document.getElementById("topbar-actions");
  if (!actions) return;
  actions.classList.toggle("hidden", !show);
}

async function trySession() {
  try {
    const res = await apiFetch("/auth/me");
    if (!res.ok) {
      sessionDoctorId = null;
      return false;
    }
    const me = await res.json();
    sessionDoctorId = me.doctor_id;
    return true;
  } catch {
    sessionDoctorId = null;
    return false;
  }
}

function renderLogin(container, errorMsg) {
  container.innerHTML = "";
  const wrapper = el(`<div class="login-wrapper"></div>`);
  const card = el(`
    <div class="card">
      <h1>Iniciar sesión</h1>
      <p class="meta">Acceso al listado de conversaciones del doctor.</p>
      <div id="login-error" class="error" style="display:none"></div>
      <form id="login-form">
        <label for="username">Usuario</label>
        <input id="username" name="username" type="text" autocomplete="username" required />
        <label for="password">Contraseña</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Entrar</button>
      </form>
    </div>
  `);
  wrapper.appendChild(card);
  container.appendChild(wrapper);
  if (errorMsg) {
    const e = card.querySelector("#login-error");
    e.style.display = "block";
    e.textContent = errorMsg;
  }
  card.querySelector("#login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const username = card.querySelector("#username").value;
    const password = card.querySelector("#password").value;
    const loginRes = await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    if (!loginRes.ok) {
      renderLogin(container, "Credenciales inválidas.");
      return;
    }
    const data = await loginRes.json();
    sessionDoctorId = data.doctor_id;
    navTo("list", { page: 1, pageSize: 20 });
    await render();
  });
}

function renderChangePassword(container, { errorMsg, successMsg } = {}) {
  container.innerHTML = "";
  const card = el(`
    <div class="card">
      <h1>Cambiar contraseña</h1>
      <p class="meta">Ingrese su nueva contraseña (mínimo 8 caracteres).</p>
      <div id="change-pw-error" class="error" style="display:none"></div>
      <div id="change-pw-success" class="success" style="display:none"></div>
      <form id="change-pw-form">
        <label for="new-password">Nueva contraseña</label>
        <input id="new-password" name="new_password" type="password" autocomplete="new-password" required minlength="8" />
        <label for="confirm-password">Repetir contraseña</label>
        <input id="confirm-password" name="confirm_password" type="password" autocomplete="new-password" required minlength="8" />
        <button type="submit">Confirmar cambio</button>
        <button type="button" class="secondary" id="cancel-change-pw">Cancelar</button>
      </form>
    </div>
  `);
  container.appendChild(card);
  if (errorMsg) {
    const e = card.querySelector("#change-pw-error");
    e.style.display = "block";
    e.textContent = errorMsg;
  }
  if (successMsg) {
    const s = card.querySelector("#change-pw-success");
    s.style.display = "block";
    s.textContent = successMsg;
    card.querySelector("#change-pw-form").style.display = "none";
  }
  card.querySelector("#cancel-change-pw").addEventListener("click", () => {
    navTo("list", { page: 1, pageSize: 20 });
    render();
  });
  card.querySelector("#change-pw-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const newPassword = card.querySelector("#new-password").value;
    const confirmPassword = card.querySelector("#confirm-password").value;
    if (newPassword !== confirmPassword) {
      renderChangePassword(container, {
        errorMsg: "Las contraseñas no coinciden.",
      });
      return;
    }
    if (newPassword.length < 8) {
      renderChangePassword(container, {
        errorMsg: "La contraseña debe tener al menos 8 caracteres.",
      });
      return;
    }
    const res = await apiFetch("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({
        new_password: newPassword,
        confirm_password: confirmPassword,
      }),
    });
    if (!res.ok) {
      let msg = "No se pudo cambiar la contraseña.";
      try {
        const err = await res.json();
        if (err.detail) {
          msg = Array.isArray(err.detail)
            ? err.detail.map((d) => d.msg || d).join(" ")
            : String(err.detail);
        }
      } catch {
        /* ignore */
      }
      renderChangePassword(container, { errorMsg: msg });
      return;
    }
    sessionDoctorId = null;
    renderChangePassword(container, {
      successMsg:
        "Su contraseña fue actualizada. Será redirigido al inicio de sesión…",
    });
    setTimeout(() => {
      location.hash = "#/login";
      render();
    }, 2500);
  });
}

function buildStickyToolbar({
  page,
  pageSize,
  total,
  onPageSizeChange,
  onPrev,
  onNext,
  navRowInner,
}) {
  const totalPages = total > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const bar = el(`
    <div class="sticky-toolbar">
      <div class="toolbar-inner">
        <div class="toolbar-nav">${navRowInner}</div>
        <div class="toolbar-pagination">
          <label class="page-size-label">Por página
            <select id="toolbar-page-size" aria-label="Mensajes por página">
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="50">50</option>
            </select>
          </label>
          <span class="meta page-indicator" id="page-indicator"></span>
          <button type="button" class="secondary sm" id="toolbar-prev">Anterior</button>
          <button type="button" class="secondary sm" id="toolbar-next">Siguiente</button>
        </div>
      </div>
    </div>
  `);
  const sel = bar.querySelector("#toolbar-page-size");
  sel.value = String(pageSize);
  sel.addEventListener("change", () => {
    const ps = parseInt(sel.value, 10);
    onPageSizeChange(ps);
  });
  const ind = bar.querySelector("#page-indicator");
  ind.textContent =
    total > 0
      ? `Página ${Math.min(page, totalPages)} de ${totalPages} · ${total} total`
      : `Sin resultados`;
  bar.querySelector("#toolbar-prev").disabled = page <= 1;
  bar.querySelector("#toolbar-next").disabled = page >= totalPages || total === 0;
  bar.querySelector("#toolbar-prev").addEventListener("click", onPrev);
  bar.querySelector("#toolbar-next").addEventListener("click", onNext);
  return bar;
}

async function renderList(container, route) {
  let { page, pageSize } = route;
  const offset = (page - 1) * pageSize;
  const res = await apiFetch(
    `/doctors/${sessionDoctorId}/conversations?limit=${pageSize}&offset=${offset}`
  );
  if (res.status === 401) {
    sessionDoctorId = null;
    location.hash = "#/login";
    await render();
    return;
  }
  if (!res.ok) {
    container.innerHTML = `<div class="card error">No se pudo cargar la lista.</div>`;
    return;
  }
  const body = await res.json();
  const items = body.items || [];
  const total = body.total ?? 0;
  const totalPages = total > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  if (total > 0 && page > totalPages) {
    navTo("list", { page: totalPages, pageSize });
    return;
  }

  container.innerHTML = "";
  const wrap = el(`<div class="card"><h1>Conversaciones</h1></div>`);

  const navInner = `<span class="toolbar-spacer"></span>`;
  const sticky = buildStickyToolbar({
    page,
    pageSize,
    total,
    onPageSizeChange: (ps) => navTo("list", { page: 1, pageSize: ps }),
    onPrev: () => navTo("list", { page: Math.max(1, page - 1), pageSize }),
    onNext: () =>
      navTo("list", {
        page: Math.min(totalPages, page + 1),
        pageSize,
      }),
    navRowInner: navInner,
  });
  wrap.appendChild(sticky);

  const list = document.createElement("div");
  if (!items.length) {
    list.innerHTML = `<p class="meta">No hay conversaciones.</p>`;
  }
  for (const c of items) {
    const row = el(`
      <div class="conversation-row">
        <div>
          <strong>${escapeHtml(c.phone_number)}</strong>
          <div class="meta">ID ${c.id} · Actualizado: ${formatDate(
      c.updated_at
    )}</div>
        </div>
        <div>
          <button type="button" class="sm" data-chat="${c.id}">Ver conversación</button>
          <button type="button" class="secondary sm" data-files="${
            c.id
          }">Archivos</button>
        </div>
      </div>
    `);
    row.querySelector(`[data-chat]`).addEventListener("click", () => {
      navTo("chat", { conversationId: c.id, page: 1, pageSize });
    });
    row.querySelector(`[data-files]`).addEventListener("click", () => {
      navTo("files", { conversationId: c.id, page: 1, pageSize });
    });
    list.appendChild(row);
  }
  wrap.appendChild(list);
  container.appendChild(wrap);
}

function buildMessageBubble(m) {
  const isUser = m.role === "user";
  const isSystem = m.role === "system";

  const time = (() => {
    try {
      return new Date(m.created_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  })();

  if (isSystem) {
    const div = document.createElement("div");
    div.className = "bubble-system";
    div.dataset.msgId = String(m.id);
    div.textContent = m.content;
    return div;
  }

  const attHtml =
    m.attachments && m.attachments.length
      ? m.attachments
          .map((a) => {
            const label = escapeHtml(a.original_filename || a.s3_key || "archivo");
            const href = a.download_url
              ? escapeAttr(resolveApiUrl(a.download_url))
              : "#";
            return a.download_url
              ? `<div class="att-row"><span class="meta">${label}</span> <a class="btn secondary sm" href="${href}" download>Descargar</a></div>`
              : `<div class="att-row"><span class="meta">${label}</span></div>`;
          })
          .join("")
      : "";

  const row = document.createElement("div");
  row.className = `bubble-row ${isUser ? "bubble-user" : "bubble-assistant"}`;
  row.dataset.msgId = String(m.id);

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML =
    `<div class="bubble-content">${escapeHtml(m.content)}</div>` +
    (attHtml ? `<div class="attachment-chips">${attHtml}</div>` : "") +
    `<div class="bubble-time">${escapeHtml(time)}</div>`;

  row.appendChild(bubble);
  return row;
}

async function renderChat(container, conversationId, route) {
  const { pageSize } = route;
  const CHAT_LIMIT = 50;

  stopChatPoll();
  container.classList.add("chat-mode");
  container.innerHTML = `<div class="chat-loading">Cargando conversación…</div>`;

  // 1. Conversation info (phone, bot_enabled)
  const convRes = await apiFetch(
    `/doctors/${sessionDoctorId}/conversations/${conversationId}`
  );
  if (convRes.status === 401) {
    sessionDoctorId = null;
    location.hash = "#/login";
    await render();
    return;
  }
  if (!convRes.ok) {
    container.classList.remove("chat-mode");
    container.innerHTML = `<div class="card error">Conversación no encontrada.</div>`;
    return;
  }
  const conv = await convRes.json();

  // 2. Initial messages (newest 50, reversed for display)
  const msgRes = await apiFetch(
    `/doctors/${sessionDoctorId}/conversations/${conversationId}/messages?limit=${CHAT_LIMIT}&offset=0`
  );
  if (!msgRes.ok) {
    container.classList.remove("chat-mode");
    container.innerHTML = `<div class="card error">Error al cargar mensajes.</div>`;
    return;
  }
  const msgPayload = await msgRes.json();
  const initialMessages = (msgPayload.items || []).slice().reverse();
  let totalMessages = msgPayload.total ?? 0;

  // State
  const knownMsgIds = new Set(initialMessages.map((m) => m.id));
  let latestMsgId = initialMessages.length
    ? Math.max(...initialMessages.map((m) => m.id))
    : 0;
  let olderOffset = initialMessages.length;
  let botEnabled = conv.bot_enabled;

  // 3. Build UI
  container.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.className = "chat-wrapper";
  wrapper.innerHTML = `
    <div class="chat-header">
      <div class="chat-header-left">
        <button type="button" class="secondary sm" id="chat-back">← Listado</button>
        <button type="button" class="secondary sm" id="chat-files">Archivos</button>
      </div>
      <div class="chat-header-center">
        <span>${escapeHtml(conv.phone_number)}</span>
      </div>
      <div class="chat-header-right">
        <button type="button" class="bot-toggle-btn ${botEnabled ? "bot-on" : "bot-off"}" id="chat-bot-toggle">
          <span class="bot-toggle-dot"></span>
          <span class="bot-toggle-label">${botEnabled ? "Bot ON" : "Bot OFF"}</span>
        </button>
      </div>
    </div>
    <div class="chat-messages" id="chat-messages">
      <div class="chat-load-more-wrapper" id="chat-load-more-wrapper" ${totalMessages <= olderOffset ? 'style="display:none"' : ""}>
        <button type="button" class="secondary sm" id="chat-load-more">Cargar mensajes anteriores</button>
      </div>
    </div>
    <div class="chat-input-bar">
      <div class="chat-bot-status ${botEnabled ? "bot-status-on" : "bot-status-off"}" id="chat-bot-status">
        ${botEnabled ? "🤖 Bot activo — respondiendo automáticamente" : "✍️ Bot desactivado — respuesta manual"}
      </div>
      <div class="chat-input-row">
        <textarea id="chat-textarea" placeholder="Escribe un mensaje como el bot…" rows="1"></textarea>
        <button type="button" class="chat-send-btn" id="chat-send-btn" title="Enviar">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
      </div>
    </div>
  `;
  container.appendChild(wrapper);

  const messagesArea = wrapper.querySelector("#chat-messages");
  const loadMoreWrapper = wrapper.querySelector("#chat-load-more-wrapper");
  const botToggleBtn = wrapper.querySelector("#chat-bot-toggle");
  const botStatusEl = wrapper.querySelector("#chat-bot-status");
  const textarea = wrapper.querySelector("#chat-textarea");
  const sendBtn = wrapper.querySelector("#chat-send-btn");

  function updateBotUI(enabled) {
    botEnabled = enabled;
    botToggleBtn.className = `bot-toggle-btn ${enabled ? "bot-on" : "bot-off"}`;
    botToggleBtn.querySelector(".bot-toggle-label").textContent = enabled
      ? "Bot ON"
      : "Bot OFF";
    botStatusEl.className = `chat-bot-status ${enabled ? "bot-status-on" : "bot-status-off"}`;
    botStatusEl.textContent = enabled
      ? "🤖 Bot activo — respondiendo automáticamente"
      : "✍️ Bot desactivado — respuesta manual";
  }

  // Render helpers
  function appendBubble(m) {
    if (knownMsgIds.has(m.id)) return;
    knownMsgIds.add(m.id);
    if (m.id > latestMsgId) latestMsgId = m.id;
    messagesArea.appendChild(buildMessageBubble(m));
  }

  function prependBubbles(msgs) {
    const anchor = messagesArea.querySelector("[data-msg-id]");
    for (const m of msgs) {
      if (knownMsgIds.has(m.id)) continue;
      knownMsgIds.add(m.id);
      const bubble = buildMessageBubble(m);
      anchor
        ? messagesArea.insertBefore(bubble, anchor)
        : messagesArea.appendChild(bubble);
    }
  }

  // Render initial messages
  for (const m of initialMessages) appendBubble(m);
  messagesArea.scrollTop = messagesArea.scrollHeight;

  // Navigation
  wrapper.querySelector("#chat-back").addEventListener("click", () => {
    stopChatPoll();
    navTo("list", { page: 1, pageSize });
  });
  wrapper.querySelector("#chat-files").addEventListener("click", () => {
    stopChatPoll();
    navTo("files", { conversationId, page: 1, pageSize });
  });

  // Bot toggle
  botToggleBtn.addEventListener("click", async () => {
    botToggleBtn.disabled = true;
    const res = await apiFetch(
      `/doctors/${sessionDoctorId}/conversations/${conversationId}/bot`,
      { method: "PATCH", body: JSON.stringify({ bot_enabled: !botEnabled }) }
    );
    botToggleBtn.disabled = false;
    if (res.ok) {
      const updated = await res.json();
      updateBotUI(updated.bot_enabled);
    }
  });

  // Textarea auto-resize
  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
  });

  // Send on Enter (Shift+Enter = new line)
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });
  sendBtn.addEventListener("click", doSend);

  async function doSend() {
    const content = textarea.value.trim();
    if (!content) return;
    sendBtn.disabled = true;
    textarea.disabled = true;

    const res = await apiFetch(
      `/doctors/${sessionDoctorId}/conversations/${conversationId}/messages`,
      { method: "POST", body: JSON.stringify({ content }) }
    );

    sendBtn.disabled = false;
    textarea.disabled = false;
    textarea.focus();

    if (!res.ok) return;
    const newMsg = await res.json();
    appendBubble(newMsg);
    textarea.value = "";
    textarea.style.height = "auto";
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  // Load more older messages
  wrapper.querySelector("#chat-load-more").addEventListener("click", async () => {
    const btn = wrapper.querySelector("#chat-load-more");
    btn.disabled = true;
    btn.textContent = "Cargando…";

    const res = await apiFetch(
      `/doctors/${sessionDoctorId}/conversations/${conversationId}/messages?limit=${CHAT_LIMIT}&offset=${olderOffset}`
    );
    if (!res.ok) {
      btn.disabled = false;
      btn.textContent = "Cargar mensajes anteriores";
      return;
    }
    const payload = await res.json();
    const older = (payload.items || []).slice().reverse();
    totalMessages = payload.total ?? totalMessages;

    const prevScrollHeight = messagesArea.scrollHeight;
    prependBubbles(older);
    messagesArea.scrollTop =
      messagesArea.scrollHeight - prevScrollHeight + messagesArea.scrollTop;

    olderOffset += older.length;
    if (olderOffset >= totalMessages) {
      loadMoreWrapper.style.display = "none";
    } else {
      btn.disabled = false;
      btn.textContent = "Cargar mensajes anteriores";
    }
  });

  // Polling — check for new messages every 3s
  async function pollNewMessages() {
    if (!document.getElementById("chat-messages")) {
      stopChatPoll();
      return;
    }
    try {
      const res = await apiFetch(
        `/doctors/${sessionDoctorId}/conversations/${conversationId}/messages?limit=${CHAT_LIMIT}&offset=0`
      );
      if (!res.ok) return;
      const payload = await res.json();
      const items = (payload.items || []).slice().reverse();
      const newItems = items.filter((m) => m.id > latestMsgId);
      if (!newItems.length) return;

      const atBottom =
        messagesArea.scrollHeight -
          messagesArea.scrollTop -
          messagesArea.clientHeight <
        80;
      for (const m of newItems) appendBubble(m);
      if (atBottom) messagesArea.scrollTop = messagesArea.scrollHeight;
    } catch {
      // ignore transient poll errors
    }
  }

  chatPollInterval = setInterval(pollNewMessages, 3000);
}

async function renderFiles(container, conversationId, route) {
  let { page, pageSize } = route;
  const offset = (page - 1) * pageSize;
  const res = await apiFetch(
    `/doctors/${sessionDoctorId}/conversations/${conversationId}/attachments?limit=${pageSize}&offset=${offset}`
  );
  if (res.status === 401) {
    sessionDoctorId = null;
    location.hash = "#/login";
    await render();
    return;
  }
  if (res.status === 404) {
    container.innerHTML = `<div class="card error">Conversación no encontrada.</div>`;
    return;
  }
  if (!res.ok) {
    container.innerHTML = `<div class="card error">Error al cargar adjuntos.</div>`;
    return;
  }
  const payload = await res.json();
  const attachments = payload.items || [];
  const total = payload.total ?? 0;
  const totalPages = total > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  if (total > 0 && page > totalPages) {
    navTo("files", { conversationId, page: totalPages, pageSize });
    return;
  }

  container.innerHTML = "";
  const wrap = el(`<div class="card"><h1>Archivos de la conversación</h1></div>`);

  const navInner = `
      <button type="button" class="secondary sm" id="back-list">Volver al listado</button>
      <button type="button" class="secondary sm" id="go-chat">Ver chat</button>
    `;
  const sticky = buildStickyToolbar({
    page,
    pageSize,
    total,
    onPageSizeChange: (ps) =>
      navTo("files", { conversationId, page: 1, pageSize: ps }),
    onPrev: () =>
      navTo("files", {
        conversationId,
        page: Math.max(1, page - 1),
        pageSize,
      }),
    onNext: () =>
      navTo("files", {
        conversationId,
        page: Math.min(totalPages, page + 1),
        pageSize,
      }),
    navRowInner: navInner,
  });
  wrap.appendChild(sticky);

  sticky.querySelector("#back-list").addEventListener("click", () =>
    navTo("list", { page: 1, pageSize })
  );
  sticky.querySelector("#go-chat").addEventListener("click", () =>
    navTo("chat", { conversationId, page: 1, pageSize })
  );

  if (!attachments.length) {
    wrap.appendChild(el(`<p class="meta">No hay archivos en esta conversación.</p>`));
    container.appendChild(wrap);
    return;
  }
  const table = el(`
    <table>
      <thead>
        <tr>
          <th>Nombre</th>
          <th>Tipo</th>
          <th>Fecha</th>
          <th></th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  `);
  const tbody = table.querySelector("tbody");
  for (const a of attachments) {
    const name = a.original_filename || a.s3_key || "archivo";
    const link =
      a.download_url != null
        ? `<a class="btn secondary sm" href="${escapeAttr(
            resolveApiUrl(a.download_url)
          )}" download rel="noopener">Descargar</a>`
        : `<span class="meta">Enlace no disponible</span>`;
    const tr = el(`
      <tr>
        <td>${escapeHtml(name)}</td>
        <td>${escapeHtml(a.content_type || "")}</td>
        <td class="meta">${formatDate(a.created_at)}</td>
        <td>${link}</td>
      </tr>
    `);
    tbody.appendChild(tr);
  }
  const tableWrap = document.createElement("div");
  tableWrap.className = "table-scroll";
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);
  container.appendChild(wrap);
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

async function render() {
  stopChatPoll();
  const app = document.getElementById("app");
  if (!app) return;
  app.classList.remove("chat-mode");

  const route = parseHash();
  const ok = sessionDoctorId != null ? true : await trySession();

  if (!ok) {
    setTopbarAuthVisible(false);
    if (route.view !== "login") {
      location.hash = "#/login";
    }
    renderLogin(app, null);
    return;
  }

  if (route.view === "login") {
    navTo("list", { page: 1, pageSize: route.pageSize || 20 });
    await render();
    return;
  }

  setTopbarAuthVisible(true);

  if (route.view === "change-password") {
    renderChangePassword(app);
    return;
  }

  if (route.view === "list") {
    await renderList(app, route);
    return;
  }
  if (route.view === "chat" && route.conversationId) {
    await renderChat(app, route.conversationId, route);
    return;
  }
  if (route.view === "files" && route.conversationId) {
    await renderFiles(app, route.conversationId, route);
    return;
  }
  await renderList(app, route);
}

function goHome() {
  if (!sessionDoctorId) return;
  navTo("list", { page: 1, pageSize: 20 });
  render();
}

document.getElementById("btn-home").addEventListener("click", goHome);
document.getElementById("btn-brand-icon").addEventListener("click", goHome);

document.getElementById("btn-change-password").addEventListener("click", () => {
  location.hash = "#/change-password";
  render();
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  await apiFetch("/auth/logout", { method: "POST" });
  sessionDoctorId = null;
  location.hash = "#/login";
  await render();
});

window.addEventListener("hashchange", () => {
  render();
});

if (!location.hash || location.hash === "#") {
  location.replace("#/?p=1&ps=20");
}
render();

// Theme toggle
(function () {
  const root = document.documentElement;
  const btn = document.getElementById("btn-theme");
  const icon = btn && btn.querySelector(".theme-icon");

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    localStorage.setItem("coyote-theme", theme);
    if (icon) icon.textContent = theme === "light" ? "☀️" : "🌙";
  }

  applyTheme(localStorage.getItem("coyote-theme") || "dark");

  if (btn) {
    btn.addEventListener("click", () => {
      const next =
        root.getAttribute("data-theme") === "light" ? "dark" : "light";
      applyTheme(next);
    });
  }
})();
