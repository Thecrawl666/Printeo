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
  /**
   * Injecte inject.js et ATTEND qu'il ait fini de charger (donc posé son
   * marqueur `data-swat-fetch-bridge` sur le DOM, cf inject.js) avant de
   * rendre la main — indispensable depuis que core/engine.js s'appuie sur
   * ce marqueur pour savoir si le pont réseau est disponible : sans cette
   * attente, un remplissage qui atteint l'étape Workload très vite (peu de
   * champs avant, éditeurs désactivés) pourrait la manquer et retomber, à
   * tort, sur un fetch() direct (donc sur le bug 403 que ce pont vise
   * justement à contourner). Timeout de sécurité (2s) : si le script ne
   * charge jamais pour une raison quelconque, on continue quand même —
   * fetchJson retombera simplement sur un fetch() direct.
   */
  function injectSaveWatcher() {
    if (document.getElementById("__swat-inject-marker__")) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      try {
        const script = document.createElement("script");
        script.id = "__swat-inject-marker__";
        script.src = chrome.runtime.getURL("inject.js");
        script.onload = () => {
          script.remove();
          finish();
        };
        script.onerror = finish;
        (document.head || document.documentElement).appendChild(script);
        setTimeout(finish, 2000);
      } catch (e) {
        console.log("[SWAT Autofill] injectSaveWatcher a échoué :", e);
        finish();
      }
    });
  }

  function sendProgress(payload) {
    try {
      chrome.runtime.sendMessage({ type: "swat-progress", ...payload });
    } catch (e) {
      // popup peut être fermé, on ignore silencieusement
    }
  }

  async function process(fieldMap, profile, options = {}) {
    await injectSaveWatcher();
    return window.SwatEngine.process(fieldMap, profile, { ...options, onProgress: sendProgress });
  }

  function extractIntervenantNames(fieldMap) {
    return window.SwatEngine.extractIntervenantNames(fieldMap);
  }

  window.SwatAutofill = { process, extractIntervenantNames };
})();
