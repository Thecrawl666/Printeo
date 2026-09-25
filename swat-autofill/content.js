/**
 * content.js (variante extension) — v3.0.0
 * -----------------------------------------------------------------------
 * Toute la logique de remplissage/analyse vit dans core/engine.js (partagé
 * avec la variante userscript, voir userscript/swat-autofill.user.js et
 * README.md). Ce fichier ne fait plus que de la tuyauterie propre à
 * l'extension :
 *   - injecte inject.js dans le contexte de LA PAGE (nécessaire ici
 *     uniquement : un content script vit dans un monde isolé, avec son
 *     propre window.fetch/XMLHttpRequest séparés de ceux de la page React —
 *     voir inject.js) ;
 *   - relaie la progression vers le popup via chrome.runtime.sendMessage ;
 *   - expose window.SwatAutofill.process()/extractIntervenantNames() pour
 *     popup.js (chrome.scripting.executeScript).
 */
(function () {
  function injectSaveWatcher() {
    if (document.getElementById("__swat-inject-marker__")) return;
    try {
      const script = document.createElement("script");
      script.id = "__swat-inject-marker__";
      script.src = chrome.runtime.getURL("inject.js");
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.log("[SWAT Autofill] injectSaveWatcher a échoué :", e);
    }
  }

  function sendProgress(payload) {
    try {
      chrome.runtime.sendMessage({ type: "swat-progress", ...payload });
    } catch (e) {
      // popup peut être fermé, on ignore silencieusement
    }
  }

  async function process(fieldMap, profile, options = {}) {
    injectSaveWatcher();
    return window.SwatEngine.process(fieldMap, profile, { ...options, onProgress: sendProgress });
  }

  function extractIntervenantNames(fieldMap) {
    return window.SwatEngine.extractIntervenantNames(fieldMap);
  }

  window.SwatAutofill = { process, extractIntervenantNames };
})();
