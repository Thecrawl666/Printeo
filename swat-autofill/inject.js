/**
 * inject.js
 * -----------------------------------------------------------------------
 * S'exécute dans le contexte de LA PAGE elle-même (injecté via une balise
 * <script src="..."> par content.js), PAS dans le "monde isolé" du content
 * script. Indispensable UNIQUEMENT pour la variante extension : un content
 * script classique a son PROPRE window.fetch/XMLHttpRequest, séparés de
 * ceux utilisés par l'application React de Swatsheet — intercepter
 * fetch/XHR depuis le content script ne voit donc jamais les vrais appels
 * réseau de la page (historique complet : voir README.md / CHANGELOG.md,
 * v2.6.0-v2.7.0).
 *
 * La variante userscript (userscript/swat-autofill.user.js, `@grant none`)
 * N'A PAS BESOIN de ce fichier : elle vit déjà dans le contexte de la page,
 * donc core/engine.js peut y installer directement son propre intercepteur
 * (voir installSaveWatcher() dans core/engine.js) sans pont DOM.
 *
 * Deux rôles, tous les deux par pont d'évènements DOM (le seul canal
 * partagé entre le "monde isolé" du content script et le contexte JS de
 * la page — ce sont deux `window` distincts malgré le même DOM) :
 *
 * 1. Annoncer qu'un PUT .../reviewandapprove/update a répondu 200 — lu par
 *    core/engine.js (waitForSave()), dans les deux variantes.
 * 2. v3.2.0 — PONT RÉSEAU pour la création de Workload (voir §"pont fetch"
 *    plus bas) : exécute les appels réseau demandés par core/engine.js
 *    DIRECTEMENT dans le contexte de la page, plutôt que depuis le monde
 *    isolé du content script. Piste concrète pour l'erreur 403 persistante
 *    sur `GET /api/swatsheet/parent/{code}/parentId` (voir CHANGELOG.md) :
 *    ce même appel réussit de façon fiable quand c'est le JS de LA PAGE qui
 *    l'exécute, jamais quand c'est le content script — deux en-têtes
 *    différents ont déjà été essayés sans succès (X-Requested-With,
 *    credentials explicites), donc plutôt que de deviner encore un
 *    en-tête, on fait exécuter l'appel par un contexte JS identique à celui
 *    de la page elle-même, qui a toujours réussi.
 */
(function () {
  if (window.__swatSaveInterceptorInstalled) return;
  window.__swatSaveInterceptorInstalled = true;

  const SAVE_URL_RE = /\/api\/swatsheet\/reviewandapprove\/update/i;

  function announce(ok) {
    document.dispatchEvent(new CustomEvent("swat-autofill-save-detected", { detail: { ok: !!ok, ts: Date.now() } }));
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args) {
      const req = args[0];
      const url = typeof req === "string" ? req : (req && req.url) || "";
      const method = ((args[1] && args[1].method) || (req && req.method) || "GET").toUpperCase();
      const result = origFetch.apply(this, args);
      if (method === "PUT" && SAVE_URL_RE.test(url)) {
        result.then((res) => announce(res && res.ok)).catch(() => announce(false));
      }
      return result;
    };
  }

  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function (method, url, ...rest) {
      this.__swatMethod = (method || "").toUpperCase();
      this.__swatUrl = url || "";
      return origOpen.call(this, method, url, ...rest);
    };
    OrigXHR.prototype.send = function (...args) {
      if (this.__swatMethod === "PUT" && SAVE_URL_RE.test(this.__swatUrl)) {
        this.addEventListener("loadend", () => announce(this.status >= 200 && this.status < 300));
      }
      return origSend.apply(this, args);
    };
  }

  // -----------------------------------------------------------------------
  // Pont fetch — exécute un fetch() demandé par core/engine.js (monde isolé)
  // ICI, dans le contexte de la page. `window.fetch` référencé ci-dessous
  // EST déjà celui, potentiellement instrumenté juste au-dessus par ce même
  // fichier (le PUT de sauvegarde reste observable même pour un appel émis
  // via ce pont) — mais ce n'est de toute façon jamais le cas ici, ce pont
  // ne sert qu'aux GET/POST de résolution/création du Workload.
  //
  // Protocole (CustomEvent — seul canal traversant la frontière des deux
  // "window" distincts, cf commentaire en tête de fichier) :
  //   demande  : "swat-autofill-fetch-request"  { id, url, options }
  //   réponse  : "swat-autofill-fetch-response" { id, ok, status, text }
  //                                        ou    { id, ok:false, error }
  //
  // `document.documentElement` porte un attribut marqueur, posé de façon
  // synchrone ci-dessous — c'est le seul moyen fiable pour core/engine.js
  // (autre "window") de savoir que ce pont est bien en place avant de s'en
  // servir, puisqu'un flag posé sur `window` ici ne serait PAS visible de
  // l'autre côté (deux objets globaux distincts malgré le DOM partagé).
  // -----------------------------------------------------------------------
  document.addEventListener("swat-autofill-fetch-request", async (e) => {
    const { id, url, options } = (e && e.detail) || {};
    if (!id) return;
    try {
      const res = await window.fetch(url, options);
      const text = await res.text();
      document.dispatchEvent(
        new CustomEvent("swat-autofill-fetch-response", { detail: { id, ok: true, status: res.status, text } })
      );
    } catch (err) {
      document.dispatchEvent(
        new CustomEvent("swat-autofill-fetch-response", { detail: { id, ok: false, error: String((err && err.message) || err) } })
      );
    }
  });
  document.documentElement.setAttribute("data-swat-fetch-bridge", "1");
})();
