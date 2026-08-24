/* ============================================================
   Ganexxa — first-step LP — shared behavior (pt/en/es)
   [confirmado — Bruno 2026-08-08] host estático (GitHub Pages), sem backend.

   Captura first-party via mini-CDP (Cloud Run collector, tenant "ganexxa"):
     - endpoint + write-key públicos de ingestão vêm dos data-* do <body>
       (write-key É chave de ingestão pública, por design first-party — não é
        segredo de infra; o gate real é write-key + CORS de origem no collector).
     - o form monta um evento Segment-spec `identify` (schema-valid) e posta em
       {endpoint} com header x-write-key. E-mail = opt-in deliberado do usuário
       (consentimento do próprio ato de enviar), independe do banner.

   Consent LGPD (banner):
     - o consentimento do FORM cobre só o e-mail. O banner cobre o tracking
       NÃO-essencial: o pixel X (page-view/remarketing) E o evento CDP `page`.
     - initPixel() e o page-event SÓ rodam após "aceitar" explícito; escolha
       persistida em localStorage; "recusar" => nenhum request de tracking.

   Marcadores resolvidos por lp/render.ts a partir de site.config.json:
   PIXEL_ID, TG_INVITE, LIVE_TRACKING_LINE. Um valor vazio OU um marcador não
   resolvido deixam o recurso dormente (ver isPlaceholder). O endpoint/write-key do CDP já estão
   resolvidos (é o trabalho deste passo).

   CSP-safe: sem handlers inline, sem eval, sem CDN (o loader do pixel só é
   inserido pós-consentimento, e só toca static.ads-twitter.com — o host libera).

   ------------------------------------------------------------
   INSTRUMENTAÇÃO v2 — 2026-08-24 (run 20260824-instrumentacao-v2)

   Por que este arquivo mudou. A campanha mediu 319 toques → 2 leads e ninguém
   sabia quantas pessoas chegaram. Três caminhos foram reproduzidos ao vivo e
   cada um perdia o visitante em silêncio:

     Caminho A — engine sem `fetch`: o lead evapora sem UM erro no console.
     Caminho B — `URLSearchParams` no topo do IIFE: o arquivo INTEIRO morre na
                 primeira linha; nem o form, nem o banner, nem o contador rodam.
     Caminho C — `localStorage` bloqueado: o consentimento não persiste e nada
                 lança exceção — nenhum reporter de erro do mundo encontra isso.

   As cinco mudanças, na ordem em que aparecem abaixo:
     1. `readUtm()` sem `URLSearchParams` (parse ES3 manual) + try/catch no boot
        → mata o Caminho B, que é o único que EJETA o usuário para tela de erro.
     2. Camada 2 do contador de chegada (`s=js`) na primeira linha executada do
        IIFE. A Camada 1 é um <img> no HTML, sem JS nenhum; a diferença
        `arrivals(html) − arrivals(js)` É a medição da população sem JavaScript.
     3. `postCdp` com fallback XHR e `preventDefault` CONDICIONAL → mata o
        Caminho A; sem `fetch`+`Promise` o submit nativo segue e o collector
        captura o lead pelo handler urlencoded (D7).
     4. (no <head> do HTML, não aqui) captura de erro inline com escada de
        transporte — um reporter que usa fetch não reporta a falta de fetch.
     5. bloco de ambiente + `caps` em TODO evento: `caps` não infere a hipótese,
        MEDE — cada visita passa a dizer se teria sobrevivido.
   ============================================================ */

(function () {
  "use strict";

  var body = document.body;
  var cfg = {
    cell: body.getAttribute("data-cell") || "firststep-unknown",
    cdp: body.getAttribute("data-cdp") || "",
    cdpKey: body.getAttribute("data-cdp-key") || "",
    cdpTenant: body.getAttribute("data-cdp-tenant") || "",
    pixel: body.getAttribute("data-pixel") || "",
    tg: body.getAttribute("data-tg") || ""
  };
  // Origem do collector derivada do próprio endpoint: uma fonte só, sem
  // atributo novo pra sair de sincronia. ".../e" → "...".
  var cdpOrigin = cfg.cdp.replace(/\/[^\/]*$/, "");

  var CONSENT_KEY = "cdp_consent"; // "granted" | "denied"
  var ANON_KEY = "cdp_aid";

  // Um marcador que sobrou do render (duplo-chave) não é config real.
  function isPlaceholder(v) {
    return !v || /\{\{.*\}\}/.test(v);
  }

  // ---------- escada de transporte (item 3/4: sobrevive à falta de fetch) ----
  // sendBeacon → XHR → new Image(). O último degrau funciona em QUALQUER engine
  // que exista, e é o único que ainda fala quando `fetch` não existe.
  // text/plain de propósito: é content-type CORS-safelisted, então não há
  // preflight — o collector faz o JSON.parse do corpo.
  function ladder(url, payload) {
    var j;
    try { j = JSON.stringify(payload); } catch (e) { j = ""; }
    if (!j) { // engine sem JSON: ainda dá pra contar a chegada, sem o perfil
      try { new Image().src = url + (url.indexOf("?") >= 0 ? "&" : "?") + "nojson=1"; } catch (e2) { /* no-op */ }
      return "image-nojson";
    }
    try {
      if (navigator && typeof navigator.sendBeacon === "function") {
        // string (não Blob): sendBeacon já manda text/plain;charset=UTF-8 e
        // Blob não existe em engine antiga.
        if (navigator.sendBeacon(url, j)) return "beacon";
      }
    } catch (e) { /* segue pro próximo degrau */ }
    try {
      if (typeof XMLHttpRequest !== "undefined") {
        var x = new XMLHttpRequest();
        x.open("POST", url, true);
        x.setRequestHeader("Content-Type", "text/plain;charset=UTF-8");
        x.send(j);
        return "xhr";
      }
    } catch (e) { /* segue pro próximo degrau */ }
    try {
      new Image().src = url + (url.indexOf("?") >= 0 ? "&" : "?") +
        "d=" + encodeURIComponent(j.slice(0, 1200));
      return "image";
    } catch (e) { /* no-op */ }
    return "none";
  }

  // ---------- caps: a hipótese vira campo booleano (item 5) ----------
  // localStorage é sondado por LEITURA, nunca por escrita: o Caminho C faz o
  // próprio ACESSO a window.localStorage lançar, então a leitura já detecta o
  // bloqueio — e assim o contador continua honrando "nada é gravado no
  // dispositivo" antes do banner.
  function caps() {
    var ls = false;
    try { window.localStorage.getItem(ANON_KEY); ls = true; } catch (e) { ls = false; }
    return {
      fetch: typeof window.fetch === "function",
      URLSearchParams: typeof window.URLSearchParams === "function",
      Promise: typeof window.Promise === "function",
      localStorage: ls,
      sendBeacon: !!(navigator && typeof navigator.sendBeacon === "function"),
      XMLHttpRequest: typeof XMLHttpRequest !== "undefined",
      IntersectionObserver: typeof window.IntersectionObserver !== "undefined",
      JSON: typeof JSON !== "undefined" && typeof JSON.stringify === "function"
    };
  }

  // ---------- env: tela, rede e performance REAIS do aparelho (item 5) ------
  function env() {
    var e = {};
    try { e.viewport = (window.innerWidth || 0) + "x" + (window.innerHeight || 0); } catch (x) { /* no-op */ }
    try { e.screen = (window.screen.width || 0) + "x" + (window.screen.height || 0); } catch (x) { /* no-op */ }
    try { e.dpr = window.devicePixelRatio || 1; } catch (x) { /* no-op */ }
    try { e.orientation = (window.innerWidth || 0) >= (window.innerHeight || 0) ? "landscape" : "portrait"; } catch (x) { /* no-op */ }
    try {
      var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      // saveData é o proxy mais próximo de "modo econômico" — a outra metade
      // da hipótese do celular fraco.
      if (c) e.conn = { effectiveType: c.effectiveType || "", rtt: c.rtt || 0, downlink: c.downlink || 0, saveData: !!c.saveData };
    } catch (x) { /* no-op */ }
    try {
      // Performance real por device, no lugar dos 139 ms medidos do nosso lado.
      // O script roda no fim do <body>: loadEventEnd ainda é 0, então só vai o
      // que já aconteceu — 0 aqui significa "ainda não ocorreu", não "instantâneo".
      var n = performance.getEntriesByType("navigation")[0];
      if (n) e.nav_timing = {
        ttfb: Math.round(n.responseStart || 0),
        dom_interactive: Math.round(n.domInteractive || 0),
        dcl: Math.round(n.domContentLoadedEventEnd || 0),
        load: Math.round(n.loadEventEnd || 0),
        nav_type: n.type || ""
      };
    } catch (x) { /* no-op */ }
    return e;
  }

  // ---------- UTM capture — SEM URLSearchParams (item 1) ----------
  // `new URLSearchParams(...)` no topo do IIFE era o Caminho B: numa engine sem
  // ele, este arquivo inteiro morria na primeira linha e a página ejetava o
  // usuário. Parse manual ES3, dentro de try/catch: querystring malformada não
  // pode derrubar a LP.
  function readUtm() {
    var out = { utm_source: "", utm_medium: "", utm_campaign: "" };
    try {
      var q = (window.location.search || "").replace(/^\?/, "");
      if (!q) return out;
      var parts = q.split("&");
      for (var i = 0; i < parts.length; i++) {
        var eq = parts[i].indexOf("=");
        if (eq < 0) continue;
        var k = decodeURIComponent(parts[i].slice(0, eq).replace(/\+/g, " "));
        if (k !== "utm_source" && k !== "utm_medium" && k !== "utm_campaign") continue;
        out[k] = decodeURIComponent(parts[i].slice(eq + 1).replace(/\+/g, " "));
      }
    } catch (e) { /* no-op */ }
    return out;
  }
  var utm = readUtm();

  // ---------- Camada 2 do contador de chegada (item 2) ----------
  // Dispara ANTES de qualquer outra coisa e no seu próprio try/catch: se este
  // hit falhar, ele não pode levar o resto da página junto. A Camada 1 (<img>
  // no HTML) já contou esta mesma chegada com s=html; a diferença entre as duas
  // é a população cujo JavaScript não executou.
  function arrival() {
    if (isPlaceholder(cfg.cdp)) return;
    ladder(cdpOrigin + "/c", {
      s: "js",
      t: cfg.cdpTenant || "ganexxa",
      cell: cfg.cell,
      path: window.location.pathname,
      lang: document.documentElement.lang || "",
      campaign: { source: utm.utm_source, medium: utm.utm_medium, name: utm.utm_campaign },
      env: env(),
      caps: caps()
    });
  }
  try { arrival(); } catch (e) { /* o contador nunca derruba a página */ }

  // ---------- storage helpers (degradam se localStorage bloqueado) ----------
  function lsGet(k) {
    try { return window.localStorage.getItem(k); } catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { window.localStorage.setItem(k, v); } catch (e) { /* no-op */ }
  }

  // ---------- anonymousId first-party (gerado 1×, reusado) ----------
  function anonId() {
    var id = lsGet(ANON_KEY);
    if (!id) {
      id = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : "aid-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      lsSet(ANON_KEY, id);
    }
    return id;
  }

  function consentState() {
    var c = lsGet(CONSENT_KEY);
    return c === "granted" || c === "denied" ? c : "unknown";
  }

  // ---------- CDP: monta evento Segment-spec e posta ----------
  // Base comum: campos exigidos pelo schema do collector
  // (type, anonymousId, tenant, timestamp) + context (campaign/page/consent).
  // v2: env + caps viajam em TODO evento — sem eles, a diferença html−js seria
  // só um número; com eles, ela tem perfil.
  function baseEvent(type) {
    return {
      type: type,
      anonymousId: anonId(),
      tenant: cfg.cdpTenant || "ganexxa",
      timestamp: new Date().toISOString(),
      context: {
        campaign: {
          source: utm.utm_source,
          medium: utm.utm_medium,
          name: utm.utm_campaign
        },
        page: {
          path: window.location.pathname,
          lang: document.documentElement.lang || ""
        },
        locale: document.documentElement.lang || "",
        consent: consentState(),
        env: env(),
        caps: caps()
      }
    };
  }

  // Posta pro collector com o write-key no header. Retorna sempre uma Promise
  // com { ok, status }.
  // v2 (item 3): `fetch` não existe em toda engine que ainda navega — sem este
  // fallback o lead evaporava em silêncio absoluto (Caminho A). O XHR só é
  // montado quando `fetch` falta, então o caminho feliz é idêntico ao anterior.
  function postCdp(evt) {
    var headers = { "Content-Type": "application/json" };
    if (!isPlaceholder(cfg.cdpKey)) headers["x-write-key"] = cfg.cdpKey;
    var payload = JSON.stringify(evt);
    if (typeof window.fetch === "function") {
      return fetch(cfg.cdp, { method: "POST", headers: headers, body: payload });
    }
    return new Promise(function (resolve, reject) {
      try {
        var x = new XMLHttpRequest();
        x.open("POST", cfg.cdp, true);
        x.setRequestHeader("Content-Type", "application/json");
        if (!isPlaceholder(cfg.cdpKey)) x.setRequestHeader("x-write-key", cfg.cdpKey);
        x.onload = function () { resolve({ ok: x.status >= 200 && x.status < 300, status: x.status }); };
        x.onerror = function () { reject(new Error("xhr")); };
        x.send(payload);
      } catch (e) { reject(e); }
    });
  }

  // identify = captura de e-mail (opt-in deliberado). Preserva todos os campos
  // do payload antigo (source/utm/page/lang/ts) no envelope schema-valid.
  function cdpIdentify(email) {
    var evt = baseEvent("identify");
    evt.traits = { email: email };
    evt.properties = {
      source: cfg.cell,
      utm_source: utm.utm_source,
      utm_medium: utm.utm_medium,
      utm_campaign: utm.utm_campaign,
      page: window.location.pathname,
      lang: document.documentElement.lang || "",
      transport: typeof window.fetch === "function" ? "fetch" : "xhr"
    };
    return postCdp(evt);
  }

  // page = sinal de visita first-party. NÃO-essencial => só após consentimento.
  function cdpPage() {
    if (consentState() !== "granted") return; // gate LGPD
    if (isPlaceholder(cfg.cdp) || isPlaceholder(cfg.cdpKey)) return;
    var evt = baseEvent("page");
    evt.event = "page_view";
    evt.properties = { source: cfg.cell };
    postCdp(evt).catch(function () { /* sinal secundário: falha silenciosa */ });
  }

  // ---------- pixel slot (só ativa com consentimento E PIXEL_ID real) ----------
  function initPixel() {
    if (consentState() !== "granted") return; // gate LGPD — sem consent, zero request
    if (isPlaceholder(cfg.pixel)) return;      // slot dormente: sem ID, sem request
    if (window.twq) return;                    // idempotente
    // Loader padrão X/Twitter (uwt) — só roda pós-config + pós-consentimento.
    !(function (e, t, n, s, u, a) {
      e.twq ||
        ((s = e.twq = function () {
          s.exe ? s.exe.apply(s, arguments) : s.queue.push(arguments);
        }),
        (s.version = "1.1"),
        (s.queue = []),
        (u = t.createElement(n)),
        (u.async = !0),
        (u.src = "https://static.ads-twitter.com/uwt.js"),
        (a = t.getElementsByTagName(n)[0]),
        a.parentNode.insertBefore(u, a));
    })(window, document, "script");
    window.twq("config", cfg.pixel);
    window.twq("event", "tw-" + cfg.pixel + "-lp_view", {
      conversion_id: cfg.cell,
      email_address: null,
      description:
        "source=" + cfg.cell +
        "|utm_source=" + utm.utm_source +
        "|utm_medium=" + utm.utm_medium +
        "|utm_campaign=" + utm.utm_campaign
    });
  }

  function pixelLead() {
    if (consentState() !== "granted") return;
    if (isPlaceholder(cfg.pixel) || !window.twq) return;
    window.twq("event", "tw-" + cfg.pixel + "-lead", {
      conversion_id: cfg.cell,
      description: "lead|source=" + cfg.cell
    });
  }

  // Dispara todo o tracking não-essencial (chamado no accept e no load-se-já-aceito).
  function enableTracking() {
    initPixel();
    cdpPage();
  }

  // ---------- consent banner (gateia pixel + page-event) ----------
  function initConsent() {
    var banner = document.getElementById("consent-banner");
    var accept = document.getElementById("consent-accept");
    var reject = document.getElementById("consent-reject");

    var choice = consentState();
    if (choice === "granted") {
      enableTracking();      // revisita com consentimento: liga o tracking, sem re-perguntar
      return;
    }
    if (choice === "denied") {
      return;                // revisita com recusa: nada dispara, sem re-perguntar
    }

    // Sem escolha ainda: mostra o banner (se existir markup) e espera decisão.
    if (!banner || !accept || !reject) return;
    banner.hidden = false;
    banner.setAttribute("aria-hidden", "false");
    // move o foco pro banner (acessibilidade)
    try { accept.focus(); } catch (e) { /* no-op */ }

    accept.addEventListener("click", function () {
      lsSet(CONSENT_KEY, "granted");
      banner.hidden = true;
      banner.setAttribute("aria-hidden", "true");
      enableTracking();
    });
    reject.addEventListener("click", function () {
      lsSet(CONSENT_KEY, "denied");
      banner.hidden = true;
      banner.setAttribute("aria-hidden", "true");
      // recusa: nenhum request de tracking, agora nem em revisitas
    });
  }

  // ---------- Telegram CTA (degrada com placeholder) ----------
  function initTelegram() {
    var link = document.getElementById("tg-link");
    if (!link) return;
    if (isPlaceholder(cfg.tg)) {
      link.setAttribute("href", "#");
      link.setAttribute("aria-disabled", "true");
      link.addEventListener("click", function (ev) { ev.preventDefault(); });
      var soon = document.getElementById("tg-soon");
      if (soon) soon.classList.add("show");
    } else {
      link.setAttribute("href", cfg.tg);
      link.setAttribute("rel", "noopener");
    }
  }

  // ---------- form → mini-CDP ----------
  // for() e não forEach(): Array.prototype.forEach é ES5, e esta função roda
  // justamente nas engines cuja idade estamos medindo.
  function showMsg(state) {
    var states = ["ok", "err", "offline"];
    for (var i = 0; i < states.length; i++) {
      var el = document.getElementById("msg-" + states[i]);
      if (el) {
        if (states[i] === state) el.className = el.className.replace(/\s*\bshow\b/g, "") + " show";
        else el.className = el.className.replace(/\s*\bshow\b/g, "");
      }
    }
  }

  function initForm() {
    var form = document.getElementById("capture-form");
    if (!form) return;

    // Munição para o submit NATIVO (Caminho A: JS roda, mas não há fetch nem
    // XHR nem Promise). Sem isto o POST nativo chega ao collector sem campanha:
    // `referrerpolicy` NÃO é atributo de <form> — medi, o browser ignora e manda
    // só a origem. Com os campos preenchidos aqui, a atribuição é EXATA e nenhum
    // terceiro passa a ver a URL completa.
    try {
      var hid = ["utm_source", "utm_medium", "utm_campaign"];
      for (var hi = 0; hi < hid.length; hi++) {
        var el = document.getElementById(hid[hi]);
        if (el) el.value = utm[hid[hi]] || "";
      }
    } catch (e) { /* no-op */ }

    // Volta do submit NATIVO com erro (?form=email|erro): o collector redireciona
    // de volta pra cá e quem tem JS vê a mensagem. Quem não tem vê o form limpo —
    // limitação aceita e registrada: sem JS não há como pintar mensagem inline.
    try {
      if (/[?&]form=(email|erro)\b/.test(window.location.search)) showMsg("err");
    } catch (e) { /* no-op */ }

    form.addEventListener("submit", function (ev) {
      // preventDefault CONDICIONAL (item 3). Só assumimos o envio quando temos
      // COMO assumir: um transporte (fetch ou XHR) E `Promise`, que o .then/.catch
      // abaixo exige. Faltando qualquer um, o submit nativo segue — e o collector
      // captura o lead pelo handler urlencoded (D7). Antes disso, esta linha
      // cancelava o submit e o lead sumia sem um erro sequer.
      var temTransporte = (typeof window.fetch === "function") || (typeof XMLHttpRequest !== "undefined");
      if (!temTransporte || typeof window.Promise !== "function") return;

      ev.preventDefault();
      var emailEl = document.getElementById("email");
      var email = (emailEl && emailEl.value ? emailEl.value : "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showMsg("err");
        return;
      }
      // Failure-mode explícito: config ainda placeholder => não quebra,
      // orienta pro canal alternativo (Telegram).
      if (isPlaceholder(cfg.cdp) || isPlaceholder(cfg.cdpKey)) {
        showMsg("offline");
        return;
      }
      cdpIdentify(email)
        .then(function (res) {
          if (!res.ok) throw new Error("cdp " + res.status);
          showMsg("ok");
          form.reset();
          pixelLead(); // conversão no pixel só se houve consentimento
        })
        .catch(function () {
          showMsg("err");
        });
    });
  }

  // ---------- boot ----------
  // Nada de tracking é buscado no load além do que o consentimento liberar.
  // v2: cada peça no seu próprio try/catch. Antes, um throw em qualquer uma
  // levava as outras duas junto — foi assim que o Caminho B apagou o form E o
  // banner E o contador de uma vez só.
  try { initTelegram(); } catch (e) { /* no-op */ }
  try { initForm(); } catch (e) { /* no-op */ }
  try { initConsent(); } catch (e) { /* no-op */ } // decide pixel/page-event conforme escolha guardada / banner
})();
