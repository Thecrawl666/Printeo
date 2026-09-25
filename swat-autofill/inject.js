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
 * Ce fichier ne fait qu'annoncer, via un CustomEvent partagé, qu'un
 * PUT .../reviewandapprove/update a répondu 200 — c'est core/engine.js
 * (waitForSave()) qui écoute cet évènement, dans les deux variantes.
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
})();
