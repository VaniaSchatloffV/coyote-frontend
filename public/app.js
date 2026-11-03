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
let listSearchQuery = "";
let listSearchDebounce = null;
// "Estado conversación" (etiquetas IA): selección única. "" = Todos, "__none__" = Sin clasificar.
let listStateFilter = "";
// "Clasificación contacto": ids que el contacto debe tener todos, o "Sin clasificar contacto" (excluyente).
let listContactFilter = new Set();
let listContactNone = false;
let lastTagAt = null;
let tagTimerInterval = null;

function stopTagTimer() {
  if (tagTimerInterval !== null) {
    clearInterval(tagTimerInterval);
    tagTimerInterval = null;
  }
}

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

function openModal({ title, bodyEl }) {
  const overlay = el(`<div class="modal-overlay"></div>`);
  const modal = el(`
    <div class="modal">
      <div class="modal-header">
        <h2>${escapeHtml(title)}</h2>
        <button type="button" class="modal-close-btn" aria-label="Cerrar">&times;</button>
      </div>
      <div class="modal-body"></div>
    </div>
  `);
  modal.querySelector(".modal-body").appendChild(bodyEl);
  overlay.appendChild(modal);

  function close() {
    document.removeEventListener("keydown", onKeydown);
    overlay.remove();
  }
  function onKeydown(ev) {
    if (ev.key === "Escape") close();
  }

  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });
  modal.querySelector(".modal-close-btn").addEventListener("click", close);
  document.addEventListener("keydown", onKeydown);
  document.body.appendChild(overlay);

  return { overlay, modal, close };
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
  if (parts[0] === "conversations" && !parts[1]) {
    return { view: "list", page, pageSize };
  }
  if (parts[0] === "login") {
    return { view: "login", page: 1, pageSize: 20 };
  }
  if (parts[0] === "change-password") {
    return { view: "change-password", page: 1, pageSize: 20 };
  }
  if (parts[0] === "knowledge") {
    return { view: "knowledge", page: 1, pageSize: 20 };
  }
  if (parts[0] === "prompt") {
    return { view: "prompt", page: 1, pageSize: 20 };
  }
  if (parts[0] === "classifications") {
    return { view: "classifications", page: 1, pageSize: 20 };
  }
  if (parts[0] === "bulk-send") {
    return { view: "bulk-send", page, pageSize };
  }
  if (parts[0] === "catchup") {
    return { view: "catchup", page: 1, pageSize: 20 };
  }
  // Empty path (#/) and any unrecognized path resolve to the dashboard (new home).
  return { view: "dashboard", page, pageSize };
}

/**
 * @param {"dashboard"|"list"|"chat"|"files"} view
 * @param {{ conversationId?: number, page?: number, pageSize?: number }} opts
 */
function navTo(view, opts = {}) {
  const page = opts.page != null ? opts.page : 1;
  const pageSize = opts.pageSize != null ? opts.pageSize : 20;
  const qs = new URLSearchParams();
  qs.set("p", String(page));
  qs.set("ps", String(pageSize));
  const q = qs.toString();
  if (view === "dashboard") {
    location.hash = `#/`;
  } else if (view === "list") {
    location.hash = `#/conversations?${q}`;
  } else if (view === "chat" && opts.conversationId != null) {
    location.hash = `#/conversations/${opts.conversationId}/chat?${q}`;
  } else if (view === "files" && opts.conversationId != null) {
    location.hash = `#/conversations/${opts.conversationId}/files?${q}`;
  } else if (view === "knowledge") {
    location.hash = `#/knowledge`;
  } else if (view === "prompt") {
    location.hash = `#/prompt`;
  } else if (view === "classifications") {
    location.hash = `#/classifications`;
  } else {
    location.hash = `#/`;
  }
}

function setSidebarVisible(show) {
  const sidebar = document.getElementById("sidebar");
  const mobileToggle = document.getElementById("btn-sidebar-toggle");
  if (sidebar) sidebar.classList.toggle("hidden", !show);
  if (mobileToggle) mobileToggle.classList.toggle("hidden", !show);
  if (!show) closeMobileSidebar();
}

function closeMobileSidebar() {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");
  if (sidebar) sidebar.classList.remove("open");
  if (backdrop) backdrop.classList.add("hidden");
}

function updateActiveNav(view) {
  const activeRoute =
    view === "list" || view === "chat" || view === "files"
      ? "conversations"
      : view === "knowledge"
      ? "knowledge"
      : view === "prompt"
      ? "prompt"
      : view === "classifications"
      ? "classifications"
      : view === "bulk-send"
      ? "bulk-send"
      : view === "catchup"
      ? "catchup"
      : "dashboard";
  document.querySelectorAll(".sidebar-link").forEach((link) => {
    link.classList.toggle("active", link.dataset.route === activeRoute);
  });
  refreshSidebarGroupHighlight();
}

// ── Grupos del sidebar ──────────────────────────────────────────────────────
// Parten cerrados (no se persiste su estado) y se cierran al colapsar el sidebar.

function setSidebarGroupOpen(group, open) {
  group.classList.toggle("open", open);
  const btn = group.querySelector(".sidebar-group-btn");
  if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  refreshSidebarGroupHighlight();
}

function closeAllSidebarGroups() {
  document.querySelectorAll(".sidebar-group").forEach((g) => setSidebarGroupOpen(g, false));
}

/** Un grupo cerrado que contiene la página actual se resalta. */
function refreshSidebarGroupHighlight() {
  document.querySelectorAll(".sidebar-group").forEach((group) => {
    const hasActive = !!group.querySelector(".sidebar-link.active");
    const btn = group.querySelector(".sidebar-group-btn");
    if (btn) btn.classList.toggle("active", hasActive && !group.classList.contains("open"));
  });
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
    navTo("dashboard");
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
    navTo("dashboard");
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

function convTagClass(tag) {
  if (!tag) return "blue";
  switch (tag) {
    case "Agendamiento":              return "green";
    case "Requiere asistente humano": return "orange";
    case "Conversacion finalizada":   return "purple";
    case "Mal uso del bot":           return "red";
    default:                          return "blue";
  }
}

// ── Clasificaciones de contacto (helpers compartidos) ──────────────────────

const CONTACT_PRESET_COLORS = [
  { hex: "#3b82f6", name: "Azul" },
  { hex: "#22c55e", name: "Verde" },
  { hex: "#ef4444", name: "Rojo" },
  { hex: "#f97316", name: "Naranja" },
  { hex: "#8b5cf6", name: "Morado" },
  { hex: "#14b8a6", name: "Turquesa" },
  { hex: "#ec4899", name: "Rosado" },
  { hex: "#64748b", name: "Gris" },
];
const CONTACT_NAME_MAX = 32;
const CONTACT_DESCRIPTION_MAX = 250;
const DOCTOR_CONTACT_NAME_MAX = 200;

/** Solo colores #RRGGBB llegan a un atributo style; cualquier otro valor cae a gris. */
function safeHexColor(color) {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)
    ? color.toLowerCase()
    : "#64748b";
}

/** Texto negro o blanco según la luminancia del fondo (se lee igual en tema claro y oscuro). */
function badgeTextColor(hex) {
  const c = safeHexColor(hex);
  const channel = (i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.179 ? "#000000" : "#ffffff";
}

function contactBadgeHtml(cc) {
  const bg = safeHexColor(cc.color);
  return `<span class="contact-badge" style="background:${bg};color:${badgeTextColor(bg)}">${escapeHtml(cc.name)}</span>`;
}

function contactBadgesHtml(list) {
  if (!list || !list.length) {
    return `<span class="contact-badge contact-badge-none">Sin clasificar contacto</span>`;
  }
  return list.map(contactBadgeHtml).join("");
}

/** Nombre del doctor destacado y el de WhatsApp en gris (si hay ambos). */
function contactNamesHtml(c) {
  if (c.doctor_contact_name) {
    const wa = c.contact_name
      ? ` <span class="contact-name-wa">(WhatsApp: ${escapeHtml(c.contact_name)})</span>`
      : "";
    return `<span class="contact-name">${escapeHtml(c.doctor_contact_name)}</span>${wa}`;
  }
  return c.contact_name ? `<span class="contact-name">${escapeHtml(c.contact_name)}</span>` : "";
}

function lastMessageText(c) {
  return `Último mensaje: ${formatDate(c.last_message_at || c.created_at)}`;
}

async function apiErrorDetail(res, fallback) {
  try {
    const err = await res.json();
    if (err.detail) {
      return Array.isArray(err.detail)
        ? err.detail.map((d) => (d.msg || String(d)).replace(/^Value error, /, "")).join(" ")
        : String(err.detail);
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

/** Lista alfabética de clasificaciones del doctor, o null si falla (401 redirige al login). */
async function fetchContactClassifications() {
  const res = await apiFetch(`/doctors/${sessionDoctorId}/contact-classifications`);
  if (res.status === 401) {
    sessionDoctorId = null;
    location.hash = "#/login";
    await render();
    return null;
  }
  if (!res.ok) return null;
  return res.json();
}

/**
 * Modal "Clasificar" (listado y chat): clasificaciones del contacto + nombre puesto por el doctor.
 * onSaved recibe la conversación actualizada.
 */
function openClassifyModal(conv, classifications, onSaved) {
  const assigned = new Set((conv.contact_classifications || []).map((cc) => cc.id));
  const optionsHtml = classifications.length
    ? classifications
        .map(
          (cc) => `
            <label class="classify-option">
              <input type="checkbox" value="${cc.id}" ${assigned.has(cc.id) ? "checked" : ""} />
              ${contactBadgeHtml(cc)}
            </label>
          `
        )
        .join("")
    : `<p class="meta">Aún no tienes clasificaciones. Créalas en
         <a href="#/classifications" class="classify-go-config">Configuración conversaciones → Clasificaciones</a>.</p>`;
  const waHint = conv.contact_name
    ? `Nombre en WhatsApp: ${escapeHtml(conv.contact_name)}`
    : "El contacto no tiene nombre en WhatsApp.";

  const body = el(`
    <form class="classify-form">
      <div class="classify-form-error error" style="display:none"></div>
      <p class="meta">${escapeHtml(conv.phone_number)}</p>

      <label for="classify-contact-name">Nombre del contacto</label>
      <p class="meta">${waHint}</p>
      <div class="classify-name-row">
        <input id="classify-contact-name" type="text" maxlength="${DOCTOR_CONTACT_NAME_MAX}"
          value="${escapeAttr(conv.doctor_contact_name || "")}" placeholder="Nombre propio (opcional)" autocomplete="off" />
        <button type="button" class="secondary sm classify-clear-name">Borrar nombre</button>
      </div>

      <label>Clasificación contacto</label>
      <div class="classify-options">${optionsHtml}</div>

      <div class="form-actions">
        <button type="submit">Guardar</button>
        <button type="button" class="btn sm secondary classify-cancel">Cancelar</button>
      </div>
    </form>
  `);
  const { close } = openModal({ title: "Clasificar contacto", bodyEl: body });
  const nameInp = body.querySelector("#classify-contact-name");
  const errorEl = body.querySelector(".classify-form-error");
  body.querySelector(".classify-cancel").addEventListener("click", close);
  body.querySelector(".classify-clear-name").addEventListener("click", () => {
    nameInp.value = "";
    nameInp.focus();
  });
  const goConfig = body.querySelector(".classify-go-config");
  if (goConfig) goConfig.addEventListener("click", close);

  body.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    errorEl.style.display = "none";
    const submitBtn = body.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    const selectedIds = Array.from(body.querySelectorAll(".classify-options input:checked")).map((i) =>
      parseInt(i.value, 10)
    );
    const idsChanged =
      selectedIds.length !== assigned.size || selectedIds.some((id) => !assigned.has(id));
    const newName = nameInp.value.trim();
    const nameChanged = newName !== (conv.doctor_contact_name || "");

    let updated = conv;
    try {
      if (idsChanged) {
        const res = await apiFetch(
          `/doctors/${sessionDoctorId}/conversations/${conv.id}/contact-classifications`,
          { method: "PUT", body: JSON.stringify({ classification_ids: selectedIds }) }
        );
        if (!res.ok) {
          throw new Error(await apiErrorDetail(res, "No se pudieron guardar las clasificaciones."));
        }
        updated = await res.json();
      }
      if (nameChanged) {
        const res = await apiFetch(
          `/doctors/${sessionDoctorId}/conversations/${conv.id}/contact-name`,
          { method: "PATCH", body: JSON.stringify({ doctor_contact_name: newName || null }) }
        );
        if (!res.ok) {
          throw new Error(await apiErrorDetail(res, "No se pudo guardar el nombre."));
        }
        updated = await res.json();
      }
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
      submitBtn.disabled = false;
      // Lo que alcanzó a guardarse igual se refleja.
      if (updated !== conv) onSaved(updated);
      return;
    }
    close();
    if (updated !== conv) onSaved(updated);
  });
}

function dashboardTagBreakdownHtml(byTag) {
  const entries = Object.entries(byTag || {});
  if (!entries.length) {
    return `<p class="meta">Sin conversaciones clasificadas.</p>`;
  }
  return entries
    .map(
      ([tag, count]) => `
        <div class="dashboard-tag-row">
          <span class="conv-tag conv-tag-${convTagClass(tag)}">${escapeHtml(tag)}</span>
          <span class="dashboard-tag-count">${count}</span>
        </div>
      `
    )
    .join("");
}

function dashboardContactBreakdownHtml(data) {
  const rows = (data.by_contact_classification || []).map(
    (cc) => `
      <div class="dashboard-tag-row">
        ${contactBadgeHtml(cc)}
        <span class="dashboard-tag-count">${cc.count}</span>
      </div>
    `
  );
  rows.push(`
    <div class="dashboard-tag-row">
      <span class="contact-badge contact-badge-none">Sin clasificar contacto</span>
      <span class="dashboard-tag-count">${data.contact_unclassified_count ?? 0}</span>
    </div>
  `);
  return rows.join("");
}

async function renderDashboard(container) {
  container.innerHTML = "";
  container.classList.remove("chat-mode");

  const wrap = el(`<div class="card"><h1>Dashboard</h1><div id="dashboard-body">Cargando…</div></div>`);
  container.appendChild(wrap);

  const res = await apiFetch(`/doctors/${sessionDoctorId}/dashboard/summary`);
  if (res.status === 401) {
    sessionDoctorId = null;
    location.hash = "#/login";
    await render();
    return;
  }
  const body = wrap.querySelector("#dashboard-body");
  if (!res.ok) {
    body.innerHTML = `<div class="error">No se pudo cargar el resumen.</div>`;
    return;
  }
  const data = await res.json();

  body.innerHTML = `
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-value">${data.total_conversations}</div>
        <div class="metric-label">Conversaciones totales</div>
      </div>
      <div class="metric-card">
        <div class="metric-value">${data.unclassified_count}</div>
        <div class="metric-label">Sin estado</div>
      </div>
      <div class="metric-card">
        <div class="metric-value">${data.bot_enabled_count}</div>
        <div class="metric-label">Bot activo</div>
      </div>
      <div class="metric-card">
        <div class="metric-value">${data.bot_disabled_count}</div>
        <div class="metric-label">Bot desactivado</div>
      </div>
    </div>
    <h2>Por estado conversación</h2>
    <div class="dashboard-tag-list">${dashboardTagBreakdownHtml(data.by_classification_tag)}</div>
    <h2>Por clasificación contacto</h2>
    <div class="dashboard-tag-list">${dashboardContactBreakdownHtml(data)}</div>
    <h2>Conversaciones recientes</h2>
    <div id="dashboard-recent"></div>
  `;

  const recentEl = body.querySelector("#dashboard-recent");
  const recent = data.recent_conversations || [];
  if (!recent.length) {
    recentEl.innerHTML = `<p class="meta">No hay conversaciones.</p>`;
  } else {
    for (const c of recent) {
      const row = el(`
        <div class="conversation-row">
          <div class="conv-info">
            <div>${contactNamesHtml(c)}</div>
            <strong>${escapeHtml(c.phone_number)}</strong>
            <div class="meta">${escapeHtml(lastMessageText(c))}</div>
          </div>
          <div class="conv-actions">
            <button type="button" class="sm" data-chat="${c.id}">Ver conversación</button>
          </div>
        </div>
      `);
      row.querySelector("[data-chat]").addEventListener("click", () => {
        navTo("chat", { conversationId: c.id, page: 1, pageSize: 20 });
      });
      recentEl.appendChild(row);
    }
  }
}

async function renderList(container, route) {
  let { page, pageSize } = route;

  container.innerHTML = "";
  container.classList.remove("chat-mode");

  const wrap = el(`<div class="card"><h1>Conversaciones</h1></div>`);
  container.appendChild(wrap);

  // Search bar (created once — not destroyed on data reload)
  const searchWrap = el(`
    <div class="search-bar-wrap">
      <input type="text" id="conv-search" class="search-input"
        placeholder="Buscar por nombre o número…" autocomplete="off" />
    </div>
  `);
  const searchInp = searchWrap.querySelector("#conv-search");
  searchInp.value = listSearchQuery;
  wrap.appendChild(searchWrap);

  // ── Tag action row ───────────────────────────────────────────────────────
  const tagRow = document.createElement("div");
  tagRow.className = "tag-action-row";

  const tagBtn = document.createElement("button");
  tagBtn.type = "button";
  tagBtn.className = "sm muted";
  tagBtn.textContent = "Taggear";

  const lastTagText = document.createElement("span");
  lastTagText.className = "tag-info-text";

  const nextTagText = document.createElement("span");
  nextTagText.className = "tag-info-text";

  const tagInfoCol = document.createElement("div");
  tagInfoCol.className = "tag-info-col";
  tagInfoCol.appendChild(lastTagText);
  tagInfoCol.appendChild(nextTagText);

  tagRow.appendChild(tagBtn);
  tagRow.appendChild(tagInfoCol);
  wrap.appendChild(tagRow);

  function getNextAutoRun() {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next;
  }

  function updateNextTagText() {
    const next = getNextAutoRun();
    const hh = String(next.getHours()).padStart(2, "0");
    const mm = String(next.getMinutes()).padStart(2, "0");
    nextTagText.textContent = `Próximo Tag Automático: ${hh}:${mm}`;
  }

  function updateLastTagText() {
    if (!lastTagAt) {
      lastTagText.textContent = "Último Tag: --:--";
      return;
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - lastTagAt.getTime()) / 1000));
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    lastTagText.textContent = `Último Tag: ${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  updateNextTagText();
  updateLastTagText();

  // Fetch last run time from backend
  apiFetch(`/doctors/${sessionDoctorId}/classify/status`).then(async (res) => {
    if (res.ok) {
      const data = await res.json();
      if (data.last_run_at) {
        lastTagAt = new Date(data.last_run_at);
        updateLastTagText();
      }
    }
  });

  // Live timer
  stopTagTimer();
  tagTimerInterval = setInterval(() => {
    updateLastTagText();
    updateNextTagText();
  }, 1000);

  tagBtn.addEventListener("click", async () => {
    tagBtn.disabled = true;
    tagBtn.textContent = "Taggeando…";
    try {
      const res = await apiFetch(
        `/doctors/${sessionDoctorId}/conversations/classify`,
        { method: "POST" }
      );
      if (res.ok) {
        const data = await res.json();
        lastTagAt = new Date(data.ran_at);
        updateLastTagText();
        await loadData(page);
      }
    } finally {
      tagBtn.disabled = false;
      tagBtn.textContent = "Taggear";
    }
  });
  // ── End tag action row ────────────────────────────────────────────────────

  // ── Filtros (desplegables) ────────────────────────────────────────────────
  const STATE_FILTER_OPTIONS = [
    { value: "", label: "Todos" },
    { value: "__none__", label: "Sin clasificar" },
    { value: "Preguntas frecuentes", label: "Preguntas frecuentes" },
    { value: "Agendamiento", label: "Agendamiento" },
    { value: "Requiere asistente humano", label: "Requiere asistente humano" },
    { value: "Conversacion finalizada", label: "Conversacion finalizada" },
    { value: "Mal uso del bot", label: "Mal uso del bot" },
  ];

  // Una sola carga por vista: se reutiliza para el filtro y el modal "Clasificar".
  const classifications = (await fetchContactClassifications()) || [];
  if (sessionDoctorId == null) return;
  // Descartar del filtro clasificaciones que ya no existen.
  const existingIds = new Set(classifications.map((cc) => cc.id));
  for (const id of Array.from(listContactFilter)) {
    if (!existingIds.has(id)) listContactFilter.delete(id);
  }

  const filterWrap = el(`
    <div class="conv-filter-bar">
      <label class="filter-field">
        <span class="filter-field-label">Estado conversación</span>
        <select id="filter-state" class="filter-select">
          ${STATE_FILTER_OPTIONS.map(
            (o) => `<option value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</option>`
          ).join("")}
        </select>
      </label>
      <div class="filter-field">
        <span class="filter-field-label">Clasificación contacto</span>
        <details class="filter-dropdown" id="filter-contact">
          <summary class="filter-select"></summary>
          <div class="filter-dropdown-panel"></div>
        </details>
      </div>
    </div>
  `);
  wrap.appendChild(filterWrap);

  const stateSelect = filterWrap.querySelector("#filter-state");
  stateSelect.value = listStateFilter;
  stateSelect.addEventListener("change", () => {
    listStateFilter = stateSelect.value;
    loadData(1);
  });

  const contactDropdown = filterWrap.querySelector("#filter-contact");
  const contactSummary = contactDropdown.querySelector("summary");
  const contactPanel = contactDropdown.querySelector(".filter-dropdown-panel");

  function contactSummaryText() {
    if (listContactNone) return "Sin clasificar contacto";
    if (!listContactFilter.size) return "Todas";
    const names = classifications.filter((cc) => listContactFilter.has(cc.id)).map((cc) => cc.name);
    return names.length <= 2 ? names.join(" + ") : `${names.length} seleccionadas`;
  }

  function renderContactPanel() {
    contactSummary.textContent = contactSummaryText();
    const optionsHtml = classifications
      .map(
        (cc) => `
          <label class="filter-dropdown-option">
            <input type="checkbox" data-cc-id="${cc.id}" ${listContactFilter.has(cc.id) ? "checked" : ""} />
            ${contactBadgeHtml(cc)}
          </label>
        `
      )
      .join("");
    contactPanel.innerHTML = `
      <label class="filter-dropdown-option">
        <input type="checkbox" data-cc-none="1" ${listContactNone ? "checked" : ""} />
        <span class="contact-badge contact-badge-none">Sin clasificar contacto</span>
      </label>
      ${classifications.length ? `<div class="filter-dropdown-sep"></div>${optionsHtml}` : `
        <p class="meta filter-dropdown-empty">Aún no hay clasificaciones.
          <a href="#/classifications">Crear clasificaciones</a></p>`}
      <div class="filter-dropdown-actions">
        <button type="button" class="secondary sm" data-cc-clear="1">Limpiar</button>
      </div>
    `;
  }

  // Marcar "Sin clasificar contacto" desmarca las demás; marcar una clasificación lo desmarca.
  contactPanel.addEventListener("change", (ev) => {
    const input = ev.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.dataset.ccNone) {
      listContactNone = input.checked;
      if (listContactNone) listContactFilter.clear();
    } else if (input.dataset.ccId) {
      const id = parseInt(input.dataset.ccId, 10);
      if (input.checked) {
        listContactFilter.add(id);
        listContactNone = false;
      } else {
        listContactFilter.delete(id);
      }
    }
    renderContactPanel();
    loadData(1);
  });
  contactPanel.addEventListener("click", (ev) => {
    if (ev.target instanceof HTMLElement && ev.target.dataset.ccClear) {
      listContactFilter.clear();
      listContactNone = false;
      renderContactPanel();
      loadData(1);
    }
  });
  renderContactPanel();
  // ── Fin filtros ───────────────────────────────────────────────────────────

  const toolbarSlot = document.createElement("div");
  const listEl = document.createElement("div");
  wrap.appendChild(toolbarSlot);
  wrap.appendChild(listEl);

  async function loadData(p) {
    page = p;
    const offset = (page - 1) * pageSize;
    const search = listSearchQuery.trim();
    let apiPath = `/doctors/${sessionDoctorId}/conversations?limit=${pageSize}&offset=${offset}`;
    if (search) apiPath += `&search=${encodeURIComponent(search)}`;
    if (listStateFilter) {
      apiPath += `&tags=${encodeURIComponent(listStateFilter)}`;
    }
    if (listContactNone) {
      apiPath += `&contact_classifications=__none__`;
    } else if (listContactFilter.size > 0) {
      apiPath += `&contact_classifications=${encodeURIComponent(Array.from(listContactFilter).join(","))}`;
    }
    const hasFilters = !!(search || listStateFilter || listContactNone || listContactFilter.size);

    const res = await apiFetch(apiPath);
    if (res.status === 401) {
      sessionDoctorId = null;
      location.hash = "#/login";
      await render();
      return;
    }
    if (!res.ok) {
      listEl.innerHTML = `<div class="error" style="padding:1rem">No se pudo cargar la lista.</div>`;
      return;
    }

    const body = await res.json();
    const items = body.items || [];
    const total = body.total ?? 0;
    const totalPages = total > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;

    if (total > 0 && page > totalPages) {
      await loadData(totalPages);
      return;
    }

    // Rebuild toolbar
    toolbarSlot.innerHTML = "";
    const sticky = buildStickyToolbar({
      page,
      pageSize,
      total,
      onPageSizeChange: (ps) => { pageSize = ps; loadData(1); },
      onPrev: () => loadData(Math.max(1, page - 1)),
      onNext: () => loadData(Math.min(totalPages, page + 1)),
      navRowInner: `<span class="toolbar-spacer"></span>`,
    });
    toolbarSlot.appendChild(sticky);

    // Rebuild list items
    listEl.innerHTML = "";
    if (!items.length) {
      const msg = hasFilters ? "No hay conversaciones que coincidan." : "No hay conversaciones.";
      listEl.innerHTML = `<p class="meta">${escapeHtml(msg)}</p>`;
      return;
    }

    for (const c of items) {
      const tagHtml = c.classification_tag
        ? `<span class="conv-tag conv-tag-${convTagClass(c.classification_tag)}">${escapeHtml(c.classification_tag)}</span>`
        : "";

      const row = el(`
        <div class="conversation-row">
          <div class="conv-info">
            <div>${contactNamesHtml(c)}</div>
            <strong>${escapeHtml(c.phone_number)}</strong>
            <div class="meta">${escapeHtml(lastMessageText(c))}</div>
            ${tagHtml}
            <div class="contact-badges">${contactBadgesHtml(c.contact_classifications)}</div>
          </div>
          <div class="conv-actions">
            <button type="button" class="sm" data-chat="${c.id}">Ver conversación</button>
            <button type="button" class="secondary sm" data-classify="${c.id}">Clasificar</button>
            <button type="button" class="secondary sm" data-files="${c.id}">Archivos</button>
          </div>
        </div>
      `);
      // Clasificar/renombrar no cambia el orden (va por último mensaje): se recarga la misma página.
      row.querySelector(`[data-classify]`).addEventListener("click", () => {
        openClassifyModal(c, classifications, () => loadData(page));
      });
      row.querySelector(`[data-chat]`).addEventListener("click", () => {
        navTo("chat", { conversationId: c.id, page: 1, pageSize });
      });
      row.querySelector(`[data-files]`).addEventListener("click", () => {
        navTo("files", { conversationId: c.id, page: 1, pageSize });
      });
      listEl.appendChild(row);
    }
  }

  searchInp.addEventListener("input", () => {
    clearTimeout(listSearchDebounce);
    listSearchDebounce = setTimeout(() => {
      listSearchQuery = searchInp.value;
      loadData(1);
    }, 300);
  });

  await loadData(page);
}

// ── Base de conocimiento ────────────────────────────────────────────────────

function knowledgeTruncate(s, max) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max).trim() + "…" : s;
}

function knowledgeFormFieldsHtml(doc, categories) {
  const d = doc || {};
  const datalistOptions = (categories || [])
    .map((c) => `<option value="${escapeAttr(c)}"></option>`)
    .join("");
  return `
    <label for="kb-title">Título</label>
    <input id="kb-title" name="title" type="text" value="${escapeAttr(d.title || "")}" required />

    <label for="kb-category">Categoría</label>
    <input id="kb-category" name="category" type="text" list="kb-category-suggestions" value="${escapeAttr(d.category || "")}" required />
    <datalist id="kb-category-suggestions">${datalistOptions}</datalist>

    <label for="kb-prompt">Pregunta de ejemplo (opcional)</label>
    <p class="meta">Una pregunta que un paciente podría hacer sobre este tema.</p>
    <textarea id="kb-prompt" name="prompt" rows="2">${escapeHtml(d.prompt || "")}</textarea>

    <label for="kb-content">Contenido</label>
    <textarea id="kb-content" name="content" rows="6" required>${escapeHtml(d.content || "")}</textarea>
  `;
}

function readKnowledgeFormValues(formEl) {
  const fd = new FormData(formEl);
  const value = (k) => {
    const v = (fd.get(k) || "").toString().trim();
    return v === "" ? null : v;
  };
  return {
    title: (fd.get("title") || "").toString().trim(),
    category: (fd.get("category") || "").toString().trim(),
    prompt: value("prompt"),
    content: (fd.get("content") || "").toString().trim(),
  };
}

function knowledgeRowHtml(doc) {
  return `
    <tr data-kb-id="${doc.id}">
      <td>${escapeHtml(doc.title)}</td>
      <td>${escapeHtml(doc.category)}</td>
      <td class="cell-preview">${escapeHtml(knowledgeTruncate(doc.content, 80))}</td>
      <td class="table-actions">
        <button type="button" class="btn sm secondary kb-edit-btn">Editar</button>
        <button type="button" class="btn sm secondary kb-toggle-btn">${doc.is_active ? "Eliminar" : "Restaurar"}</button>
      </td>
    </tr>
  `;
}

async function renderKnowledge(container, route) {
  container.innerHTML = "";
  container.classList.remove("chat-mode");

  const wrap = el(`
    <div class="card">
      <h1>Base de conocimiento</h1>
      <p class="meta">
        Esta información es la que usa el asistente virtual para responder automáticamente a tus
        pacientes. Consejos: escribe una idea por entrada, usa lenguaje simple y claro, y mantén
        cada entrada breve. Los cambios quedan listos para usarse poco después de guardarlos.
      </p>
      <div class="card-header-row">
        <button type="button" id="kb-add-btn">Agregar</button>
      </div>
      <div class="toolbar">
        <input type="text" id="kb-search" class="search-input" placeholder="Buscar por título o contenido…" autocomplete="off" />
        <select id="kb-category-filter">
          <option value="">Todas las categorías</option>
        </select>
        <label class="kb-toggle-deleted">
          <input type="checkbox" id="kb-show-deleted" />
          Mostrar eliminados
        </label>
      </div>
      <div id="kb-table-wrap"></div>
    </div>
  `);
  container.appendChild(wrap);

  const tableWrap = wrap.querySelector("#kb-table-wrap");
  tableWrap.innerHTML = `<p class="meta">Cargando…</p>`;

  let docs = [];

  async function loadDocs() {
    const res = await apiFetch(`/doctors/${sessionDoctorId}/rag?include_inactive=true&limit=100`);
    if (res.status === 401) {
      sessionDoctorId = null;
      location.hash = "#/login";
      await render();
      return false;
    }
    if (!res.ok) {
      tableWrap.innerHTML = `<div class="error">No se pudo cargar la lista.</div>`;
      return false;
    }
    docs = await res.json();
    return true;
  }

  function categoriesFrom(list) {
    return [...new Set(list.map((d) => d.category))].sort();
  }

  function openKnowledgeFormModal({ heading, doc }) {
    const body = el(`
      <form class="kb-form">
        <div class="kb-form-error error" style="display:none"></div>
        ${knowledgeFormFieldsHtml(doc, categoriesFrom(docs))}
        <div class="form-actions">
          <button type="submit">Guardar</button>
          <button type="button" class="btn sm secondary kb-cancel-btn">Cancelar</button>
        </div>
      </form>
    `);
    const { close } = openModal({ title: heading, bodyEl: body });
    body.querySelector(".kb-cancel-btn").addEventListener("click", close);
    body.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const errorEl = body.querySelector(".kb-form-error");
      errorEl.style.display = "none";
      const payload = readKnowledgeFormValues(ev.target);
      if (!payload.title || !payload.category || !payload.content) {
        errorEl.textContent = "Título, categoría y contenido son obligatorios.";
        errorEl.style.display = "block";
        return;
      }
      const res = doc
        ? await apiFetch(`/doctors/${sessionDoctorId}/rag/${doc.id}`, {
            method: "PUT",
            body: JSON.stringify(payload),
          })
        : await apiFetch(`/doctors/${sessionDoctorId}/rag`, {
            method: "POST",
            body: JSON.stringify(payload),
          });
      if (res.ok) {
        close();
        await refresh();
      } else {
        errorEl.textContent = "No se pudo guardar. Intenta nuevamente.";
        errorEl.style.display = "block";
      }
    });
  }

  async function toggleActive(doc) {
    const activating = !doc.is_active;
    const confirmMsg = activating
      ? `¿Restaurar "${doc.title}"? Volverá a usarse para responder a tus pacientes.`
      : `¿Eliminar "${doc.title}"? Dejará de usarse para responder a tus pacientes.`;
    if (!window.confirm(confirmMsg)) return;
    const res = activating
      ? await apiFetch(`/doctors/${sessionDoctorId}/rag/${doc.id}`, {
          method: "PUT",
          body: JSON.stringify({ is_active: true }),
        })
      : await apiFetch(`/doctors/${sessionDoctorId}/rag/${doc.id}`, { method: "DELETE" });
    if (res.ok) {
      await refresh();
    } else {
      window.alert("No se pudo actualizar el estado de la entrada.");
    }
  }

  function applyFiltersAndRender() {
    const search = wrap.querySelector("#kb-search").value.trim().toLowerCase();
    const category = wrap.querySelector("#kb-category-filter").value;
    const showDeleted = wrap.querySelector("#kb-show-deleted").checked;

    let filtered = showDeleted ? docs : docs.filter((d) => d.is_active);
    if (category) filtered = filtered.filter((d) => d.category === category);
    if (search) {
      filtered = filtered.filter((d) =>
        [d.title, d.content, d.prompt].filter(Boolean).some((v) => v.toLowerCase().includes(search))
      );
    }

    if (!filtered.length) {
      tableWrap.innerHTML = `<p class="meta">No hay entradas que coincidan.</p>`;
      return;
    }

    const table = el(`
      <table>
        <thead>
          <tr><th>Título</th><th>Categoría</th><th>Contenido</th><th></th></tr>
        </thead>
        <tbody>${filtered.map(knowledgeRowHtml).join("")}</tbody>
      </table>
    `);
    tableWrap.innerHTML = "";
    const scroller = document.createElement("div");
    scroller.className = "table-scroll";
    scroller.appendChild(table);
    tableWrap.appendChild(scroller);

    tableWrap.querySelectorAll("tr[data-kb-id]").forEach((tr) => {
      const docId = parseInt(tr.dataset.kbId, 10);
      const doc = docs.find((d) => d.id === docId);
      tr.querySelector(".kb-edit-btn").addEventListener("click", () => {
        openKnowledgeFormModal({ heading: "Editar entrada", doc });
      });
      tr.querySelector(".kb-toggle-btn").addEventListener("click", () => toggleActive(doc));
    });
  }

  function refreshCategoryOptions() {
    const sel = wrap.querySelector("#kb-category-filter");
    const current = sel.value;
    sel.innerHTML = `<option value="">Todas las categorías</option>`;
    categoriesFrom(docs).forEach((c) => {
      sel.appendChild(el(`<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`));
    });
    sel.value = current;
  }

  async function refresh() {
    const ok = await loadDocs();
    if (!ok) return;
    refreshCategoryOptions();
    applyFiltersAndRender();
  }

  wrap.querySelector("#kb-add-btn").addEventListener("click", () => {
    openKnowledgeFormModal({ heading: "Agregar entrada", doc: null });
  });
  wrap.querySelector("#kb-search").addEventListener("input", applyFiltersAndRender);
  wrap.querySelector("#kb-category-filter").addEventListener("change", applyFiltersAndRender);
  wrap.querySelector("#kb-show-deleted").addEventListener("change", applyFiltersAndRender);

  await refresh();
}

// ── Clasificaciones de contacto (configuración) ─────────────────────────────

function classificationRowHtml(cc) {
  return `
    <tr data-cc-id="${cc.id}">
      <td>${contactBadgeHtml(cc)}</td>
      <td class="cell-preview">${escapeHtml(cc.description || "")}</td>
      <td>${cc.conversation_count}</td>
      <td class="table-actions">
        <button type="button" class="btn sm secondary cc-edit-btn">Editar</button>
        <button type="button" class="btn sm secondary cc-delete-btn">Eliminar</button>
      </td>
    </tr>
  `;
}

async function renderClassifications(container) {
  container.innerHTML = "";
  container.classList.remove("chat-mode");

  const wrap = el(`
    <div class="card">
      <h1>Clasificaciones</h1>
      <p class="meta">
        Clasificaciones propias para tus contactos (por ejemplo "Balón", "Bypass" o "Post Operatorio").
        Un contacto puede tener varias; se asignan con el botón "Clasificar" del listado de
        conversaciones o desde el chat.
      </p>
      <div class="card-header-row">
        <button type="button" id="cc-add-btn">Agregar</button>
      </div>
      <div id="cc-table-wrap"><p class="meta">Cargando…</p></div>
    </div>
  `);
  container.appendChild(wrap);
  const tableWrap = wrap.querySelector("#cc-table-wrap");

  let items = [];

  function swatchHtml(hex, title) {
    const c = safeHexColor(hex);
    return `<button type="button" class="color-swatch" data-color="${c}" title="${escapeAttr(title)}"
      aria-label="${escapeAttr(title)}" style="background:${c}"></button>`;
  }

  function openFormModal(cc) {
    const presetHexes = new Set(CONTACT_PRESET_COLORS.map((p) => p.hex));
    // Colores propios ya usados en sus otras clasificaciones (que no sean predefinidos).
    const ownColors = [
      ...new Set(
        items
          .filter((x) => !cc || x.id !== cc.id)
          .map((x) => safeHexColor(x.color))
          .filter((hex) => !presetHexes.has(hex))
      ),
    ];
    let color = safeHexColor(cc ? cc.color : CONTACT_PRESET_COLORS[0].hex);

    const body = el(`
      <form class="cc-form">
        <div class="cc-form-error error" style="display:none"></div>

        <label for="cc-name">Nombre</label>
        <input id="cc-name" type="text" maxlength="${CONTACT_NAME_MAX}" required autocomplete="off"
          value="${escapeAttr(cc ? cc.name : "")}" />
        <div class="char-counter meta" id="cc-name-counter"></div>

        <label for="cc-description">Descripción (opcional)</label>
        <textarea id="cc-description" rows="3" maxlength="${CONTACT_DESCRIPTION_MAX}">${escapeHtml(
          cc ? cc.description || "" : ""
        )}</textarea>
        <div class="char-counter meta" id="cc-description-counter"></div>

        <label>Color</label>
        <div class="color-swatches">
          ${CONTACT_PRESET_COLORS.map((p) => swatchHtml(p.hex, p.name)).join("")}
        </div>
        ${
          ownColors.length
            ? `<p class="meta color-swatches-title">Tus colores</p>
               <div class="color-swatches">${ownColors.map((hex) => swatchHtml(hex, hex)).join("")}</div>`
            : ""
        }
        <label class="color-custom">
          <span>Otro color</span>
          <input type="color" id="cc-color-custom" value="${color}" />
        </label>

        <p class="meta">Vista previa: <span id="cc-preview"></span></p>

        <div class="form-actions">
          <button type="submit">Guardar</button>
          <button type="button" class="btn sm secondary cc-cancel-btn">Cancelar</button>
        </div>
      </form>
    `);
    const { close } = openModal({
      title: cc ? "Editar clasificación" : "Agregar clasificación",
      bodyEl: body,
    });

    const nameInp = body.querySelector("#cc-name");
    const descInp = body.querySelector("#cc-description");
    const customInp = body.querySelector("#cc-color-custom");
    const errorEl = body.querySelector(".cc-form-error");

    function refreshForm() {
      body.querySelector("#cc-name-counter").textContent = `${nameInp.value.length} / ${CONTACT_NAME_MAX}`;
      body.querySelector("#cc-description-counter").textContent =
        `${descInp.value.length} / ${CONTACT_DESCRIPTION_MAX}`;
      body.querySelectorAll(".color-swatch").forEach((s) => {
        s.classList.toggle("selected", s.dataset.color === color);
      });
      body.querySelector("#cc-preview").innerHTML = contactBadgeHtml({
        name: nameInp.value.trim() || "Ejemplo",
        color,
      });
    }

    body.querySelectorAll(".color-swatch").forEach((s) => {
      s.addEventListener("click", () => {
        color = safeHexColor(s.dataset.color);
        customInp.value = color;
        refreshForm();
      });
    });
    customInp.addEventListener("input", () => {
      color = safeHexColor(customInp.value);
      refreshForm();
    });
    nameInp.addEventListener("input", refreshForm);
    descInp.addEventListener("input", refreshForm);
    body.querySelector(".cc-cancel-btn").addEventListener("click", close);
    refreshForm();

    body.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      errorEl.style.display = "none";
      const payload = {
        name: nameInp.value.trim(),
        description: descInp.value.trim() || null,
        color,
      };
      if (!payload.name) {
        errorEl.textContent = "El nombre es obligatorio.";
        errorEl.style.display = "block";
        return;
      }
      const res = cc
        ? await apiFetch(`/doctors/${sessionDoctorId}/contact-classifications/${cc.id}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          })
        : await apiFetch(`/doctors/${sessionDoctorId}/contact-classifications`, {
            method: "POST",
            body: JSON.stringify(payload),
          });
      if (res.ok) {
        close();
        await refresh();
        return;
      }
      errorEl.textContent = await apiErrorDetail(res, "No se pudo guardar. Intenta nuevamente.");
      errorEl.style.display = "block";
    });
  }

  async function deleteClassification(cc) {
    const n = cc.conversation_count;
    const affected =
      n === 0
        ? "Ninguna conversación la tiene asignada."
        : n === 1
        ? "1 conversación perderá esta clasificación (si no tiene otra, quedará como \"Sin clasificar contacto\")."
        : `${n} conversaciones perderán esta clasificación (las que no tengan otra quedarán como "Sin clasificar contacto").`;
    if (!window.confirm(`¿Eliminar la clasificación "${cc.name}"?\n\n${affected}`)) return;
    const res = await apiFetch(`/doctors/${sessionDoctorId}/contact-classifications/${cc.id}`, {
      method: "DELETE",
    });
    if (res.ok) {
      await refresh();
    } else {
      window.alert("No se pudo eliminar la clasificación.");
    }
  }

  function renderTable() {
    if (!items.length) {
      tableWrap.innerHTML = `<p class="meta">Aún no hay clasificaciones. Usa "Agregar" para crear la primera.</p>`;
      return;
    }
    const table = el(`
      <table>
        <thead>
          <tr><th>Clasificación</th><th>Descripción</th><th>Conversaciones</th><th></th></tr>
        </thead>
        <tbody>${items.map(classificationRowHtml).join("")}</tbody>
      </table>
    `);
    tableWrap.innerHTML = "";
    const scroller = document.createElement("div");
    scroller.className = "table-scroll";
    scroller.appendChild(table);
    tableWrap.appendChild(scroller);

    tableWrap.querySelectorAll("tr[data-cc-id]").forEach((tr) => {
      const cc = items.find((x) => x.id === parseInt(tr.dataset.ccId, 10));
      tr.querySelector(".cc-edit-btn").addEventListener("click", () => openFormModal(cc));
      tr.querySelector(".cc-delete-btn").addEventListener("click", () => deleteClassification(cc));
    });
  }

  async function refresh() {
    const list = await fetchContactClassifications();
    if (sessionDoctorId == null) return;
    if (list == null) {
      tableWrap.innerHTML = `<div class="error">No se pudo cargar la lista.</div>`;
      return;
    }
    items = list;
    renderTable();
  }

  wrap.querySelector("#cc-add-btn").addEventListener("click", () => openFormModal(null));

  await refresh();
}

// ── Envío masivo y catchup (helpers compartidos) ────────────────────────────

const CHILE_TZ = "America/Santiago";
// WhatsApp: texto solo hasta 1600 caracteres (un mensaje); pie de imagen hasta 1024.
const OUTBOUND_TEXT_MAX = 1600;
const OUTBOUND_CAPTION_MAX = 1024;
const OUTBOUND_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const OUTBOUND_IMAGE_TYPES = ["image/jpeg", "image/png"];
const CONVERSATION_STATES = [
  "Preguntas frecuentes",
  "Agendamiento",
  "Requiere asistente humano",
  "Conversacion finalizada",
  "Mal uso del bot",
];

/** Si la sesión expiró, vuelve al login. Devuelve true si redirigió. */
async function handleUnauthorized(res) {
  if (res.status !== 401) return false;
  sessionDoctorId = null;
  location.hash = "#/login";
  await render();
  return true;
}

function formatChile(iso, opts = {}) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("es-CL", {
      timeZone: CHILE_TZ,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      ...opts,
    });
  } catch {
    return iso;
  }
}

/** Valor para <input type="datetime-local"> en hora de Chile ("YYYY-MM-DDTHH:MM"). */
function chileLocalInputValue(iso) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-CA", {
    timeZone: CHILE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso))) {
    parts[p.type] = p.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Valida la imagen elegida; devuelve un mensaje de error o "" si está bien. */
function outboundImageError(file) {
  if (!file) return "";
  if (!OUTBOUND_IMAGE_TYPES.includes(file.type)) return "La imagen debe ser JPG o PNG.";
  if (file.size > OUTBOUND_IMAGE_MAX_BYTES) return "La imagen no puede superar 5 MB.";
  return "";
}

/** Contador "n / máx" que se pone rojo al pasarse. */
function updateOutboundCounter(counterEl, text, hasImage) {
  const max = hasImage ? OUTBOUND_CAPTION_MAX : OUTBOUND_TEXT_MAX;
  const n = text.length;
  counterEl.textContent =
    `${n} / ${max} caracteres` + (hasImage ? " (con imagen, WhatsApp admite hasta 1024)" : "");
  counterEl.classList.toggle("over-limit", n > max);
  return n <= max;
}

/** Bloque de explicaciones para usuarios no técnicos (abierto por defecto). */
function whatsappRulesHtml({ title, items }) {
  return `
    <details class="prompt-help" open>
      <summary>${escapeHtml(title)}</summary>
      <div class="prompt-help-body">
        ${items
          .map(([h, p]) => `<h3>${escapeHtml(h)}</h3><p>${escapeHtml(p)}</p>`)
          .join("")}
      </div>
    </details>
  `;
}

const RULE_WINDOW = [
  "La ventana de 24 horas de WhatsApp",
  "WhatsApp solo permite escribirle a un paciente si él te escribió en las últimas 24 horas. " +
    "Cada vez que el paciente escribe, la ventana se abre de nuevo por 24 horas. Nuestros mensajes NO la extienden: " +
    "solo un mensaje del paciente la reinicia.",
];
const RULE_COST = [
  "Costo",
  "Desde el 1 de octubre de 2026, WhatsApp (Meta) regala 1.000 mensajes al mes por número. " +
    "Después de eso, cada mensaje enviado dentro de la ventana tiene costo. El contador de abajo te ayuda a seguirlo.",
];
const RULE_BLOCKS = [
  "Riesgo de bloqueos",
  "Si muchos pacientes bloquean o reportan tu número, WhatsApp baja su calidad y puede limitar tus envíos. " +
    "WhatsApp no avisa cuando un paciente te bloquea. Envía solo mensajes útiles y a quienes esperan recibirlos.",
];

function messageStatsHtml(stats) {
  const by = stats.by_source || {};
  const row = (label, n) =>
    `<div class="dashboard-tag-row"><span>${escapeHtml(label)}</span><span class="dashboard-tag-count">${n ?? 0}</span></div>`;
  return `
    <div class="stats-total"><strong>${stats.total}</strong> mensajes enviados en ${escapeHtml(stats.month)}</div>
    <div class="stats-grid">
      <div>
        ${row("Bot", by.bot)}
        ${row("Humano", by.human)}
        ${row("Mensaje masivo", by.bulk)}
        ${row("Catchup", by.catchup)}
      </div>
      <div>
        ${row("Automáticos (Bot, Mensaje masivo, Catchup)", stats.automatic)}
        ${row("Manuales (Humano)", stats.manual)}
      </div>
    </div>
    <p class="meta">
      Es un número aproximado: Meta cobra solo los mensajes que llegan al paciente, y una respuesta
      larga del bot puede salir en varias partes aunque aquí cuente como una. Mes en hora de Chile.
    </p>
  `;
}

const BULK_STATUS_LABELS = {
  scheduled: "Programado",
  sending: "Enviando",
  done: "Enviado",
  cancelled: "Cancelado",
};

// ── Envío masivo ────────────────────────────────────────────────────────────

async function renderBulkSend(container) {
  container.innerHTML = "";
  container.classList.remove("chat-mode");

  const wrap = el(`
    <div>
      <div class="card">
        <h1>Envío masivo</h1>
        <p class="meta">Envía un mismo mensaje (texto y, si quieres, una imagen) a muchos contactos a la vez.</p>
        ${whatsappRulesHtml({
          title: "Antes de enviar: lee esto",
          items: [
            RULE_WINDOW,
            [
              "¿Quiénes quedan fuera?",
              "Los contactos que no te han escrito en las últimas 24 horas (menos el margen de seguridad) no " +
                "reciben el mensaje. La vista previa te muestra cuántos son. En un envío programado, la ventana " +
                "se revisa al momento de enviar, no al programarlo.",
            ],
            [
              "\"Enviado\" no es \"entregado\"",
              "\"Enviado\" significa que WhatsApp recibió el mensaje para entregarlo. No sabemos si llegó al " +
                "teléfono ni si el paciente lo leyó.",
            ],
            RULE_COST,
            RULE_BLOCKS,
            [
              "Si eliges que el bot NO responda",
              "El bot se apaga en cada conversación a la que llegue el mensaje, y queda apagado hasta que tú lo " +
                "vuelvas a encender desde el chat. Tendrás que responder tú a quienes contesten.",
            ],
          ],
        })}
      </div>

      <div class="card">
        <h2>Mensajes enviados este mes</h2>
        <div id="bulk-stats"><p class="meta">Cargando…</p></div>
      </div>

      <div class="card">
        <h2>Margen de seguridad</h2>
        <p class="meta">
          Dejamos de enviar unos minutos antes de que cierre la ventana de 24 horas, para que un mensaje en
          cola no llegue tarde y WhatsApp lo rechace. Se aplica a todos los envíos masivos.
        </p>
        <div class="inline-form">
          <input type="number" id="bulk-margin" min="1" max="60" step="1" />
          <span class="meta">minutos (de 1 a 60)</span>
          <button type="button" class="sm" id="bulk-margin-save">Guardar</button>
        </div>
        <div id="bulk-margin-msg" class="meta"></div>
      </div>

      <div class="card" id="bulk-form-card"></div>

      <div class="card">
        <h2>Historial</h2>
        <div id="bulk-history"><p class="meta">Cargando…</p></div>
      </div>
    </div>
  `);
  container.appendChild(wrap);

  const classifications = (await fetchContactClassifications()) || [];
  if (sessionDoctorId == null) return;

  // ── Contador del mes ──
  apiFetch(`/doctors/${sessionDoctorId}/message-stats`).then(async (res) => {
    const target = wrap.querySelector("#bulk-stats");
    if (!res.ok) {
      target.innerHTML = `<div class="error">No se pudo cargar el contador.</div>`;
      return;
    }
    target.innerHTML = messageStatsHtml(await res.json());
  });

  // ── Margen ──
  const marginInp = wrap.querySelector("#bulk-margin");
  const marginMsg = wrap.querySelector("#bulk-margin-msg");
  let marginMinutes = 10;
  {
    const res = await apiFetch(`/doctors/${sessionDoctorId}/bulk-send-settings`);
    if (await handleUnauthorized(res)) return;
    if (res.ok) marginMinutes = (await res.json()).window_margin_minutes;
    marginInp.value = String(marginMinutes);
  }
  wrap.querySelector("#bulk-margin-save").addEventListener("click", async () => {
    const value = parseInt(marginInp.value, 10);
    if (!Number.isFinite(value) || value < 1 || value > 60) {
      marginMsg.className = "error";
      marginMsg.textContent = "El margen debe estar entre 1 y 60 minutos.";
      return;
    }
    const res = await apiFetch(`/doctors/${sessionDoctorId}/bulk-send-settings`, {
      method: "PUT",
      body: JSON.stringify({ window_margin_minutes: value }),
    });
    if (!res.ok) {
      marginMsg.className = "error";
      marginMsg.textContent = await apiErrorDetail(res, "No se pudo guardar el margen.");
      return;
    }
    marginMinutes = value;
    marginMsg.className = "success";
    marginMsg.textContent = "Margen guardado.";
    refreshPreview();
  });

  // ── Formulario ──
  const formCard = wrap.querySelector("#bulk-form-card");
  // Estado del formulario: filtros, agregados a mano, desmarcados, imagen y envío en edición.
  let state;

  function resetState(editing = null) {
    state = {
      editing, // envío programado que se está editando (detalle de la API) o null
      tags: new Set(),
      ccIds: new Set(),
      ccNone: false,
      manualIds: new Set(editing ? editing.conversation_ids : []),
      excludedIds: new Set(),
      items: [],
      preview: null,
      imageFile: null,
      removeImage: false,
    };
  }

  function hasImage() {
    return !!state.imageFile || (!!state.editing && state.editing.has_image && !state.removeImage);
  }

  function renderForm() {
    const editing = state.editing;
    const stateOptions = [["__none__", "Sin estado"], ...CONVERSATION_STATES.map((s) => [s, s])];
    formCard.innerHTML = `
      <h2>${editing ? `Editar envío programado #${editing.id}` : "Nuevo envío"}</h2>
      ${editing ? `<p class="meta">Estás editando un envío programado. Puedes cambiar todo: texto, imagen, fecha, contactos y si el bot responde.
        <button type="button" class="secondary sm" id="bulk-edit-cancel">Salir sin guardar</button></p>` : ""}

      <h3 class="form-section-title">1. Destinatarios</h3>
      <p class="meta">Filtra por estado y/o clasificación (como en el listado de conversaciones), agrega contactos a mano
        y desmarca los que no quieras.</p>
      <div class="bulk-filters">
        <div>
          <span class="filter-field-label">Estado conversación (cualquiera de los marcados)</span>
          <div class="check-list" id="bulk-tags">
            ${stateOptions
              .map(
                ([v, label]) => `<label class="check-option"><input type="checkbox" value="${escapeAttr(v)}" ${
                  state.tags.has(v) ? "checked" : ""
                } /> ${escapeHtml(label)}</label>`
              )
              .join("")}
          </div>
        </div>
        <div>
          <span class="filter-field-label">Clasificación contacto (debe tener todas las marcadas)</span>
          <div class="check-list" id="bulk-ccs">
            <label class="check-option"><input type="checkbox" data-cc-none="1" ${state.ccNone ? "checked" : ""} />
              <span class="contact-badge contact-badge-none">Sin clasificar contacto</span></label>
            ${classifications
              .map(
                (cc) => `<label class="check-option"><input type="checkbox" data-cc-id="${cc.id}" ${
                  state.ccIds.has(cc.id) ? "checked" : ""
                } /> ${contactBadgeHtml(cc)}</label>`
              )
              .join("")}
          </div>
        </div>
      </div>
      <div class="bulk-manual">
        <span class="filter-field-label">Agregar contactos a mano</span>
        <input type="text" id="bulk-search" class="search-input" placeholder="Buscar por nombre o número…" autocomplete="off" />
        <div id="bulk-search-results"></div>
      </div>
      <div id="bulk-recipients"><p class="meta">Elige un filtro o agrega contactos para ver la lista.</p></div>

      <h3 class="form-section-title">2. Mensaje</h3>
      <textarea id="bulk-message" rows="5" placeholder="Escribe el mensaje…">${escapeHtml(editing ? editing.message : "")}</textarea>
      <div class="char-counter meta" id="bulk-counter"></div>
      <label>Imagen (opcional, JPG o PNG, hasta 5 MB)</label>
      <div id="bulk-image-current"></div>
      <input type="file" id="bulk-image" accept="image/jpeg,image/png" />
      <div id="bulk-image-error" class="error" style="display:none"></div>

      <h3 class="form-section-title">3. Cuándo</h3>
      <label class="check-option"><input type="radio" name="bulk-when" value="now" ${
        editing && !editing.is_immediate ? "" : "checked"
      } /> Enviar ahora (sale en menos de un minuto)</label>
      <label class="check-option"><input type="radio" name="bulk-when" value="later" ${
        editing && !editing.is_immediate ? "checked" : ""
      } /> Programar</label>
      <div class="inline-form" id="bulk-when-row">
        <input type="datetime-local" id="bulk-when-at" value="${
          editing && !editing.is_immediate ? escapeAttr(chileLocalInputValue(editing.scheduled_at)) : ""
        }" />
        <span class="meta">hora de Chile</span>
      </div>

      <h3 class="form-section-title">4. Si el paciente responde</h3>
      <label class="check-option"><input type="radio" name="bulk-bot" value="on" ${
        editing && editing.disable_bot ? "" : "checked"
      } /> El bot responde como siempre</label>
      <label class="check-option"><input type="radio" name="bulk-bot" value="off" ${
        editing && editing.disable_bot ? "checked" : ""
      } /> El bot NO responde: se apaga en esas conversaciones y respondo yo</label>

      <div id="bulk-form-error" class="error" style="display:none"></div>
      <div class="form-actions">
        <button type="button" id="bulk-review">Revisar y ${editing ? "guardar" : "enviar"}</button>
      </div>
    `;

    const msgInp = formCard.querySelector("#bulk-message");
    const counter = formCard.querySelector("#bulk-counter");
    const imageInp = formCard.querySelector("#bulk-image");
    const imageErr = formCard.querySelector("#bulk-image-error");
    const whenRow = formCard.querySelector("#bulk-when-row");

    function refreshCounter() {
      updateOutboundCounter(counter, msgInp.value.trim(), hasImage());
    }
    function refreshWhen() {
      const later = formCard.querySelector('input[name="bulk-when"]:checked').value === "later";
      whenRow.style.display = later ? "" : "none";
    }
    function renderCurrentImage() {
      const box = formCard.querySelector("#bulk-image-current");
      if (editing && editing.has_image && !state.removeImage && !state.imageFile) {
        box.innerHTML = `<div class="image-preview"><img src="${escapeAttr(resolveApiUrl(editing.image_url))}" alt="Imagen del envío" />
          <button type="button" class="secondary sm" id="bulk-image-remove">Quitar imagen</button></div>`;
        box.querySelector("#bulk-image-remove").addEventListener("click", () => {
          state.removeImage = true;
          renderCurrentImage();
          refreshCounter();
        });
      } else if (state.imageFile) {
        const url = URL.createObjectURL(state.imageFile);
        box.innerHTML = `<div class="image-preview"><img src="${escapeAttr(url)}" alt="Imagen elegida" />
          <button type="button" class="secondary sm" id="bulk-image-clear">Quitar imagen</button></div>`;
        box.querySelector("#bulk-image-clear").addEventListener("click", () => {
          state.imageFile = null;
          imageInp.value = "";
          renderCurrentImage();
          refreshCounter();
        });
      } else {
        box.innerHTML = "";
      }
    }

    msgInp.addEventListener("input", refreshCounter);
    imageInp.addEventListener("change", () => {
      const file = imageInp.files && imageInp.files[0];
      const err = outboundImageError(file);
      imageErr.textContent = err;
      imageErr.style.display = err ? "block" : "none";
      state.imageFile = err ? null : file || null;
      if (err) imageInp.value = "";
      renderCurrentImage();
      refreshCounter();
    });
    formCard.querySelectorAll('input[name="bulk-when"]').forEach((r) => r.addEventListener("change", refreshWhen));

    formCard.querySelector("#bulk-tags").addEventListener("change", (ev) => {
      const input = ev.target;
      if (input.checked) state.tags.add(input.value);
      else state.tags.delete(input.value);
      refreshPreview();
    });
    formCard.querySelector("#bulk-ccs").addEventListener("change", (ev) => {
      const input = ev.target;
      if (input.dataset.ccNone) {
        state.ccNone = input.checked;
        if (state.ccNone) state.ccIds.clear();
      } else {
        const id = parseInt(input.dataset.ccId, 10);
        if (input.checked) {
          state.ccIds.add(id);
          state.ccNone = false;
        } else {
          state.ccIds.delete(id);
        }
      }
      formCard.querySelectorAll("#bulk-ccs input").forEach((i) => {
        i.checked = i.dataset.ccNone ? state.ccNone : state.ccIds.has(parseInt(i.dataset.ccId, 10));
      });
      refreshPreview();
    });

    // Búsqueda para agregar a mano (usa el listado de conversaciones).
    const searchInp = formCard.querySelector("#bulk-search");
    const searchResults = formCard.querySelector("#bulk-search-results");
    let searchTimer = null;
    searchInp.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        const q = searchInp.value.trim();
        if (!q) {
          searchResults.innerHTML = "";
          return;
        }
        const res = await apiFetch(
          `/doctors/${sessionDoctorId}/conversations?limit=10&offset=0&search=${encodeURIComponent(q)}`
        );
        if (!res.ok) return;
        const items = (await res.json()).items || [];
        searchResults.innerHTML = items.length
          ? items
              .map(
                (c) => `<div class="search-result-row">
                  <span>${contactNamesHtml(c)} <strong>${escapeHtml(c.phone_number)}</strong></span>
                  <button type="button" class="secondary sm" data-add="${c.id}" ${
                    state.manualIds.has(c.id) ? "disabled" : ""
                  }>${state.manualIds.has(c.id) ? "Agregado" : "Agregar"}</button>
                </div>`
              )
              .join("")
          : `<p class="meta">Sin resultados.</p>`;
      }, 300);
    });
    searchResults.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-add]");
      if (!btn) return;
      const id = parseInt(btn.dataset.add, 10);
      state.manualIds.add(id);
      state.excludedIds.delete(id);
      btn.disabled = true;
      btn.textContent = "Agregado";
      refreshPreview();
    });

    const cancelEdit = formCard.querySelector("#bulk-edit-cancel");
    if (cancelEdit) {
      cancelEdit.addEventListener("click", () => {
        resetState();
        renderForm();
      });
    }

    formCard.querySelector("#bulk-review").addEventListener("click", openReview);

    renderCurrentImage();
    refreshCounter();
    refreshWhen();
    refreshPreview();
  }

  // Varios clics seguidos en los filtros se agrupan en una sola consulta (el portal
  // tiene un límite de consultas por minuto).
  let previewSeq = 0;
  let previewTimer = null;
  function refreshPreview() {
    clearTimeout(previewTimer);
    const box = formCard.querySelector("#bulk-recipients");
    if (box && (state.tags.size || state.ccIds.size || state.ccNone || state.manualIds.size)) {
      box.innerHTML = `<p class="meta">Cargando contactos…</p>`;
    }
    previewTimer = setTimeout(loadPreview, 500);
  }

  async function loadPreview() {
    const box = formCard.querySelector("#bulk-recipients");
    if (!box) return;
    const anyFilter = state.tags.size || state.ccIds.size || state.ccNone;
    if (!anyFilter && !state.manualIds.size) {
      state.items = [];
      state.preview = null;
      box.innerHTML = `<p class="meta">Elige un filtro o agrega contactos para ver la lista.</p>`;
      return;
    }
    const seq = ++previewSeq;
    box.innerHTML = `<p class="meta">Cargando contactos…</p>`;
    const res = await apiFetch(`/doctors/${sessionDoctorId}/bulk-sends/preview`, {
      method: "POST",
      body: JSON.stringify({
        tags: Array.from(state.tags),
        contact_classification_ids: Array.from(state.ccIds),
        contact_none: state.ccNone,
        conversation_ids: Array.from(state.manualIds),
        excluded_ids: Array.from(state.excludedIds),
      }),
    });
    if (seq !== previewSeq) return; // llegó una respuesta más nueva
    if (await handleUnauthorized(res)) return;
    if (!res.ok) {
      const fallback =
        res.status === 429
          ? "Demasiadas consultas seguidas. Espera un minuto y vuelve a intentar."
          : "No se pudo cargar la lista.";
      box.innerHTML = `<div class="error">${escapeHtml(await apiErrorDetail(res, fallback))}</div>`;
      return;
    }
    state.preview = await res.json();
    state.items = state.preview.items;
    renderRecipients();
  }

  function selectedItems() {
    return state.items.filter((i) => !state.excludedIds.has(i.id));
  }

  function renderRecipients() {
    const box = formCard.querySelector("#bulk-recipients");
    const items = state.items;
    if (!items.length) {
      box.innerHTML = `<p class="meta">Ningún contacto cumple los filtros.</p>`;
      return;
    }
    const selected = selectedItems();
    const open = selected.filter((i) => i.window_open).length;
    const rows = items
      .map((i) => {
        const name = i.doctor_contact_name || i.contact_name || "";
        const windowHtml = i.window_open
          ? `<span class="window-open">Abierta hasta ${escapeHtml(formatChile(i.window_closes_at))}</span>`
          : `<span class="window-closed">Cerrada${
              i.last_user_message_at ? "" : " (nunca ha escrito)"
            }</span>`;
        return `<tr>
          <td><input type="checkbox" data-rcpt="${i.id}" ${state.excludedIds.has(i.id) ? "" : "checked"} /></td>
          <td>${escapeHtml(name)}</td>
          <td>${escapeHtml(i.phone_number)}</td>
          <td>${i.classification_tag ? `<span class="conv-tag conv-tag-${convTagClass(i.classification_tag)}">${escapeHtml(i.classification_tag)}</span>` : `<span class="meta">Sin estado</span>`}</td>
          <td>${windowHtml}</td>
        </tr>`;
      })
      .join("");
    box.innerHTML = `
      <p class="bulk-summary">
        <strong>${selected.length}</strong> marcados ·
        <span class="window-open"><strong>${open}</strong> con la ventana abierta</span> ·
        <span class="window-closed"><strong>${selected.length - open}</strong> quedarían fuera (ventana cerrada)</span>
      </p>
      <div class="form-actions">
        <button type="button" class="secondary sm" id="bulk-check-all">Marcar todos</button>
        <button type="button" class="secondary sm" id="bulk-uncheck-all">Desmarcar todos</button>
      </div>
      <div class="table-scroll bulk-recipient-table">
        <table>
          <thead><tr><th></th><th>Nombre</th><th>Número</th><th>Estado</th><th>Ventana de 24 h</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
    box.querySelector("tbody").addEventListener("change", (ev) => {
      const id = parseInt(ev.target.dataset.rcpt, 10);
      if (ev.target.checked) state.excludedIds.delete(id);
      else state.excludedIds.add(id);
      renderRecipients();
    });
    box.querySelector("#bulk-check-all").addEventListener("click", () => {
      state.excludedIds.clear();
      renderRecipients();
    });
    box.querySelector("#bulk-uncheck-all").addEventListener("click", () => {
      items.forEach((i) => state.excludedIds.add(i.id));
      renderRecipients();
    });
  }

  function showFormError(text) {
    const err = formCard.querySelector("#bulk-form-error");
    err.textContent = text;
    err.style.display = text ? "block" : "none";
  }

  function openReview() {
    showFormError("");
    const message = formCard.querySelector("#bulk-message").value.trim();
    const selected = selectedItems();
    const open = selected.filter((i) => i.window_open).length;
    const later = formCard.querySelector('input[name="bulk-when"]:checked').value === "later";
    const whenAt = formCard.querySelector("#bulk-when-at").value;
    const botOff = formCard.querySelector('input[name="bulk-bot"]:checked').value === "off";
    const max = hasImage() ? OUTBOUND_CAPTION_MAX : OUTBOUND_TEXT_MAX;

    if (state.preview && !state.preview.has_whatsapp_from) {
      return showFormError("Tu cuenta no tiene un número de WhatsApp configurado. Contacta al administrador.");
    }
    if (!selected.length) return showFormError("Marca al menos un contacto.");
    if (!message) return showFormError("Escribe el mensaje.");
    if (message.length > max) return showFormError(`El mensaje supera ${max} caracteres.`);
    if (later && !whenAt) return showFormError("Elige la fecha y hora del envío.");

    const imgSrc = state.imageFile
      ? URL.createObjectURL(state.imageFile)
      : hasImage()
      ? resolveApiUrl(state.editing.image_url)
      : null;
    const body = el(`
      <div class="bulk-review">
        <p><strong>${selected.length}</strong> contactos marcados.</p>
        <p class="window-open"><strong>${open}</strong> recibirían el mensaje ahora (ventana abierta).</p>
        ${
          selected.length - open
            ? `<p class="window-closed"><strong>${selected.length - open}</strong> quedarían fuera porque no te han escrito
               en las últimas 24 horas (menos el margen de ${marginMinutes} min). WhatsApp no permite escribirles sin una
               plantilla aprobada.</p>`
            : ""
        }
        ${
          later
            ? `<p class="meta">Programado para el ${escapeHtml(whenAt.replace("T", " "))} (hora de Chile). La ventana de
               cada contacto se revisa al momento de enviar, así que estos números pueden cambiar.</p>`
            : `<p class="meta">Sale en menos de un minuto.</p>`
        }
        <p class="meta">${botOff ? "El bot se apagará en las conversaciones a las que llegue el mensaje." : "El bot responderá como siempre."}</p>
        <label>Mensaje final</label>
        <div class="bubble-row bubble-assistant"><div class="bubble">
          ${imgSrc ? `<img class="review-image" src="${escapeAttr(imgSrc)}" alt="Imagen" />` : ""}
          <div class="bubble-content">${escapeHtml(message)}</div>
        </div></div>
        <div class="bulk-review-error error" style="display:none"></div>
        <div class="form-actions">
          <button type="button" class="bulk-confirm">${state.editing ? "Guardar cambios" : later ? "Confirmar programación" : "Confirmar y enviar"}</button>
          <button type="button" class="btn sm secondary bulk-back">Volver</button>
        </div>
      </div>
    `);
    const { close } = openModal({ title: "Vista previa", bodyEl: body });
    body.querySelector(".bulk-back").addEventListener("click", close);
    body.querySelector(".bulk-confirm").addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      const fd = new FormData();
      fd.append("message", message);
      fd.append("conversation_ids", JSON.stringify(selected.map((i) => i.id)));
      if (later) fd.append("scheduled_at", whenAt);
      fd.append("disable_bot", botOff ? "true" : "false");
      if (state.imageFile) fd.append("image", state.imageFile);
      if (state.editing && state.removeImage && !state.imageFile) fd.append("remove_image", "true");
      const path = state.editing
        ? `/doctors/${sessionDoctorId}/bulk-sends/${state.editing.id}`
        : `/doctors/${sessionDoctorId}/bulk-sends`;
      const res = await apiFetch(path, { method: state.editing ? "PUT" : "POST", body: fd });
      if (await handleUnauthorized(res)) return;
      if (!res.ok) {
        const errEl = body.querySelector(".bulk-review-error");
        errEl.textContent = await apiErrorDetail(res, "No se pudo guardar el envío.");
        errEl.style.display = "block";
        btn.disabled = false;
        return;
      }
      close();
      resetState();
      renderForm();
      await loadHistory(0);
    });
  }

  // ── Historial ──
  const HISTORY_LIMIT = 10;
  const historyBox = wrap.querySelector("#bulk-history");

  async function loadHistory(offset) {
    const res = await apiFetch(
      `/doctors/${sessionDoctorId}/bulk-sends?limit=${HISTORY_LIMIT}&offset=${offset}`
    );
    if (await handleUnauthorized(res)) return;
    if (!res.ok) {
      historyBox.innerHTML = `<div class="error">No se pudo cargar el historial.</div>`;
      return;
    }
    const data = await res.json();
    if (!data.items.length) {
      historyBox.innerHTML = `<p class="meta">Aún no hay envíos masivos.</p>`;
      return;
    }
    const rows = data.items
      .map((b) => {
        const when = b.status === "scheduled" ? `Programado: ${formatChile(b.scheduled_at)}` : formatChile(b.started_at || b.scheduled_at);
        const results =
          b.status === "done"
            ? `${b.sent_count} enviados · ${b.skipped_count} omitidos (ventana cerrada)${b.failed_count ? ` · ${b.failed_count} con error` : ""}`
            : `${b.recipient_count} contactos`;
        const actions =
          b.status === "scheduled"
            ? `<button type="button" class="btn sm secondary" data-edit="${b.id}">Editar</button>
               <button type="button" class="btn sm secondary" data-cancel="${b.id}">Cancelar</button>`
            : "";
        return `<tr>
          <td>${escapeHtml(when)}</td>
          <td><span class="bulk-status bulk-status-${escapeAttr(b.status)}">${escapeHtml(BULK_STATUS_LABELS[b.status] || b.status)}</span></td>
          <td class="cell-preview">${escapeHtml(knowledgeTruncate(b.message, 80))}${b.has_image ? ` <span class="meta">(con imagen)</span>` : ""}</td>
          <td>${escapeHtml(results)}</td>
          <td>${b.disable_bot ? "Apaga el bot" : "Bot responde"}</td>
          <td class="table-actions">${actions}</td>
        </tr>`;
      })
      .join("");
    const page = Math.floor(offset / HISTORY_LIMIT) + 1;
    const pages = Math.max(1, Math.ceil(data.total / HISTORY_LIMIT));
    historyBox.innerHTML = `
      <div class="table-scroll"><table>
        <thead><tr><th>Fecha (Chile)</th><th>Estado</th><th>Mensaje</th><th>Resultado</th><th>Bot</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="form-actions">
        <button type="button" class="secondary sm" id="hist-prev" ${offset <= 0 ? "disabled" : ""}>Anterior</button>
        <span class="meta">Página ${page} de ${pages}</span>
        <button type="button" class="secondary sm" id="hist-next" ${page >= pages ? "disabled" : ""}>Siguiente</button>
      </div>
    `;
    historyBox.querySelector("#hist-prev").addEventListener("click", () => loadHistory(Math.max(0, offset - HISTORY_LIMIT)));
    historyBox.querySelector("#hist-next").addEventListener("click", () => loadHistory(offset + HISTORY_LIMIT));
    historyBox.querySelectorAll("[data-edit]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const r = await apiFetch(`/doctors/${sessionDoctorId}/bulk-sends/${btn.dataset.edit}`);
        if (!r.ok) return window.alert("No se pudo cargar el envío.");
        const detail = await r.json();
        if (detail.status !== "scheduled") {
          window.alert("Este envío ya salió o fue cancelado.");
          return loadHistory(offset);
        }
        resetState(detail);
        renderForm();
        formCard.scrollIntoView({ behavior: "smooth" });
      })
    );
    historyBox.querySelectorAll("[data-cancel]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!window.confirm("¿Cancelar este envío programado? No se enviará a nadie.")) return;
        const r = await apiFetch(`/doctors/${sessionDoctorId}/bulk-sends/${btn.dataset.cancel}/cancel`, {
          method: "POST",
        });
        if (!r.ok) window.alert(await apiErrorDetail(r, "No se pudo cancelar el envío."));
        if (state.editing && String(state.editing.id) === btn.dataset.cancel) {
          resetState();
          renderForm();
        }
        loadHistory(offset);
      })
    );
  }

  resetState();
  renderForm();
  await loadHistory(0);
}

// ── Catchup ─────────────────────────────────────────────────────────────────

async function renderCatchup(container) {
  container.innerHTML = "";
  container.classList.remove("chat-mode");

  const wrap = el(`
    <div class="card">
      <h1>Catchup</h1>
      <p class="meta">
        Un mensaje automático (por ejemplo "¿Quieres algo más?") que se envía a cada paciente unas horas después
        de su último mensaje, para darle la oportunidad de seguir la conversación.
      </p>
      ${whatsappRulesHtml({
        title: "Cómo funciona: lee esto antes de activarlo",
        items: [
          [
            "No extiende la ventana",
            "WhatsApp solo deja escribirle a un paciente durante las 24 horas siguientes a su último mensaje. " +
              "El catchup NO alarga ese plazo: solo sirve si el paciente responde. Si responde, la ventana se " +
              "abre de nuevo y el bot le contesta como siempre.",
          ],
          [
            "¿Cuándo sale?",
            "A las N horas del último mensaje del paciente, solo dentro del horario permitido (hora de Chile). " +
              "Si ese momento cae fuera del horario, se adelanta al final del horario anterior. Si no hay un " +
              "horario permitido entre el mensaje del paciente y ese momento, ese catchup no se envía. Si el " +
              "paciente escribe antes, el catchup se recalcula desde su nuevo mensaje.",
          ],
          [
            "¿Por qué no existe \"cada X días\"?",
            "Porque nuestro mensaje no reabre la ventana: pasadas 24 horas sin que el paciente escriba, WhatsApp " +
              "ya no permite escribirle. Por eso el catchup sale como máximo una vez por cada mensaje del paciente.",
          ],
          RULE_COST,
          RULE_BLOCKS,
        ],
      })}
      <div id="cu-message" style="display:none"></div>
      <div id="cu-body"><p class="meta">Cargando…</p></div>
    </div>
  `);
  container.appendChild(wrap);
  const bodyEl = wrap.querySelector("#cu-body");
  const msgEl = wrap.querySelector("#cu-message");

  function showMessage(text, kind) {
    msgEl.textContent = text;
    msgEl.className = kind;
    msgEl.style.display = text ? "block" : "none";
  }

  const classifications = (await fetchContactClassifications()) || [];
  if (sessionDoctorId == null) return;
  const res = await apiFetch(`/doctors/${sessionDoctorId}/catchup-settings`);
  if (await handleUnauthorized(res)) return;
  if (!res.ok) {
    bodyEl.innerHTML = "";
    showMessage("No se pudo cargar la configuración. Intenta nuevamente.", "error");
    return;
  }
  let data = await res.json();

  const hourOptions = (from, to, selected) =>
    Array.from({ length: to - from + 1 }, (_, k) => from + k)
      .map((h) => `<option value="${h}" ${h === selected ? "selected" : ""}>${String(h).padStart(2, "0")}:00</option>`)
      .join("");

  function renderForm() {
    const excludedTags = new Set(data.excluded_tags);
    const excludedCcs = new Set(data.excluded_classification_ids);
    const stateOptions = [["__none__", "Sin estado"], ...CONVERSATION_STATES.map((s) => [s, s])];
    bodyEl.innerHTML = `
      <label class="check-option cu-enabled"><input type="checkbox" id="cu-enabled" ${data.enabled ? "checked" : ""} />
        <strong>Catchup activado</strong></label>
      <p class="meta">Al activarlo, también se enviará a pacientes que escribieron en las últimas horas.</p>

      <label for="cu-text">Mensaje</label>
      <textarea id="cu-text" rows="4" placeholder="Ej.: ¿Hay algo más en lo que te pueda ayudar?">${escapeHtml(data.message)}</textarea>
      <div class="char-counter meta" id="cu-counter"></div>

      <label>Imagen (opcional, JPG o PNG, hasta 5 MB)</label>
      <div id="cu-image"></div>
      <input type="file" id="cu-image-input" accept="image/jpeg,image/png" />

      <h3 class="form-section-title">Cuándo se envía</h3>
      <div class="inline-form">
        <input type="number" id="cu-hours" min="1" max="23" step="1" value="${data.hours_after}" />
        <span class="meta">horas después del último mensaje del paciente</span>
      </div>
      <div class="inline-form">
        <span class="meta">Horario permitido (hora de Chile): desde</span>
        <select id="cu-start">${hourOptions(0, 23, data.allowed_start_hour)}</select>
        <span class="meta">hasta</span>
        <select id="cu-end">${hourOptions(1, 24, data.allowed_end_hour)}</select>
      </div>
      <div class="inline-form">
        <span class="meta">Margen de seguridad antes de que cierre la ventana:</span>
        <input type="number" id="cu-margin" min="1" max="60" step="1" value="${data.window_margin_minutes}" />
        <span class="meta">minutos (de 1 a 60)</span>
      </div>

      <h3 class="form-section-title">Repetición</h3>
      <label class="check-option"><input type="radio" name="cu-repeat" value="unlimited" ${data.max_streak == null ? "checked" : ""} />
        Un catchup por cada mensaje del paciente, sin límite</label>
      <label class="check-option"><input type="radio" name="cu-repeat" value="max" ${data.max_streak != null ? "checked" : ""} />
        Como máximo
        <input type="number" id="cu-max" min="1" max="100" step="1" value="${data.max_streak ?? 2}" class="input-sm" />
        catchups seguidos sin que el paciente escriba por su cuenta</label>
      <p class="meta">Si el paciente solo responde a un catchup, sigue contando como "seguido". El conteo vuelve a cero cuando
        escribe después de un mensaje que no era catchup.</p>

      <h3 class="form-section-title">A quiénes</h3>
      <label class="check-option"><input type="checkbox" id="cu-bot-off" ${data.send_when_bot_disabled ? "checked" : ""} />
        Enviar también a conversaciones con el bot apagado</label>
      <div class="bulk-filters">
        <div>
          <span class="filter-field-label">No enviar a estos estados</span>
          <div class="check-list" id="cu-tags">
            ${stateOptions
              .map(
                ([v, label]) => `<label class="check-option"><input type="checkbox" value="${escapeAttr(v)}" ${
                  excludedTags.has(v) ? "checked" : ""
                } /> ${escapeHtml(label)}</label>`
              )
              .join("")}
          </div>
        </div>
        <div>
          <span class="filter-field-label">No enviar a estas clasificaciones (por ejemplo, "ya operados")</span>
          <div class="check-list" id="cu-ccs">
            ${
              classifications.length
                ? classifications
                    .map(
                      (cc) => `<label class="check-option"><input type="checkbox" value="${cc.id}" ${
                        excludedCcs.has(cc.id) ? "checked" : ""
                      } /> ${contactBadgeHtml(cc)}</label>`
                    )
                    .join("")
                : `<p class="meta">Aún no hay clasificaciones. <a href="#/classifications">Crear clasificaciones</a></p>`
            }
          </div>
        </div>
      </div>

      <div class="form-actions">
        <button type="button" id="cu-save">Guardar</button>
      </div>
    `;

    const textInp = bodyEl.querySelector("#cu-text");
    const counter = bodyEl.querySelector("#cu-counter");
    const refreshCounter = () => updateOutboundCounter(counter, textInp.value.trim(), data.has_image);
    textInp.addEventListener("input", refreshCounter);
    refreshCounter();

    const imageBox = bodyEl.querySelector("#cu-image");
    if (data.has_image) {
      // Parámetro de versión para que el navegador no muestre la imagen anterior.
      const src = `${resolveApiUrl(data.image_url)}?v=${encodeURIComponent(data.updated_at || "")}`;
      imageBox.innerHTML = `<div class="image-preview"><img src="${escapeAttr(src)}" alt="Imagen del catchup" />
        <button type="button" class="secondary sm" id="cu-image-remove">Quitar imagen</button></div>`;
      imageBox.querySelector("#cu-image-remove").addEventListener("click", async () => {
        const r = await apiFetch(`/doctors/${sessionDoctorId}/catchup-settings/image`, { method: "DELETE" });
        if (!r.ok) return showMessage(await apiErrorDetail(r, "No se pudo quitar la imagen."), "error");
        data = await r.json();
        showMessage("Imagen quitada.", "success");
        renderForm();
      });
    }
    bodyEl.querySelector("#cu-image-input").addEventListener("change", async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      const err = outboundImageError(file);
      if (err) {
        ev.target.value = "";
        return showMessage(err, "error");
      }
      if (!file) return;
      const fd = new FormData();
      fd.append("file", file);
      const r = await apiFetch(`/doctors/${sessionDoctorId}/catchup-settings/image`, { method: "POST", body: fd });
      if (!r.ok) {
        ev.target.value = "";
        return showMessage(await apiErrorDetail(r, "No se pudo subir la imagen."), "error");
      }
      data = await r.json();
      showMessage("Imagen guardada.", "success");
      renderForm();
    });

    bodyEl.querySelector("#cu-save").addEventListener("click", async () => {
      showMessage("", "error");
      const repeatMax = bodyEl.querySelector('input[name="cu-repeat"]:checked').value === "max";
      const payload = {
        enabled: bodyEl.querySelector("#cu-enabled").checked,
        message: textInp.value.trim(),
        hours_after: parseInt(bodyEl.querySelector("#cu-hours").value, 10),
        allowed_start_hour: parseInt(bodyEl.querySelector("#cu-start").value, 10),
        allowed_end_hour: parseInt(bodyEl.querySelector("#cu-end").value, 10),
        max_streak: repeatMax ? parseInt(bodyEl.querySelector("#cu-max").value, 10) : null,
        send_when_bot_disabled: bodyEl.querySelector("#cu-bot-off").checked,
        excluded_tags: Array.from(bodyEl.querySelectorAll("#cu-tags input:checked")).map((i) => i.value),
        excluded_classification_ids: Array.from(bodyEl.querySelectorAll("#cu-ccs input:checked")).map((i) =>
          parseInt(i.value, 10)
        ),
        window_margin_minutes: parseInt(bodyEl.querySelector("#cu-margin").value, 10),
      };
      if (payload.enabled && !data.enabled) {
        const ok = window.confirm(
          "Al activar el catchup, también se enviará a pacientes que escribieron en las últimas horas " +
            "(si ya se cumplió su plazo y estamos dentro del horario permitido). ¿Activar?"
        );
        if (!ok) return;
      }
      const r = await apiFetch(`/doctors/${sessionDoctorId}/catchup-settings`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      if (await handleUnauthorized(r)) return;
      if (!r.ok) return showMessage(await apiErrorDetail(r, "No se pudo guardar. Revisa los campos."), "error");
      data = await r.json();
      renderForm();
      showMessage("Configuración guardada.", "success");
    });
  }

  renderForm();
}

// ── Prompt del asistente ────────────────────────────────────────────────────

async function renderSystemPrompt(container) {
  container.innerHTML = "";
  container.classList.remove("chat-mode");

  const wrap = el(`
    <div class="card">
      <h1>Prompt del asistente</h1>
      <p class="meta">
        Aquí defines cómo se comporta el asistente virtual que responde a tus pacientes por WhatsApp.
      </p>

      <details class="prompt-help" open>
        <summary>¿Qué es y cómo funciona?</summary>
        <div class="prompt-help-body">
          <h3>¿Qué es el prompt?</h3>
          <p>
            Es un texto con las instrucciones que sigue tu asistente: quién es, cómo habla, qué puede
            y qué no puede responder. Piensa en él como la "inducción" que le darías a una persona
            nueva que atenderá a tus pacientes.
          </p>
          <h3>¿Cómo funciona?</h3>
          <ul>
            <li>En cada mensaje de un paciente, el asistente lee este prompt junto con tu
              <a href="#/knowledge">Base de conocimiento</a> y el historial de la conversación.</li>
            <li>Los cambios se aplican de inmediato: el siguiente mensaje que llegue ya usará el
              prompt nuevo.</li>
            <li>Si no has personalizado nada, se usa un prompt base preparado para tu especialidad.</li>
          </ul>
          <h3>Lo que se agrega automáticamente</h3>
          <p>No necesitas escribir esto; el sistema lo incluye siempre:</p>
          <ul>
            <li>La información de tu Base de conocimiento.</li>
            <li>Los datos de contacto de tu asistente humano, para derivar consultas que no puede resolver.</li>
            <li>El formato de WhatsApp (sin Markdown) y el idioma: español de Chile.</li>
          </ul>
          <h3>Recomendaciones</h3>
          <ul>
            <li>Usa frases claras y breves; una instrucción por línea.</li>
            <li>Indica el tono (cercano, formal, empático) y cómo debe presentarse.</li>
            <li>Define qué hacer cuando no sabe la respuesta (por ejemplo, ofrecer contactar a tu asistente).</li>
            <li>Indica lo que nunca debe hacer, como dar diagnósticos o indicar medicamentos.</li>
            <li>No pongas aquí datos que cambian (precios, horarios, direcciones): van en la Base de conocimiento.</li>
            <li>Haz cambios pequeños y prueba el resultado enviando un mensaje de prueba.</li>
          </ul>
          <p class="meta">
            Un prompt mal escrito puede alterar las respuestas del asistente. Si algo no sale como
            esperabas, usa "Restaurar prompt por defecto".
          </p>
        </div>
      </details>

      <div id="sp-message" class="error" style="display:none"></div>
      <div id="sp-body"><p class="meta">Cargando…</p></div>
    </div>
  `);
  container.appendChild(wrap);

  const body = wrap.querySelector("#sp-body");
  const msg = wrap.querySelector("#sp-message");

  function showMessage(text, kind) {
    msg.textContent = text;
    msg.className = kind;
    msg.style.display = text ? "block" : "none";
  }

  const res = await apiFetch(`/doctors/${sessionDoctorId}/system-prompt`);
  if (res.status === 401) {
    sessionDoctorId = null;
    location.hash = "#/login";
    await render();
    return;
  }
  if (!res.ok) {
    body.innerHTML = "";
    showMessage("No se pudo cargar el prompt. Intenta nuevamente.", "error");
    return;
  }
  let data = await res.json();

  body.innerHTML = `
    <label for="sp-textarea">Prompt de sistema</label>
    <p class="meta" id="sp-status"></p>
    <textarea id="sp-textarea" rows="18" maxlength="${data.max_length}" spellcheck="true"></textarea>
    <div class="prompt-counter meta" id="sp-counter"></div>
    <div class="form-actions">
      <button type="button" id="sp-save">Guardar cambios</button>
      <button type="button" id="sp-discard" class="btn sm secondary">Descartar cambios</button>
      <button type="button" id="sp-reset" class="btn sm secondary">Restaurar prompt por defecto</button>
    </div>
  `;
  const ta = body.querySelector("#sp-textarea");
  const statusEl = body.querySelector("#sp-status");
  const counter = body.querySelector("#sp-counter");
  const saveBtn = body.querySelector("#sp-save");
  const discardBtn = body.querySelector("#sp-discard");
  const resetBtn = body.querySelector("#sp-reset");

  // Texto base contra el que se detectan cambios sin guardar.
  let baseline = "";

  function currentText() {
    return data.system_prompt || data.default_system_prompt;
  }

  function updateUi() {
    const dirty = ta.value !== baseline;
    counter.textContent = `${ta.value.length} / ${data.max_length} caracteres`;
    saveBtn.disabled = !dirty || !ta.value.trim();
    discardBtn.disabled = !dirty;
    resetBtn.disabled = !data.is_custom;
    statusEl.textContent = dirty
      ? "Tienes cambios sin guardar."
      : data.is_custom
      ? "Estás usando un prompt personalizado."
      : "Estás usando el prompt por defecto. Puedes editarlo y guardarlo para personalizarlo.";
  }

  function load(next) {
    data = next;
    baseline = currentText();
    ta.value = baseline;
    updateUi();
  }

  async function save(value, okText) {
    showMessage("", "error");
    saveBtn.disabled = true;
    resetBtn.disabled = true;
    const r = await apiFetch(`/doctors/${sessionDoctorId}/system-prompt`, {
      method: "PUT",
      body: JSON.stringify({ system_prompt: value }),
    });
    if (r.status === 401) {
      sessionDoctorId = null;
      location.hash = "#/login";
      await render();
      return;
    }
    if (!r.ok) {
      updateUi();
      showMessage("No se pudieron guardar los cambios. Intenta nuevamente.", "error");
      return;
    }
    load(await r.json());
    showMessage(okText, "success");
  }

  ta.addEventListener("input", () => {
    showMessage("", "error");
    updateUi();
  });
  saveBtn.addEventListener("click", () => {
    const text = ta.value.trim();
    // Si queda igual al prompt base, se guarda como "por defecto" (null).
    const isDefault = text === data.default_system_prompt.trim();
    save(isDefault ? null : text, "Cambios guardados.");
  });
  discardBtn.addEventListener("click", () => {
    ta.value = baseline;
    showMessage("", "error");
    updateUi();
  });
  resetBtn.addEventListener("click", () => {
    if (
      !window.confirm(
        "¿Restaurar el prompt por defecto? Se perderá tu prompt personalizado y el asistente volverá a usar el prompt base."
      )
    )
      return;
    save(null, "Se restauró el prompt por defecto.");
  });

  load(data);
}

const MESSAGE_SOURCE_LABELS = {
  bot: "Bot",
  human: "Humano",
  bulk: "Mensaje masivo",
  catchup: "Catchup",
};

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
    if (m.created_at) div.dataset.ts = m.created_at;
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
  if (m.created_at) row.dataset.ts = m.created_at;

  // Origen de cada mensaje enviado (los antiguos sin origen se muestran como "Bot").
  const sourceHtml = isUser
    ? ""
    : `<span class="msg-source msg-source-${escapeAttr(MESSAGE_SOURCE_LABELS[m.source] ? m.source : "bot")}">${escapeHtml(
        MESSAGE_SOURCE_LABELS[m.source] || MESSAGE_SOURCE_LABELS.bot
      )}</span>`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML =
    sourceHtml +
    `<div class="bubble-content">${escapeHtml(m.content)}</div>` +
    (attHtml ? `<div class="attachment-chips">${attHtml}</div>` : "") +
    `<div class="bubble-time">${escapeHtml(time)}</div>`;

  row.appendChild(bubble);
  return row;
}

/** Day bucket key (local) used to group messages. */
function chatDayKey(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** WhatsApp-style human label for a day: "Hoy", "Ayer", weekday, or full date. */
function chatDayLabel(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diffDays = Math.round(
    (startOf(new Date()) - startOf(d)) / 86400000
  );
  if (diffDays === 0) return "Hoy";
  if (diffDays === 1) return "Ayer";
  if (diffDays > 1 && diffDays < 7) {
    const wd = d.toLocaleDateString("es", { weekday: "long" });
    return wd.charAt(0).toUpperCase() + wd.slice(1);
  }
  return d.toLocaleDateString("es", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Inline date separator pill that stays within the chat flow. */
function buildDateSeparator(iso) {
  const sep = document.createElement("div");
  sep.className = "chat-date-sep";
  const pill = document.createElement("span");
  pill.className = "chat-date-pill";
  pill.textContent = chatDayLabel(iso);
  sep.appendChild(pill);
  return sep;
}

/**
 * Recompute inline date separators: one pill before the first message of
 * each day, in chronological (DOM) order. Idempotent — safe to call after
 * any mutation (initial render, prepend older, append newer).
 */
function rebuildDateSeparators(messagesArea) {
  messagesArea.querySelectorAll(".chat-date-sep").forEach((n) => n.remove());
  let prevKey = null;
  for (const node of messagesArea.querySelectorAll("[data-ts]")) {
    const key = chatDayKey(node.dataset.ts);
    if (!key) continue;
    if (key !== prevKey) {
      messagesArea.insertBefore(buildDateSeparator(node.dataset.ts), node);
      prevKey = key;
    }
  }
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
  let conv = await convRes.json();

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
  const knownMsgIds = new Set();
  let latestMsgId = 0;
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
      <div class="chat-header-center" id="chat-header-info"></div>
      <div class="chat-header-right">
        <button type="button" class="bot-toggle-btn ${botEnabled ? "bot-on" : "bot-off"}" id="chat-bot-toggle">
          <span class="bot-toggle-dot"></span>
          <span class="bot-toggle-label">${botEnabled ? "Bot ON" : "Bot OFF"}</span>
        </button>
      </div>
    </div>
    <div class="chat-messages-viewport">
      <div class="chat-date-float" id="chat-date-float" aria-hidden="true"></div>
      <div class="chat-messages" id="chat-messages">
        <div class="chat-load-more-wrapper" id="chat-load-more-wrapper" ${totalMessages <= olderOffset ? 'style="display:none"' : ""}>
          <button type="button" class="secondary sm" id="chat-load-more">Cargar mensajes anteriores</button>
        </div>
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
  const dateFloat = wrapper.querySelector("#chat-date-float");
  const loadMoreWrapper = wrapper.querySelector("#chat-load-more-wrapper");
  const botToggleBtn = wrapper.querySelector("#chat-bot-toggle");
  const botStatusEl = wrapper.querySelector("#chat-bot-status");
  const textarea = wrapper.querySelector("#chat-textarea");
  const sendBtn = wrapper.querySelector("#chat-send-btn");
  const headerInfo = wrapper.querySelector("#chat-header-info");

  // Nombre(s), número y clasificaciones; clic abre el modal "Clasificar".
  // Se actualiza en el lugar (sin re-render) para no reiniciar el polling ni el scroll.
  function renderHeaderInfo() {
    headerInfo.innerHTML = `
      <button type="button" class="chat-header-classify" title="Clasificar contacto">
        <span class="chat-header-names">${contactNamesHtml(conv)}</span>
        <span class="chat-header-phone">${escapeHtml(conv.phone_number)}</span>
        <span class="contact-badges">${contactBadgesHtml(conv.contact_classifications)}</span>
      </button>
    `;
    headerInfo.querySelector(".chat-header-classify").addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      const classifications = await fetchContactClassifications();
      btn.disabled = false;
      if (classifications == null) {
        if (sessionDoctorId != null) window.alert("No se pudieron cargar las clasificaciones.");
        return;
      }
      openClassifyModal(conv, classifications, (updated) => {
        conv = updated;
        renderHeaderInfo();
      });
    });
  }
  renderHeaderInfo();

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

  // Floating WhatsApp-style date pill: reflects the day of the topmost
  // visible message while scrolling, then fades out once scrolling stops.
  let dateFloatHideTimer = null;
  function updateFloatingDate() {
    const nodes = messagesArea.querySelectorAll("[data-ts]");
    if (!nodes.length) return;
    const top = messagesArea.scrollTop;
    let currentTs = null;
    for (const node of nodes) {
      if (node.offsetTop + node.offsetHeight - 6 > top) {
        currentTs = node.dataset.ts;
        break;
      }
    }
    if (!currentTs) currentTs = nodes[nodes.length - 1].dataset.ts;
    dateFloat.textContent = chatDayLabel(currentTs);
  }
  function showFloatingDate() {
    updateFloatingDate();
    dateFloat.classList.add("visible");
    if (dateFloatHideTimer) clearTimeout(dateFloatHideTimer);
    dateFloatHideTimer = setTimeout(
      () => dateFloat.classList.remove("visible"),
      1400
    );
  }
  messagesArea.addEventListener("scroll", showFloatingDate, { passive: true });

  // Render initial messages
  for (const m of initialMessages) appendBubble(m);
  rebuildDateSeparators(messagesArea);
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
    rebuildDateSeparators(messagesArea);
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
    rebuildDateSeparators(messagesArea);
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
      rebuildDateSeparators(messagesArea);
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
  stopTagTimer();
  const app = document.getElementById("app");
  if (!app) return;
  app.classList.remove("chat-mode");

  const route = parseHash();
  const ok = sessionDoctorId != null ? true : await trySession();

  if (!ok) {
    setSidebarVisible(false);
    if (route.view !== "login") {
      location.hash = "#/login";
    }
    renderLogin(app, null);
    return;
  }

  if (route.view === "login") {
    navTo("dashboard");
    await render();
    return;
  }

  setSidebarVisible(true);
  updateActiveNav(route.view);

  if (route.view === "change-password") {
    renderChangePassword(app);
    return;
  }

  if (route.view === "dashboard") {
    await renderDashboard(app, route);
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
  if (route.view === "knowledge") {
    await renderKnowledge(app, route);
    return;
  }
  if (route.view === "prompt") {
    await renderSystemPrompt(app, route);
    return;
  }
  if (route.view === "classifications") {
    await renderClassifications(app, route);
    return;
  }
  if (route.view === "bulk-send") {
    await renderBulkSend(app, route);
    return;
  }
  if (route.view === "catchup") {
    await renderCatchup(app, route);
    return;
  }
  await renderDashboard(app, route);
}

function goHome() {
  if (!sessionDoctorId) return;
  navTo("dashboard");
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

// Desplegables de filtros: se cierran al hacer clic fuera.
document.addEventListener("click", (ev) => {
  document.querySelectorAll("details.filter-dropdown[open]").forEach((d) => {
    if (!d.contains(ev.target)) d.removeAttribute("open");
  });
});

if (!location.hash || location.hash === "#") {
  location.replace("#/");
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

// Sidebar collapse (desktop)
(function () {
  const sidebar = document.getElementById("sidebar");
  const btn = document.getElementById("btn-sidebar-collapse");
  if (!sidebar || !btn) return;

  function applyCollapsed(collapsed) {
    sidebar.classList.toggle("collapsed", collapsed);
    localStorage.setItem("coyote-portal-sidebar-collapsed", collapsed ? "1" : "0");
    if (collapsed) closeAllSidebarGroups();
  }

  applyCollapsed(localStorage.getItem("coyote-portal-sidebar-collapsed") === "1");

  btn.addEventListener("click", () => {
    applyCollapsed(!sidebar.classList.contains("collapsed"));
  });

  // Clic en un grupo: abre/cierra. Con el sidebar colapsado (escritorio),
  // primero lo expande y abre el grupo.
  const mobileQuery = window.matchMedia("(max-width: 640px)");
  sidebar.querySelectorAll(".sidebar-group").forEach((group) => {
    group.querySelector(".sidebar-group-btn").addEventListener("click", () => {
      if (sidebar.classList.contains("collapsed") && !mobileQuery.matches) {
        applyCollapsed(false);
        setSidebarGroupOpen(group, true);
        return;
      }
      setSidebarGroupOpen(group, !group.classList.contains("open"));
    });
  });
})();

// Sidebar drawer (mobile)
(function () {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");
  const toggleBtn = document.getElementById("btn-sidebar-toggle");
  if (!sidebar || !backdrop || !toggleBtn) return;

  function openMobileSidebar() {
    sidebar.classList.add("open");
    backdrop.classList.remove("hidden");
  }

  toggleBtn.addEventListener("click", () => {
    if (sidebar.classList.contains("open")) {
      closeMobileSidebar();
    } else {
      openMobileSidebar();
    }
  });

  backdrop.addEventListener("click", closeMobileSidebar);
  sidebar.querySelectorAll(".sidebar-link").forEach((link) => {
    link.addEventListener("click", closeMobileSidebar);
  });
})();
