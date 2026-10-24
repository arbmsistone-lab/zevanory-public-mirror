// "Fale com a ZEVANORY" — chat do site (WCAG 2.2 AA). Fonte: sales-overlay/site-chat.js (copiado para sales-public).
// * Só existe na página quando o Worker de vendas está com SITE_CHAT_ENABLED=true (ele anexa este arquivo).
// * Nunca abre sozinho e nunca envia mensagem sozinho: tudo começa por um clique/tecla da pessoa.
// * Sem cookies, sem armazenamento persistente: o token da sessão fica só em sessionStorage (esta aba).
// * Sem script de terceiros, sem innerHTML, sem estilo inline (CSP: script-src/style-src 'self').
// * Opcional: a página continua com e-mail e formulários sem este script.
(function () {
  "use strict";
  if (window.__zevSiteChat) return;
  window.__zevSiteChat = true;
  var API = "/api/chat";
  var MAX = 600;
  var EMAIL = "suporte@zevanory.api.br";
  var FORM = "https://zevanory.api.br/atendimento";
  var LINK_HOSTS = ["vendas.zevanory.api.br", "zevanory.api.br"];
  var KEY = "zevSiteChatSession";
  var state = { session: "", idleMinutes: 30, idleTimer: 0, warnTimer: 0, busy: false, opener: null, started: false, notice: null };

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "className") n.className = attrs[k];
      else if (k === "hidden") { if (attrs[k]) n.hidden = true; }
      else n.setAttribute(k, attrs[k]);
    });
    if (text != null) n.textContent = text;
    return n;
  }
  function store(v) { try { if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); } catch (e) {} }
  function stored() { try { return sessionStorage.getItem(KEY) || ""; } catch (e) { return ""; } }

  // Texto com links: só https dos nossos domínios vira <a>; o resto é texto puro.
  function richText(parent, text) {
    var re = /https:\/\/[^\s)>\]]+/g, last = 0, m;
    text = String(text || "");
    while ((m = re.exec(text))) {
      var url = m[0].replace(/[.,;!?]+$/, "");
      parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var ok = false;
      try { var u = new URL(url); ok = u.protocol === "https:" && LINK_HOSTS.indexOf(u.hostname) >= 0 && !/^\/(comprar|assinar)\b/.test(u.pathname); } catch (e) {}
      if (ok) { var a = el("a", { href: url }, url); parent.appendChild(a); } else parent.appendChild(document.createTextNode(url));
      last = m.index + url.length;
    }
    parent.appendChild(document.createTextNode(text.slice(last)));
  }

  // ---------- estrutura ----------
  var entry = el("section", { className: "zc-entry", "aria-labelledby": "zc-entry-title" });
  entry.appendChild(el("h2", { id: "zc-entry-title", className: "zc-entry-title" }, "Dúvidas? Fale com a ZEVANORY"));
  entry.appendChild(el("p", { className: "zc-entry-text" }, "Converse com o assistente automático ou escreva para " + EMAIL + "."));
  var launch = el("button", { type: "button", className: "zc-button zc-launch", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "zc-panel" }, "Fale com a ZEVANORY");
  entry.appendChild(launch);

  var panel = el("div", { id: "zc-panel", className: "zc-panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "zc-title", hidden: true });
  var head = el("div", { className: "zc-head" });
  head.appendChild(el("h2", { id: "zc-title", className: "zc-title", tabindex: "-1" }, "Fale com a ZEVANORY"));
  var closeBtn = el("button", { type: "button", className: "zc-button zc-close", "aria-label": "Fechar o chat" }, "Fechar");
  head.appendChild(closeBtn);
  panel.appendChild(head);

  var body = el("div", { className: "zc-body" });
  panel.appendChild(body);

  // Aviso pré-chat (texto vindo de data/site-chat-policy.json via /api/chat/status).
  var notice = el("div", { className: "zc-notice", "aria-labelledby": "zc-notice-title" });
  notice.appendChild(el("h3", { id: "zc-notice-title", className: "zc-subtitle" }, "Antes de começar"));
  var noticeList = el("ul", { className: "zc-notice-list" });
  notice.appendChild(noticeList);
  var privacy = el("p", { className: "zc-small" });
  var privacyLink = el("a", { href: "/privacidade" }, "Política de Privacidade");
  privacy.appendChild(document.createTextNode("Mais detalhes na "));
  privacy.appendChild(privacyLink);
  privacy.appendChild(document.createTextNode("."));
  notice.appendChild(privacy);
  var noticeActions = el("div", { className: "zc-actions" });
  var startBtn = el("button", { type: "button", className: "zc-button zc-primary" }, "Começar conversa");
  var mailLink = el("a", { className: "zc-button zc-secondary", href: "mailto:" + EMAIL + "?subject=" + encodeURIComponent("Contato pelo site ZEVANORY") }, "Prefiro e-mail");
  noticeActions.appendChild(startBtn);
  noticeActions.appendChild(mailLink);
  notice.appendChild(noticeActions);
  body.appendChild(notice);

  // Conversa.
  var chat = el("div", { className: "zc-chat", hidden: true });
  var log = el("ol", { className: "zc-log", role: "log", "aria-live": "polite", "aria-relevant": "additions", "aria-label": "Histórico da conversa", tabindex: "0" });
  chat.appendChild(log);
  var status = el("p", { className: "zc-status", role: "status" });
  chat.appendChild(status);
  var timeout = el("div", { className: "zc-timeout", role: "alert", hidden: true });
  timeout.appendChild(el("p", null, "Sua conversa vai encerrar em 2 minutos por inatividade."));
  var extendBtn = el("button", { type: "button", className: "zc-button zc-secondary" }, "Continuar conversa");
  timeout.appendChild(extendBtn);
  chat.appendChild(timeout);

  var form = el("form", { className: "zc-form", novalidate: "novalidate" });
  form.appendChild(el("label", { for: "zc-input", className: "zc-label" }, "Sua mensagem"));
  var input = el("textarea", { id: "zc-input", className: "zc-input", rows: "2", maxlength: String(MAX), "aria-describedby": "zc-hint zc-count", autocomplete: "off" });
  form.appendChild(input);
  form.appendChild(el("p", { id: "zc-hint", className: "zc-small" }, "Não envie senha, cartão, documentos ou dados sensíveis."));
  var count = el("p", { id: "zc-count", className: "zc-small zc-count" }, "0 de " + MAX + " caracteres");
  form.appendChild(count);
  var formActions = el("div", { className: "zc-actions" });
  var sendBtn = el("button", { type: "submit", className: "zc-button zc-primary" }, "Enviar");
  var humanBtn = el("button", { type: "button", className: "zc-button zc-secondary" }, "Falar com uma pessoa");
  formActions.appendChild(sendBtn);
  formActions.appendChild(humanBtn);
  form.appendChild(formActions);
  chat.appendChild(form);

  var extra = el("div", { className: "zc-extra" });
  chat.appendChild(extra);

  // Atendimento humano (protocolo + confirmação por e-mail).
  var handoff = el("form", { className: "zc-handoff", hidden: true, novalidate: "novalidate", "aria-labelledby": "zc-handoff-title" });
  handoff.appendChild(el("h3", { id: "zc-handoff-title", className: "zc-subtitle", tabindex: "-1" }, "Atendimento humano"));
  handoff.appendChild(el("p", { className: "zc-small" }, "Informe seu e-mail para receber o protocolo e a resposta da equipe. Resposta conclusiva em até 5 dias."));
  handoff.appendChild(el("label", { for: "zc-email", className: "zc-label" }, "Seu e-mail"));
  var emailInput = el("input", { id: "zc-email", className: "zc-input", type: "email", autocomplete: "email", inputmode: "email", required: "required", "aria-describedby": "zc-email-error" });
  handoff.appendChild(emailInput);
  var emailError = el("p", { id: "zc-email-error", className: "zc-error", "aria-live": "polite" });
  handoff.appendChild(emailError);
  var handoffActions = el("div", { className: "zc-actions" });
  handoffActions.appendChild(el("button", { type: "submit", className: "zc-button zc-primary" }, "Enviar para a equipe"));
  var handoffCancel = el("button", { type: "button", className: "zc-button zc-secondary" }, "Voltar");
  handoffActions.appendChild(handoffCancel);
  handoff.appendChild(handoffActions);
  chat.appendChild(handoff);
  body.appendChild(chat);

  // Indisponível: e-mail e formulários continuam valendo.
  var down = el("div", { className: "zc-down", hidden: true });
  var downText = el("p", null, "O chat está indisponível agora. Escreva para " + EMAIL + ", use o formulário de atendimento ou os formulários de reembolso e de novo link de acesso.");
  down.appendChild(downText);
  var downLinks = el("ul", { className: "zc-notice-list" });
  [["mailto:" + EMAIL, "Escrever para " + EMAIL], [FORM, "Formulário de atendimento"], ["https://zevanory.api.br/pedir-reembolso", "Pedir reembolso"], ["https://zevanory.api.br/entrega/reenviar", "Pedir novo link de acesso"]].forEach(function (x) {
    var li = el("li"); li.appendChild(el("a", { href: x[0] }, x[1])); downLinks.appendChild(li);
  });
  down.appendChild(downLinks);
  body.appendChild(down);

  function mount() {
    var footer = document.querySelector("footer");
    if (footer && footer.parentNode) footer.parentNode.insertBefore(entry, footer); else document.body.appendChild(entry);
    document.body.appendChild(panel);
  }

  // ---------- comportamento ----------
  function focusables() {
    return Array.prototype.filter.call(panel.querySelectorAll("a[href],button,textarea,input,[tabindex]:not([tabindex='-1'])"), function (n) {
      return !n.disabled && !n.closest("[hidden]");
    });
  }
  function open() {
    state.opener = document.activeElement;
    panel.hidden = false;
    launch.setAttribute("aria-expanded", "true");
    document.documentElement.classList.add("zc-open");
    document.getElementById("zc-title").focus();
    if (!state.notice) loadStatus();
  }
  function close() {
    panel.hidden = true;
    launch.setAttribute("aria-expanded", "false");
    document.documentElement.classList.remove("zc-open");
    (state.opener && state.opener.focus ? state.opener : launch).focus();
  }
  function showDown(text) {
    notice.hidden = true; chat.hidden = true; down.hidden = false;
    if (text) downText.textContent = text;
  }
  function request(path, method, payload) {
    var opts = { method: method, headers: { "content-type": "application/json" }, credentials: "same-origin" };
    if (payload) opts.body = JSON.stringify(payload);
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; return j; });
    });
  }
  function loadStatus() {
    request("/status", "GET").then(function (j) {
      if (j.__status !== 200 || !j.notice) return showDown(j.fallback && j.fallback.message);
      state.notice = j.notice;
      state.idleMinutes = Number(j.idle_minutes) || 30;
      if (j.message_max_chars) { MAX = Number(j.message_max_chars) || MAX; input.setAttribute("maxlength", String(MAX)); updateCount(); }
      noticeList.textContent = "";
      ["who_answers", "do_not_send", "controller", "purpose", "data", "legal_basis", "operators", "sharing", "transfer", "retention", "rights", "optional"].forEach(function (k) {
        if (j.notice[k]) noticeList.appendChild(el("li", null, j.notice[k]));
      });
      if (j.notice.privacy_href) privacyLink.setAttribute("href", j.notice.privacy_href);
    }).catch(function () { showDown(); });
  }
  function addMessage(role, text) {
    var li = el("li", { className: "zc-msg zc-" + role });
    li.appendChild(el("span", { className: "zc-sr" }, role === "user" ? "Você disse: " : "Assistente ZEVANORY: "));
    var p = el("span", { className: "zc-text" });
    richText(p, text);
    li.appendChild(p);
    log.appendChild(li);
    log.scrollTop = log.scrollHeight; // rola o histórico, mas NÃO move o foco (WCAG: nova resposta não sequestra foco)
    return li;
  }
  function setBusy(b) {
    state.busy = b;
    log.setAttribute("aria-busy", b ? "true" : "false");
    sendBtn.disabled = b;
    status.textContent = b ? "Enviando…" : "";
  }
  function armIdle() {
    clearTimeout(state.idleTimer); clearTimeout(state.warnTimer);
    timeout.hidden = true;
    var ms = state.idleMinutes * 60000;
    state.warnTimer = setTimeout(function () { timeout.hidden = false; }, Math.max(ms - 120000, 20000));
    state.idleTimer = setTimeout(function () {
      timeout.hidden = true; store(""); state.session = "";
      addMessage("bot", "A conversa foi encerrada por inatividade. Escreva de novo para começar outra.");
    }, ms);
  }
  function ensureSession() {
    if (state.session) return Promise.resolve(state.session);
    var s = stored();
    if (s) { state.session = s; return Promise.resolve(s); }
    return request("/session", "POST", {}).then(function (j) {
      if (j.__status !== 200 || !j.session) throw j;
      state.session = j.session; store(j.session);
      state.idleMinutes = Number(j.idle_minutes) || state.idleMinutes;
      return j.session;
    });
  }
  function renderActions(actions) {
    extra.textContent = "";
    (actions || []).forEach(function (a) {
      if (a.type === "waitlist" && /^mailto:/.test(a.href || "")) extra.appendChild(el("a", { className: "zc-button zc-secondary", href: a.href }, a.label || "Entrar na lista de espera por e-mail"));
      if (a.type === "email") extra.appendChild(el("a", { className: "zc-button zc-secondary", href: "mailto:" + EMAIL }, "Escrever para " + EMAIL));
      if (a.type === "form") extra.appendChild(el("a", { className: "zc-button zc-secondary", href: FORM }, "Formulário de atendimento"));
    });
  }
  function showHandoff() {
    handoff.hidden = false;
    document.getElementById("zc-handoff-title").focus(); // ação da própria pessoa: o foco vai para o formulário pedido
  }
  function send(text, retried) {
    setBusy(true);
    return ensureSession().then(function (session) {
      return request("", "POST", { session: session, message: text });
    }).then(function (j) {
      if ((j.__status === 401) && !retried) { store(""); state.session = ""; return send(text, true); }
      setBusy(false);
      if (j.__status === 503) return showDown(j.fallback && j.fallback.message);
      if (j.__status !== 200) { addMessage("bot", j.__status === 429 ? "Muitas mensagens em pouco tempo. Aguarde um minuto ou escreva para " + EMAIL + "." : "Não consegui responder agora. Tente de novo ou escreva para " + EMAIL + "."); return; }
      addMessage("bot", j.reply);
      renderActions(j.actions);
      if (j.escalation) handoff.hidden = false; // aparece, mas o foco continua no campo de mensagem
      armIdle();
    }).catch(function (j) {
      setBusy(false);
      if (j && j.__status === 503) return showDown(j.fallback && j.fallback.message);
      addMessage("bot", "Não consegui responder agora. Tente de novo ou escreva para " + EMAIL + ".");
    });
  }
  function updateCount() { count.textContent = input.value.length + " de " + MAX + " caracteres"; }

  launch.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  startBtn.addEventListener("click", function () {
    notice.hidden = true; chat.hidden = false; state.started = true;
    addMessage("bot", "Olá! Sou o assistente automático da ZEVANORY. Como posso ajudar?");
    input.focus();
  });
  input.addEventListener("input", updateCount);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true })); }
  });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || state.busy) return;
    if (text.length > MAX) { status.textContent = "A mensagem passou de " + MAX + " caracteres."; return; }
    addMessage("user", text);
    input.value = ""; updateCount();
    send(text);
  });
  humanBtn.addEventListener("click", showHandoff);
  handoffCancel.addEventListener("click", function () { handoff.hidden = true; input.focus(); });
  extendBtn.addEventListener("click", function () {
    if (state.session) request("/session", "POST", { renew: state.session }).catch(function () {});
    armIdle(); input.focus();
  });
  handoff.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = emailInput.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { emailError.textContent = "Digite um e-mail válido, como nome@exemplo.com.br."; emailInput.setAttribute("aria-invalid", "true"); emailInput.focus(); return; }
    emailError.textContent = ""; emailInput.removeAttribute("aria-invalid");
    setBusy(true);
    ensureSession().then(function (session) { return request("/handoff", "POST", { session: session, email: v }); }).then(function (j) {
      setBusy(false);
      if (j.__status === 503) return showDown(j.fallback && j.fallback.message);
      if (j.__status !== 200) { emailError.textContent = j.__status === 429 ? "Muitos pedidos hoje. Escreva para " + EMAIL + "." : "Não foi possível agora. Escreva para " + EMAIL + "."; return; }
      handoff.hidden = true;
      addMessage("bot", j.reply);
      renderActions(j.actions);
      input.focus();
    }).catch(function () { setBusy(false); emailError.textContent = "Não foi possível agora. Escreva para " + EMAIL + "."; });
  });
  // Teclado: Esc fecha (sem armadilha); Tab circula dentro do diálogo aberto.
  panel.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    var f = focusables();
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.querySelector("#zc-title"))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
