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

  var CONSENT_KEY = "cdp_consent"; // "granted" | "denied"
  var ANON_KEY = "cdp_aid";

  // Um marcador que sobrou do render (duplo-chave) não é config real.
  function isPlaceholder(v) {
    return !v || /\{\{.*\}\}/.test(v);
  }

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

  // ---------- UTM capture (utm_source / utm_medium / utm_campaign) ----------
  function readUtm() {
    var p = new URLSearchParams(window.location.search);
    return {
      utm_source: p.get("utm_source") || "",
      utm_medium: p.get("utm_medium") || "",
      utm_campaign: p.get("utm_campaign") || ""
    };
  }
  var utm = readUtm();

  function consentState() {
    var c = lsGet(CONSENT_KEY);
    return c === "granted" || c === "denied" ? c : "unknown";
  }

  // ---------- CDP: monta evento Segment-spec e posta ----------
  // Base comum: campos exigidos pelo schema do collector
  // (type, anonymousId, tenant, timestamp) + context (campaign/page/consent).
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
        consent: consentState()
      }
    };
  }

  // Posta pro collector com o write-key no header. Retorna a Promise do fetch.
  function postCdp(evt) {
    var headers = { "Content-Type": "application/json" };
    if (!isPlaceholder(cfg.cdpKey)) headers["x-write-key"] = cfg.cdpKey;
    return fetch(cfg.cdp, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(evt)
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
      lang: document.documentElement.lang || ""
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
  function showMsg(state) {
    ["ok", "err", "offline"].forEach(function (s) {
      var el = document.getElementById("msg-" + s);
      if (el) el.classList.toggle("show", s === state);
    });
  }

  function initForm() {
    var form = document.getElementById("capture-form");
    if (!form) return;
    form.addEventListener("submit", function (ev) {
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
  initTelegram();
  initForm();
  initConsent(); // decide pixel/page-event conforme escolha guardada / banner
})();
