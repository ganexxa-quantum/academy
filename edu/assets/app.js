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

   Consent LGPD (banner) — v4, 2026-08-25 (run 20260825-pixel-fase2):
     - O banner NÃO é portão de nada. Nem da nossa medição (v3), nem do pixel
       do X (v4). Todo evento carrega `context.consent` com um de três valores:
       "granted" | "denied" | "unknown" (ainda não decidiu).
     - O PIXEL DO X DISPARA SEMPRE. Reversão explícita do Bruno em 25/ago:
       "dispare o Pixel, o banner com o aceite é uma questão de conformidade, se
       não tivermos o aceite, depois de um prazo… os dados serão excluídos. O
       tráfego veio do X… precisamos dos dados para provar ou desprovar as
       hipóteses." O banner deixou de decidir SE o dado existe e passou a
       decidir POR QUANTO TEMPO ele existe: quem não aceitou é expurgado depois
       de RETENTION_DAYS (job em cdp/retention/, N num só lugar).
       [PROVISÓRIO até orientação jurídica — o desenho é do Bruno, com risco
        declarado no relatório: pixel sem consentimento é transferência a
        terceiro, e o expurgo mitiga a retenção, não a transferência.]
     - Nada NOSSO é gravado no dispositivo de quem não aceitou: o anonymous_id
       só é PERSISTIDO após o "aceitar" (ver anonId/persistAnonId). O que o
       script do X grava é do X, e a política diz isso com todas as letras.
     - O e-mail do form segue independente do banner: o próprio envio é o opt-in.

   FASE 2 — eventos comportamentais, 2026-08-25 (mesma run):
     tempo engajado (relógio para com a aba oculta), scroll_depth, section_view,
     form_view, form_focus, field_abandon, cta_click, dead_click e page_exit.
     Marcos saem na hora; o page_exit vai por sendBeacon com o write-key no
     CORPO. Detalhe e motivação no bloco "FASE 2" lá embaixo.

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
    var out = { utm_source: "", utm_medium: "", utm_campaign: "", twclid: "" };
    try {
      var q = (window.location.search || "").replace(/^\?/, "");
      if (!q) return out;
      var parts = q.split("&");
      for (var i = 0; i < parts.length; i++) {
        var eq = parts[i].indexOf("=");
        if (eq < 0) continue;
        var k = decodeURIComponent(parts[i].slice(0, eq).replace(/\+/g, " "));
        if (k !== "utm_source" && k !== "utm_medium" && k !== "utm_campaign" && k !== "twclid") continue;
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
      campaign: { source: utm.utm_source, medium: utm.utm_medium, name: utm.utm_campaign, twclid: utm.twclid },
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
  // v3: memoizado no escopo do IIFE e NÃO gravado no dispositivo antes do
  // "aceitar". Duas razões, nesta ordem:
  //   1. Com o page_view desgateado, gravar o id no load faria a LP escrever no
  //      aparelho de quem ainda não decidiu (e de quem recusou) — coisa que a
  //      política de privacidade afirma hoje que NÃO acontece antes do banner.
  //      Sem persistir, a promessa continua verdadeira e o evento continua
  //      existindo com a flag: duas visitas de um recusante não se ligam.
  //   2. A memoização conserta um bug silencioso anterior: com localStorage
  //      bloqueado (Caminho C), cada chamada gerava um id NOVO — page_view e
  //      lead da MESMA visita chegavam como duas pessoas.
  var aidMemo = null;
  function anonId() {
    if (aidMemo) return aidMemo;
    var id = lsGet(ANON_KEY);
    if (!id) {
      id = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : "aid-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      // só grava se a pessoa JÁ aceitou numa visita anterior
      if (lsGet(CONSENT_KEY) === "granted") lsSet(ANON_KEY, id);
    }
    aidMemo = id;
    return aidMemo;
  }

  // Grava o id no dispositivo. Chamado UMA vez: no clique em "aceitar".
  function persistAnonId() {
    lsSet(ANON_KEY, anonId());
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
          name: utm.utm_campaign,
          twclid: utm.twclid
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

  // page = sinal de visita first-party. v3: SEM GATE — dispara sempre, e o
  // estado do consentimento viaja no envelope (`context.consent`, via
  // baseEvent → consentState()). Era este `return` que fazia o funil inteiro
  // ser invisível: ~93% de quem chega não responde o banner, então o registro
  // media quem aceitava, não quem chegava.
  function cdpPage() {
    if (isPlaceholder(cfg.cdp) || isPlaceholder(cfg.cdpKey)) return;
    var evt = baseEvent("page");
    evt.event = "page_view";
    evt.properties = { source: cfg.cell };
    postCdp(evt).catch(function () { /* sinal secundário: falha silenciosa */ });
  }

  // ---------- pixel slot (v4: SEM GATE — a flag registra, não bloqueia) -------
  // Reversão explícita do Bruno em 2026-08-25: "dispare o Pixel, o banner com o
  // aceite é uma questão de conformidade… o tráfego veio do X… precisamos dos
  // dados para provar ou desprovar as hipóteses". O que era gate virou prazo: o
  // `consent_choice` continua sendo registrado, e quem não aceitou tem os dados
  // expurgados depois de RETENTION_DAYS (cdp/retention/). O banner deixou de
  // decidir SE o dado existe e passou a decidir POR QUANTO TEMPO.
  function initPixel() {
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
    if (isPlaceholder(cfg.pixel) || !window.twq) return;
    window.twq("event", "tw-" + cfg.pixel + "-lead", {
      conversion_id: cfg.cell,
      description: "lead|source=" + cfg.cell
    });
  }

  // O ATO de responder o banner vira registro próprio, com o valor NOVO na
  // flag. Sem ele, o page_view do primeiro load ficaria `unknown` para sempre e
  // a resposta da pessoa não existiria em lugar nenhum — que é exatamente o que
  // o pedido ("saber se a pessoa aceitou ou não") manda existir.
  function cdpConsentChoice() {
    if (isPlaceholder(cfg.cdp) || isPlaceholder(cfg.cdpKey)) return;
    var evt = baseEvent("track");
    evt.event = "consent_choice";
    evt.properties = { source: cfg.cell, choice: consentState() };
    postCdp(evt).catch(function () { /* sinal secundário: falha silenciosa */ });
  }

  // ---------- consent banner (gateia SÓ o pixel; registra a escolha) ------
  function initConsent() {
    var banner = document.getElementById("consent-banner");
    var accept = document.getElementById("consent-accept");
    var reject = document.getElementById("consent-reject");

    // v4: o pixel NÃO passa mais por aqui — ele sobe no boot, para todo mundo.
    // Esta função ficou com uma responsabilidade só: perguntar uma vez e
    // registrar a resposta. Quem já respondeu (aceitou ou recusou) não é
    // re-perguntado.
    var choice = consentState();
    if (choice === "granted" || choice === "denied") return;

    // Sem escolha ainda: mostra o banner (se existir markup) e espera decisão.
    if (!banner || !accept || !reject) return;
    banner.hidden = false;
    banner.setAttribute("aria-hidden", "false");
    // move o foco pro banner (acessibilidade)
    try { accept.focus(); } catch (e) { /* no-op */ }

    accept.addEventListener("click", function () {
      lsSet(CONSENT_KEY, "granted");
      persistAnonId();       // a partir daqui o id pode viver no dispositivo
      banner.hidden = true;
      banner.setAttribute("aria-hidden", "true");
      cdpConsentChoice();    // registra "granted" na flag: sem prazo de expurgo
    });
    reject.addEventListener("click", function () {
      lsSet(CONSENT_KEY, "denied");
      banner.hidden = true;
      banner.setAttribute("aria-hidden", "true");
      // v4: a recusa não apaga o pixel — ela liga o relógio. O registro é
      // nosso, first-party, e é o que o job de expurgo lê para excluir os dados
      // desta pessoa depois de RETENTION_DAYS.
      cdpConsentChoice();
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
          try { F2.formSubmitted = true; } catch (e2) { /* no-op */ }
          form.reset();
          pixelLead(); // v4: conversão no pixel sempre — a flag viaja no nosso registro
        })
        .catch(function () {
          showMsg("err");
        });
    });
  }


  // ============================================================
  // FASE 2 — eventos comportamentais (2026-08-25, run 20260825-pixel-fase2)
  //
  // A pergunta que este bloco existe para responder: de quem chega e NÃO
  // converte, quantos leram a página inteira e decidiram não dar o e-mail
  // (problema de OFERTA) e quantos saíram antes de chegar no formulário
  // (problema de ANÚNCIO mal casado)? São remédios opostos, e hoje os dois
  // aparecem no relatório como o mesmo "não converteu".
  //
  // Três regras de desenho, porque medir mal é pior que não medir:
  //   1. TEMPO ENGAJADO, não tempo de aba aberta. O relógio para quando a aba
  //      fica oculta (visibilitychange). Sem isso, quem abre e esquece aberto
  //      vira "leitor dedicado" e envenena a mediana.
  //   2. MARCOS + EXIT, não só exit. O `page_exit` é o evento mais rico e o
  //      mais fácil de perder (aba morta pelo SO, bateria, crash). Cada marco
  //      (5/15/30/60s, 25/50/75/100%) sai na hora em que acontece, então quem
  //      sai sem exit ainda deixa rastro do quanto leu.
  //   3. AGREGAÇÃO NO CLIENTE. Nada de um evento por pixel rolado: o teto por
  //      visita é ~20 eventos, e o dwell por seção viaja num mapa único dentro
  //      do page_exit.
  //
  // Nenhum identificador novo, nenhum fingerprint, nenhum conteúdo digitado:
  // do campo de e-mail só viajam DUAS coisas — se tinha texto e quantos
  // caracteres. O envelope é o mesmo (baseEvent), então `context.consent`
  // carrega a flag em todos eles, como em todo o resto.
  // ============================================================

  function now() {
    try { return Date.now(); } catch (e) { return (new Date()).getTime(); }
  }

  var F2 = {
    on: false,
    engagedMs: 0,
    lastTick: 0,
    visible: true,
    maxDepth: 0,
    depthSent: {},        // "25" -> true
    timeSent: {},         // "5"  -> true
    sections: {},         // name -> { ms: n, since: n|null, seen: bool }
    order: [],            // ordem de declaração das seções (p/ o relatório)
    formSeen: false,
    formFocused: false,
    formSubmitted: false,
    abandonSent: false,
    deadClicks: 0,
    exits: 0,
    armed: true,   // ver pageExit(): pagehide E visibilitychange disparam na MESMA saída
    ioUsed: false
  };

  // Marcos em UM lugar só: mexer aqui muda evento, relatório e consulta juntos.
  var TIME_MARKS = [5, 15, 30, 60];
  var DEPTH_MARKS = [25, 50, 75, 100];
  var MAX_EXITS = 2;        // 1º hidden + um final se a pessoa voltou e saiu de novo
  var MAX_DEAD_CLICKS = 3;  // teto de ruído por visita

  // ---------- track: mesmo envelope, transporte da página ----------
  function cdpTrack(name, props) {
    if (isPlaceholder(cfg.cdp) || isPlaceholder(cfg.cdpKey)) return;
    var evt = baseEvent("track");
    evt.event = name;
    evt.properties = props || {};
    evt.properties.source = cfg.cell;
    try {
      postCdp(evt).catch(function () { /* sinal secundário: falha silenciosa */ });
    } catch (e) { /* engine sem Promise: o evento se perde, a página não */ }
  }

  // ---------- exit: sendBeacon, porque fetch NÃO sobrevive ao unload --------
  // O write-key viaja no CORPO (`writeKey`), não no header: sendBeacon não
  // aceita headers. O collector já lê os dois caminhos
  // (`x-write-key` OU `body.writeKey`, server.ts), então isto não exige deploy
  // nenhum do servidor. text/plain é content-type CORS-safelisted => sem
  // preflight, e o preflight é justamente o que não existe no unload.
  function cdpBeacon(name, props) {
    if (isPlaceholder(cfg.cdp) || isPlaceholder(cfg.cdpKey)) return "none";
    var evt = baseEvent("track");
    evt.event = name;
    evt.properties = props || {};
    evt.properties.source = cfg.cell;
    evt.writeKey = cfg.cdpKey;   // não é persistido: o row só lê properties/context
    var j;
    try { j = JSON.stringify(evt); } catch (e) { return "none"; }
    try {
      if (navigator && typeof navigator.sendBeacon === "function" && navigator.sendBeacon(cfg.cdp, j)) return "beacon";
    } catch (e) { /* degrau seguinte */ }
    try {
      if (typeof XMLHttpRequest !== "undefined") {
        var x = new XMLHttpRequest();
        x.open("POST", cfg.cdp, true);
        x.setRequestHeader("Content-Type", "text/plain;charset=UTF-8");
        x.send(j);
        return "xhr";
      }
    } catch (e) { /* no-op */ }
    return "none";
  }

  // ---------- relógio: só conta com a aba visível ----------
  function tick() {
    var n = now();
    if (F2.visible) F2.engagedMs += (n - F2.lastTick);
    F2.lastTick = n;
  }

  function engagedSec() {
    return Math.round(F2.engagedMs / 1000);
  }

  // ---------- profundidade de rolagem ----------
  // Página que cabe inteira na tela = 100% lida por definição; sem esta linha
  // ela ficaria eternamente em 0% e pareceria a pior página do funil.
  function depthPct() {
    try {
      var doc = document.documentElement, b = document.body;
      var top = window.pageYOffset || doc.scrollTop || b.scrollTop || 0;
      var vh = window.innerHeight || doc.clientHeight || 0;
      var h = Math.max(b.scrollHeight || 0, doc.scrollHeight || 0, b.offsetHeight || 0, doc.offsetHeight || 0);
      if (h <= vh || !h) return 100;
      var p = Math.round(((top + vh) / h) * 100);
      return p < 0 ? 0 : (p > 100 ? 100 : p);
    } catch (e) { return 0; }
  }

  function checkDepth() {
    var p = depthPct();
    if (p > F2.maxDepth) F2.maxDepth = p;
    for (var i = 0; i < DEPTH_MARKS.length; i++) {
      var m = DEPTH_MARKS[i];
      if (F2.maxDepth >= m && !F2.depthSent[m]) {
        F2.depthSent[m] = true;
        cdpTrack("scroll_depth", { percent: m, engaged_sec: engagedSec() });
      }
    }
  }

  function checkTime() {
    var s = engagedSec();
    for (var i = 0; i < TIME_MARKS.length; i++) {
      var m = TIME_MARKS[i];
      if (s >= m && !F2.timeSent[m]) {
        F2.timeSent[m] = true;
        cdpTrack("engaged_time", { seconds: m, depth: F2.maxDepth });
      }
    }
  }

  // ---------- seções ----------
  // Nome vem do id quando existe; senão da primeira classe; senão tag+índice.
  // Fica legível na consulta sem exigir que alguém volte no HTML pôr id.
  function sectionName(el, idx) {
    try {
      if (el.id) return el.id;
      var c = (el.className || "").toString().split(/\s+/)[0];
      if (c) return c;
      return (el.tagName || "el").toLowerCase() + "-" + idx;
    } catch (e) { return "el-" + idx; }
  }

  function sectionEls() {
    var out = [];
    try {
      var sel = "header.site-header, main > section, section.disclosure, footer.site-footer";
      var list = document.querySelectorAll(sel);
      for (var i = 0; i < list.length; i++) out.push(list[i]);
    } catch (e) { /* querySelectorAll ausente: sem seções, o resto segue */ }
    return out;
  }

  function sectionEnter(name) {
    var s = F2.sections[name];
    if (!s) return;
    if (s.since != null) return;
    s.since = now();
    if (!s.seen) {
      s.seen = true;
      cdpTrack("section_view", { section: name, engaged_sec: engagedSec(), depth: F2.maxDepth });
    }
  }

  function sectionLeave(name) {
    var s = F2.sections[name];
    if (!s || s.since == null) return;
    // só conta enquanto a aba estava visível: mesma regra do tempo engajado
    if (F2.visible) s.ms += (now() - s.since);
    s.since = null;
  }

  function sectionsSnapshot() {
    var out = {};
    for (var i = 0; i < F2.order.length; i++) {
      var n = F2.order[i], s = F2.sections[n];
      if (!s) continue;
      var ms = s.ms + (s.since != null && F2.visible ? (now() - s.since) : 0);
      if (s.seen) out[n] = Math.round(ms / 1000);
    }
    return out;
  }

  // ---------- o evento mais importante: a pessoa VIU a área do e-mail? -----
  function formView(via) {
    if (F2.formSeen) return;
    F2.formSeen = true;
    cdpTrack("form_view", { engaged_sec: engagedSec(), depth: F2.maxDepth, via: via });
  }

  // Fallback sem IntersectionObserver: mede o retângulo do form no scroll.
  function formVisibleByRect(el) {
    try {
      var r = el.getBoundingClientRect();
      var vh = window.innerHeight || document.documentElement.clientHeight || 0;
      // metade do bloco dentro da viewport = "viu", mesmo critério do IO abaixo
      var visible = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      return visible > 0 && visible >= Math.min(r.height, vh) * 0.5;
    } catch (e) { return false; }
  }

  // ---------- saída ----------
  function pageExit(reason) {
    // `pagehide` e `visibilitychange->hidden` disparam os DOIS na mesma saída
    // (medido: dois page_exit no mesmo segundo, payload idêntico, seq 1 e 2).
    // O contador sozinho não separava "saiu duas vezes" de "dois handlers da
    // mesma saída" — quem separa é o rearme, que só acontece quando a aba volta
    // a ficar visível. Sem isto, "voltou e leu mais" e "o browser tem dois
    // eventos de unload" viravam a mesma linha no relatório.
    if (!F2.armed) return;
    if (F2.exits >= MAX_EXITS) return;
    F2.armed = false;
    tick();
    checkDepth();
    for (var i = 0; i < F2.order.length; i++) sectionLeave(F2.order[i]);
    // e-mail focado e nunca enviado também é abandono — o blur pode nunca vir
    if (F2.formFocused && !F2.formSubmitted && !F2.abandonSent) {
      F2.abandonSent = true;
      cdpBeacon("field_abandon", { field: "email", via: "exit" });
    }
    F2.exits++;
    cdpBeacon("page_exit", {
      reason: reason,
      seq: F2.exits,                 // >1 = a pessoa voltou e saiu de novo; vale o MAIOR seq
      engaged_sec: engagedSec(),
      depth: F2.maxDepth,
      sections: sectionsSnapshot(),
      form_view: F2.formSeen,
      form_focus: F2.formFocused,
      submitted: F2.formSubmitted,
      dead_clicks: F2.deadClicks,
      io: F2.ioUsed
    });
    // se voltar e sair outra vez, o próximo exit sai atualizado (até MAX_EXITS)
  }

  function initPhase2() {
    if (isPlaceholder(cfg.cdp) || isPlaceholder(cfg.cdpKey)) return;
    F2.on = true;
    F2.lastTick = now();
    try { F2.visible = !document.hidden; } catch (e) { F2.visible = true; }

    // --- seções ---
    var els = sectionEls();
    for (var i = 0; i < els.length; i++) {
      var n = sectionName(els[i], i);
      if (F2.sections[n]) n = n + "-" + i;   // nome repetido não pode fundir dwell
      F2.sections[n] = { ms: 0, since: null, seen: false };
      F2.order.push(n);
      try { els[i].setAttribute("data-sec", n); } catch (e) { /* no-op */ }
    }

    var form = document.getElementById("capture-form");

    if (typeof window.IntersectionObserver !== "undefined") {
      F2.ioUsed = true;
      try {
        var io = new IntersectionObserver(function (entries) {
          for (var k = 0; k < entries.length; k++) {
            var e = entries[k];
            var nm = e.target.getAttribute("data-sec");
            if (!nm) continue;
            if (e.isIntersecting) sectionEnter(nm); else sectionLeave(nm);
          }
        }, { threshold: 0.25 });
        for (var j = 0; j < els.length; j++) io.observe(els[j]);
      } catch (e) { F2.ioUsed = false; }

      if (form) {
        try {
          var ioF = new IntersectionObserver(function (entries) {
            for (var k2 = 0; k2 < entries.length; k2++) {
              if (entries[k2].isIntersecting) { formView("io"); }
            }
          }, { threshold: 0.5 });
          ioF.observe(form);
        } catch (e) { /* cai no fallback de rect abaixo */ }
      }
    }

    // --- scroll (throttle por flag: um cálculo por frame, no máximo) ---
    var pending = false;
    function onScroll() {
      if (pending) return;
      pending = true;
      var run = function () {
        pending = false;
        tick();
        checkDepth();
        if (form && !F2.formSeen && !F2.ioUsed && formVisibleByRect(form)) formView("rect");
      };
      if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(run);
      else setTimeout(run, 100);
    }
    try {
      window.addEventListener("scroll", onScroll, false);
      window.addEventListener("resize", onScroll, false);
    } catch (e) { /* no-op */ }

    // --- relógio de 1s: marcos de tempo + reavaliação barata ---
    try {
      setInterval(function () {
        tick();
        checkTime();
        // primeira dobra já contém o form em telas grandes: sem scroll nenhum,
        // o IO resolve; sem IO, esta batida resolve.
        if (form && !F2.formSeen && !F2.ioUsed && formVisibleByRect(form)) formView("rect");
      }, 1000);
    } catch (e) { /* no-op */ }

    // --- visibilidade: é isto que separa "leu" de "deixou aberto" ---
    try {
      document.addEventListener("visibilitychange", function () {
        tick();
        var hidden = !!document.hidden;
        if (hidden) {
          for (var q = 0; q < F2.order.length; q++) sectionLeave(F2.order[q]);
          F2.visible = false;
          pageExit("hidden");
        } else {
          F2.visible = true;
          F2.lastTick = now();
          F2.armed = true;   // voltou: um próximo exit é uma saída DE VERDADE
          checkDepth();
        }
      }, false);
    } catch (e) { /* no-op */ }

    // pagehide cobre o desktop/Safari onde visibilitychange pode não vir
    try { window.addEventListener("pagehide", function () { pageExit("pagehide"); }, false); } catch (e) { /* no-op */ }

    // --- formulário: ver, focar, desistir ---
    if (form) {
      var email = document.getElementById("email");
      if (email) {
        try {
          email.addEventListener("focus", function () {
            if (!F2.formFocused) {
              F2.formFocused = true;
              formView("focus");   // focar É ter visto
              cdpTrack("form_focus", { field: "email", engaged_sec: engagedSec(), depth: F2.maxDepth });
            }
          }, false);
          // blur também dispara no clique do submit: 500ms decidem qual dos dois foi
          email.addEventListener("blur", function () {
            setTimeout(function () {
              if (F2.formSubmitted || F2.abandonSent) return;
              F2.abandonSent = true;
              var v = "";
              try { v = email.value || ""; } catch (e) { v = ""; }
              // NUNCA o conteúdo: só se havia texto e o tamanho
              cdpTrack("field_abandon", { field: "email", had_value: !!v, len: v.length, via: "blur" });
            }, 500);
          }, false);
        } catch (e) { /* no-op */ }
      }
    }

    // --- cliques: CTA e clique morto ---
    try {
      document.addEventListener("click", function (ev) {
        var t = ev.target || ev.srcElement;
        var el = t, hops = 0, hit = null;
        while (el && hops < 6) {
          var tag = (el.tagName || "").toLowerCase();
          if (tag === "a" || tag === "button" || tag === "input" || tag === "label" || tag === "select" || tag === "textarea") { hit = el; break; }
          el = el.parentNode; hops++;
        }
        if (hit) {
          var label = "";
          try { label = (hit.getAttribute("id") || hit.textContent || "").toString().replace(/\s+/g, " ").slice(0, 40); } catch (e) { label = ""; }
          var href = "";
          try { href = (hit.getAttribute("href") || "").slice(0, 120); } catch (e) { href = ""; }
          cdpTrack("cta_click", { label: label, href: href, engaged_sec: engagedSec(), depth: F2.maxDepth });
          return;
        }
        // clique morto: onde a pessoa achou que havia botão e não havia
        if (F2.deadClicks >= MAX_DEAD_CLICKS) return;
        F2.deadClicks++;
        var tt = "", cc = "";
        try { tt = ((t && t.tagName) || "").toLowerCase(); } catch (e) { /* no-op */ }
        try { cc = ((t && t.className) || "").toString().slice(0, 40); } catch (e) { /* no-op */ }
        cdpTrack("dead_click", { tag: tt, cls: cc, depth: F2.maxDepth, engaged_sec: engagedSec() });
      }, false);
    } catch (e) { /* no-op */ }

    // primeira medição imediata: quem não rola nada ainda produz um número
    tick();
    checkDepth();
    if (form && !F2.ioUsed && formVisibleByRect(form)) formView("rect-boot");
  }

  // ---------- boot ----------
  // v3: o page_view do NOSSO CDP roda sempre (com a flag); o consentimento
  // decide só o pixel do X.
  // v2: cada peça no seu próprio try/catch. Antes, um throw em qualquer uma
  // levava as outras duas junto — foi assim que o Caminho B apagou o form E o
  // banner E o contador de uma vez só.
  try { initTelegram(); } catch (e) { /* no-op */ }
  try { initForm(); } catch (e) { /* no-op */ }
  try { cdpPage(); } catch (e) { /* no-op */ }     // visita registrada SEMPRE, com a flag
  try { initPixel(); } catch (e) { /* no-op */ }   // v4: pixel do X para todo mundo (a flag registra, não bloqueia)
  try { initConsent(); } catch (e) { /* no-op */ } // pergunta uma vez e registra a resposta
  try { initPhase2(); } catch (e) { /* no-op */ }  // Fase 2: tempo engajado, profundidade, form_view, exit
})();
