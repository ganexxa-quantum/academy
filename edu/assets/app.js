/* ============================================================
   Ganexxa — first-step LP — shared behavior (pt/en/es)
   [default — Bruno confirma se já há curva pública] a LP usa
   {{LIVE_START_DATE}} no teaser; nenhum dado live é buscado.
   [confirmado — Bruno 2026-08-08] host estático (GitHub Pages), sem backend: o form
   posta pro mini-CDP em {{CDP_ENDPOINT}} (placeholder até o
   deploy); pixel só ativa quando {{PIXEL_ID}} for substituído.
   Nenhum segredo/ID real neste arquivo — placeholders {{...}}.
   Config por página: atributos data-* no <body>.
   CSP-safe: sem handlers inline, sem eval, sem CDN.
   ============================================================ */

(function () {
  "use strict";

  var body = document.body;
  var cfg = {
    cell: body.getAttribute("data-cell") || "firststep-unknown",
    cdp: body.getAttribute("data-cdp") || "",
    pixel: body.getAttribute("data-pixel") || "",
    tg: body.getAttribute("data-tg") || ""
  };

  // Um valor ainda não substituído no deploy ("{{ALGO}}") não é config real.
  function isPlaceholder(v) {
    return !v || /\{\{.*\}\}/.test(v);
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

  // ---------- pixel slot (só ativa com {{PIXEL_ID}} substituído) ----------
  function initPixel() {
    if (isPlaceholder(cfg.pixel)) return; // slot dormente: sem ID, sem request
    // Loader padrão X/Twitter (uwt) — só roda pós-config, nunca no estado placeholder.
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
      // source da célula + UTMs viajam no evento (ISC-19/20)
      description:
        "source=" + cfg.cell +
        "|utm_source=" + utm.utm_source +
        "|utm_medium=" + utm.utm_medium +
        "|utm_campaign=" + utm.utm_campaign
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
      // Failure-mode explícito: endpoint ainda placeholder → não quebra,
      // orienta pro canal alternativo (ISC-34).
      if (isPlaceholder(cfg.cdp)) {
        showMsg("offline");
        return;
      }
      var payload = {
        email: email,
        source: cfg.cell, // firststep-{pt|en|es}-x
        utm_source: utm.utm_source,
        utm_medium: utm.utm_medium,
        utm_campaign: utm.utm_campaign,
        page: window.location.pathname,
        lang: document.documentElement.lang || "",
        ts: new Date().toISOString()
      };
      fetch(cfg.cdp, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          if (!res.ok) throw new Error("cdp " + res.status);
          showMsg("ok");
          form.reset();
          if (!isPlaceholder(cfg.pixel) && window.twq) {
            window.twq("event", "tw-" + cfg.pixel + "-lead", {
              conversion_id: cfg.cell,
              description: "lead|source=" + cfg.cell
            });
          }
        })
        .catch(function () {
          showMsg("err");
        });
    });
  }

  // ---------- boot (nada é buscado no load além do pixel pós-config) ----------
  initTelegram();
  initForm();
  initPixel();
})();
