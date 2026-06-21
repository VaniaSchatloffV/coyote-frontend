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
  container.appendChild(card);
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
          <button type="button" class="secondary" id="toolbar-prev">Anterior</button>
          <button type="button" class="secondary" id="toolbar-next">Siguiente</button>
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
          <button type="button" data-chat="${c.id}">Ver conversación</button>
          <button type="button" class="secondary" data-files="${
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

async function renderChat(container, conversationId, route) {
  let { page, pageSize } = route;
  const offset = (page - 1) * pageSize;
  const res = await apiFetch(
    `/doctors/${sessionDoctorId}/conversations/${conversationId}/messages?limit=${pageSize}&offset=${offset}`
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
    container.innerHTML = `<div class="card error">Error al cargar mensajes.</div>`;
    return;
  }
  const payload = await res.json();
  const messages = payload.items || [];
  const total = payload.total ?? 0;
  const totalPages = total > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  if (total > 0 && page > totalPages) {
    navTo("chat", { conversationId, page: totalPages, pageSize });
    return;
  }

  container.innerHTML = "";
  const wrap = el(`<div class="card"><h1>Conversación</h1></div>`);

  const navInner = `
      <button type="button" class="secondary" id="back-list">Volver al listado</button>
      <button type="button" class="secondary" id="go-files">Ver archivos</button>
    `;
  const bar = buildStickyToolbar({
    page,
    pageSize,
    total,
    onPageSizeChange: (ps) =>
      navTo("chat", { conversationId, page: 1, pageSize: ps }),
    onPrev: () =>
      navTo("chat", {
        conversationId,
        page: Math.max(1, page - 1),
        pageSize,
      }),
    onNext: () =>
      navTo("chat", {
        conversationId,
        page: Math.min(totalPages, page + 1),
        pageSize,
      }),
    navRowInner: navInner,
  });
  wrap.appendChild(bar);

  bar.querySelector("#back-list").addEventListener("click", () =>
    navTo("list", { page: 1, pageSize })
  );
  bar.querySelector("#go-files").addEventListener("click", () =>
    navTo("files", { conversationId, page: 1, pageSize })
  );

  const box = document.createElement("div");
  for (const m of messages) {
    const roleClass = m.role === "user" ? "user" : "assistant";
    const attHint =
      m.attachments && m.attachments.length
        ? `<div class="attachment-chips">${m.attachments
            .map((a) => {
              const label =
                escapeHtml(a.original_filename || a.s3_key || "archivo");
              const href = a.download_url
                ? escapeAttr(resolveApiUrl(a.download_url))
                : "#";
              const link = a.download_url
                ? `<a class="btn secondary sm" href="${href}" download>Descargar</a>`
                : `<span class="meta">Sin enlace</span>`;
              return `<div class="att-row"><span class="meta">${label}</span> ${link}</div>`;
            })
            .join("")}</div>`
        : "";
    const div = el(`
      <div class="msg ${roleClass}">
        <div class="meta">${escapeHtml(m.role)} · ${formatDate(m.created_at)}</div>
        <div>${escapeHtml(m.content)}</div>
        ${attHint}
      </div>
    `);
    box.appendChild(div);
  }
  wrap.appendChild(box);
  container.appendChild(wrap);
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
      <button type="button" class="secondary" id="back-list">Volver al listado</button>
      <button type="button" class="secondary" id="go-chat">Ver chat</button>
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
        ? `<a class="btn secondary" href="${escapeAttr(
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
  wrap.appendChild(table);
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
  const app = document.getElementById("app");
  if (!app) return;

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
