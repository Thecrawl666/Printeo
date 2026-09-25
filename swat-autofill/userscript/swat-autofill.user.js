// ==UserScript==
// @name         SWAT Autofill
// @namespace    swat-autofill
// @version      3.0.0
// @description  Remplissage automatique des formulaires RFC/SWAT (Swatsheet) — panneau flottant, profils JSON embarqués. Généré depuis core/ — ne pas éditer ce fichier à la main, voir tools/build-userscript.mjs.
// @author       Alex Alfonsi
// @match        *://swatsheet.ca.aero.bombardier.net/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
/**
 * SWAT Autofill — variante userscript (Tampermonkey / Violentmonkey)
 * -----------------------------------------------------------------------
 * FICHIER GÉNÉRÉ — ne pas éditer directement (voir tools/build-userscript.mjs).
 * Pour modifier le comportement :
 *   - logique de remplissage/analyse -> core/engine.js
 *   - ciblage DOM / séquence de champs -> core/field-map.json
 *   - valeurs par profil métier -> core/profiles/*.json
 *   - panneau flottant (UI) -> tools/userscript-ui.js
 * puis relancer : node tools/build-userscript.mjs
 *
 * Contrairement à la variante extension, ce script tourne DIRECTEMENT dans
 * le contexte de la page (`@grant none`) : pas de "monde isolé", donc pas
 * besoin d'inject.js ni de pont par CustomEvent pour observer les vrais
 * appels réseau de sauvegarde — core/engine.js les intercepte lui-même.
 */

(function () {
  "use strict";

  /**
 * engine.js — moteur unique de remplissage des swats (v3.0.0)
 * -----------------------------------------------------------------------
 * Ce fichier ne dépend d'AUCUNE API spécifique à une extension (pas de
 * `chrome.*`) : il ne connaît que le DOM de la page. C'est le principe
 * central de la refonte v3 — voir README.md, section "Principe" :
 *
 *   - chargé par un content script d'extension (Chrome/Edge), OU
 *   - chargé directement par un userscript Tampermonkey/Violentmonkey
 *     (`@grant none`, donc DÉJÀ dans le contexte de la page)
 *
 * ...il se comporte à l'identique. Toute la logique de remplissage/analyse
 * vit ICI, une seule fois — les deux "habillages" (extension et userscript)
 * ne sont que de la tuyauterie autour (UI + orchestration de l'injection).
 *
 * Changement de principe n°2 (par rapport à v2.x) : il n'existe plus deux
 * fonctions séparées `run()` et `diagnose()` qui dupliquaient la même
 * logique de repérage de champs avec un risque de désynchronisation (bug
 * réel rencontré en v2.1.1 : le diagnostic ne suivait pas exactement la
 * même règle que le remplissage réel pour un champ optionnel). Il y a
 * maintenant UNE seule fonction `process(fieldMap, profile, options)`,
 * avec `options.dryRun` qui bascule entre "remplir pour de vrai" et
 * "vérifier sans rien modifier". Les deux modes empruntent exactement le
 * même chemin de code pour repérer chaque champ — seule la dernière étape
 * (écrire vs. sonder) diffère, à l'intérieur de chaque "driver" de champ.
 */
(function (root) {
  "use strict";

  // =======================================================================
  // Bas niveau : attente, normalisation, repérage DOM
  // =======================================================================

  const fieldCache = new Map();
  function clearFieldCache() {
    fieldCache.clear();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitFor(conditionFn, timeoutMs = 2000) {
    return new Promise((resolve) => {
      const immediate = conditionFn();
      if (immediate) return resolve(immediate);

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearInterval(pollId);
        clearTimeout(timeoutId);
        resolve(value);
      };

      const observer = new MutationObserver(() => {
        const result = conditionFn();
        if (result) finish(result);
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true
      });

      const pollId = setInterval(() => {
        const result = conditionFn();
        if (result) finish(result);
      }, 50);

      const timeoutId = setTimeout(() => finish(null), timeoutMs);
    });
  }

  function waitForOptions(textToSelect, timeoutMs = 2000) {
    const target = normalizeText(textToSelect);
    return waitFor(() => {
      const options = document.querySelectorAll('li, div[role="option"], .MuiMenuItem-root');
      let partial = null;
      for (const el of options) {
        if (el.offsetHeight <= 0) continue;
        const text = normalizeText(el.innerText);
        if (text === target) return el;
        if (!partial && text.includes(target)) partial = el;
      }
      return partial;
    }, timeoutMs);
  }

  function findOwnFormControl(node) {
    let cur = node;
    for (let i = 0; i < 6 && cur; i++) {
      const inputs = cur.querySelectorAll("input");
      if (inputs.length === 1) return cur;
      cur = cur.parentElement;
    }
    return node.closest(".MuiFormControl-root") || node.parentElement;
  }

  function normalizeText(s) {
    return (s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .trim()
      .toLowerCase();
  }

  function findField(cfg) {
    const cacheKey = cfg.key || cfg.name || cfg.label;
    if (fieldCache.has(cacheKey)) {
      const cached = fieldCache.get(cacheKey);
      if (cached && cached.root.isConnected) return cached;
      fieldCache.delete(cacheKey);
    }

    let root2 = null;

    if (cfg.match === "name" && cfg.name) {
      const input = document.querySelector(`input[name="${CSS.escape(cfg.name)}"]`);
      if (!input) return null;
      root2 = findOwnFormControl(input.parentElement || input);
    } else {
      const labelName = normalizeText(cfg.label);
      const candidates = document.querySelectorAll("label, p, span, div");
      let labelNode = null;
      for (const el of candidates) {
        if (el.childNodes.length === 1 && el.innerText && normalizeText(el.innerText) === labelName) {
          labelNode = el;
          break;
        }
      }
      if (!labelNode) {
        for (const el of candidates) {
          if (el.innerText && normalizeText(el.innerText).includes(labelName)) {
            labelNode = el;
            break;
          }
        }
      }
      if (!labelNode) return null;
      root2 = findOwnFormControl(labelNode);
    }

    const input = root2.querySelector("input");
    const activator =
      root2.querySelector('[role="combobox"], [role="button"], .MuiSelect-select, .MuiInputBase-input') || input;

    if (!input || !activator) return null;

    const field = { root: root2, input, activator };
    fieldCache.set(cacheKey, field);
    return field;
  }

  function setInput(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // =======================================================================
  // Driver "select / autocomplete" — un seul chemin de repérage pour les
  // deux modes ; seule la dernière étape (cliquer vs. refermer sans rien
  // choisir) change selon dryRun.
  // =======================================================================

  async function driveSelect(field, textToSelect, { freeText = false, dryRun = false } = {}) {
    const { input, activator } = field;
    if (!textToSelect) return { ok: true };

    if (input.value && normalizeText(input.value) === normalizeText(textToSelect)) {
      return { ok: true, detail: "déjà à la bonne valeur" };
    }

    activator.focus();
    activator.click();
    activator.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await sleep(dryRun ? 150 : 120);

    if (input.type === "text" || input.getAttribute("role") === "combobox") {
      setInput(input, textToSelect);
      if (!dryRun) input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    }

    if (freeText) {
      if (dryRun) {
        closeMenuWithoutSelecting(input);
        return { ok: true, detail: "champ texte libre — pas de liste à vérifier" };
      }
      await sleep(250);
      document.activeElement.blur();
      document.body.click();
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(150);
      return { ok: true };
    }

    const targetOption = await waitForOptions(textToSelect, dryRun ? 1500 : 2000);

    if (dryRun) {
      closeMenuWithoutSelecting(input);
      return targetOption
        ? { ok: true, detail: `valeur "${textToSelect}" présente dans la liste` }
        : { ok: false, warn: true, detail: `valeur "${textToSelect}" INTROUVABLE dans la liste actuellement affichée` };
    }

    if (!targetOption) {
      document.body.click();
      return { ok: false, detail: `option "${textToSelect}" introuvable dans la liste` };
    }

    targetOption.scrollIntoView({ block: "nearest" });
    targetOption.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    targetOption.click();
    await sleep(150);
    input.dispatchEvent(new Event("change", { bubbles: true }));

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    document.body.click();
    await sleep(150);

    const stillOpenMenu = document.querySelector('[role="listbox"], .MuiAutocomplete-popper');
    if (stillOpenMenu && stillOpenMenu.offsetHeight > 0) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(100);
    }

    return { ok: true };
  }

  function closeMenuWithoutSelecting(input) {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    document.body.click();
  }

  async function extractOptionList(field, timeoutMs = 3000) {
    const { input, activator } = field;
    activator.focus();
    activator.click();
    activator.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await sleep(200);

    const collect = () => {
      const options = document.querySelectorAll('li, div[role="option"], .MuiMenuItem-root');
      const seen = new Set();
      const texts = [];
      for (const el of options) {
        if (el.offsetHeight <= 0) continue;
        const text = (el.innerText || "").trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        texts.push(text);
      }
      return texts;
    };

    const texts = await waitFor(() => {
      const t = collect();
      return t.length ? t : null;
    }, timeoutMs);

    closeMenuWithoutSelecting(input);
    await sleep(150);
    return texts || [];
  }

  // =======================================================================
  // Driver "checkbox" — même historique de bugs que la v2 (cf CHANGELOG) :
  // un seul vrai `input.click()`, jamais de manipulation directe de
  // `.checked` : React attache son onChange à l'évènement natif `click`.
  // =======================================================================

  async function driveCheckbox(name, checked, { dryRun = false } = {}) {
    const input = document.querySelector(`input[type="checkbox"][name="${CSS.escape(name)}"]`);
    if (!input) return { ok: false, detail: `case name="${name}" introuvable` };

    if (dryRun) {
      const state = input.checked ? "cochée" : "décochée";
      return {
        ok: !input.disabled || !checked,
        warn: input.disabled && checked,
        detail: `trouvée, actuellement ${state}${input.disabled ? ", DÉSACTIVÉE à cette étape du workflow" : ""}`
      };
    }

    if (input.disabled) {
      return { ok: false, detail: "case désactivée à cette étape du workflow (prérequis pas encore remplis sur la swat)" };
    }
    if (input.checked === checked) return { ok: true };

    input.click();
    await sleep(150);

    if (input.checked !== checked) {
      return { ok: false, detail: "la case n'a pas basculé après le clic (peut-être verrouillée par une règle métier de la swat)" };
    }
    return { ok: true };
  }

  // =======================================================================
  // Onglets / CKEditor
  // =======================================================================

  async function ensureTab(textIncludes) {
    const tabs = document.querySelectorAll('[role="tab"]');
    let tab = null;
    for (const t of tabs) {
      if (t.innerText && t.innerText.toUpperCase().includes(textIncludes.toUpperCase())) {
        tab = t;
        break;
      }
    }
    if (!tab) return false;
    if (tab.getAttribute("aria-selected") === "true") return true;

    tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    tab.click();

    const switched = await waitFor(() => tab.getAttribute("aria-selected") === "true", 3000);
    await sleep(300);
    return !!switched;
  }

  async function ensureDefinitionTab(tabLabel) {
    const editors = document.querySelectorAll(".ck-editor__editable");
    if (editors.length >= 2) return true;

    const moved = await ensureTab(tabLabel || "DÉFINITION");
    if (!moved) return false;

    const appeared = await waitFor(() => document.querySelectorAll(".ck-editor__editable").length >= 2, 6000);
    await sleep(400);
    return !!appeared;
  }

  function isCKEditorReadOnly(el) {
    return el.getAttribute("contenteditable") === "false" || el.classList.contains("ck-read-only");
  }

  // ---- surveillance réseau de la sauvegarde (généralisée depuis inject.js)

  let saveWatcherInstalled = false;
  function installSaveWatcher(cfg) {
    if (saveWatcherInstalled) return;
    saveWatcherInstalled = true;

    const method = ((cfg && cfg.method) || "PUT").toUpperCase();
    let urlRe;
    try {
      urlRe = new RegExp((cfg && cfg.urlPattern) || "/api/swatsheet/reviewandapprove/update", "i");
    } catch (e) {
      urlRe = /\/api\/swatsheet\/reviewandapprove\/update/i;
    }

    function announce(ok) {
      document.dispatchEvent(new CustomEvent("swat-autofill-save-detected", { detail: { ok: !!ok, ts: Date.now() } }));
    }

    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (...args) {
        const req = args[0];
        const url = typeof req === "string" ? req : (req && req.url) || "";
        const m = ((args[1] && args[1].method) || (req && req.method) || "GET").toUpperCase();
        const result = origFetch.apply(this, args);
        if (m === method && urlRe.test(url)) {
          result.then((res) => announce(res && res.ok)).catch(() => announce(false));
        }
        return result;
      };
    }

    const OrigXHR = window.XMLHttpRequest;
    if (OrigXHR) {
      const origOpen = OrigXHR.prototype.open;
      const origSend = OrigXHR.prototype.send;
      OrigXHR.prototype.open = function (m2, url, ...rest) {
        this.__swatMethod = (m2 || "").toUpperCase();
        this.__swatUrl = url || "";
        return origOpen.call(this, m2, url, ...rest);
      };
      OrigXHR.prototype.send = function (...args) {
        if (this.__swatMethod === method && urlRe.test(this.__swatUrl)) {
          this.addEventListener("loadend", () => announce(this.status >= 200 && this.status < 300));
        }
        return origSend.apply(this, args);
      };
    }
  }

  function waitForSave(timeoutMs = 15000) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        document.removeEventListener("swat-autofill-save-detected", onEvent);
        clearTimeout(timer);
        resolve(value);
      };
      const onEvent = (e) => finish(!!(e.detail && e.detail.ok));
      document.addEventListener("swat-autofill-save-detected", onEvent);
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  /**
   * Driver "éditeur riche" (CKEditor 5). En dryRun : vérifie juste que
   * l'onglet/l'éditeur existent et ne sont pas verrouillés — ne simule
   * JAMAIS de collage, pour rester strictement en lecture seule.
   */
  async function driveRichText(index, html, { dryRun = false, tabLabel } = {}) {
    const tabReady = await ensureDefinitionTab(tabLabel);
    if (!tabReady) {
      return { ok: false, detail: "impossible de basculer sur l'onglet Définition du problème, ou les éditeurs CKEditor n'ont pas fini de charger après 6s" };
    }

    const el = await waitFor(() => document.querySelectorAll(".ck-editor__editable")[index] || null, 6000);
    if (!el) return { ok: false, detail: `éditeur CKEditor #${index} introuvable dans le DOM` };

    if (dryRun) {
      const readOnly = isCKEditorReadOnly(el);
      return readOnly
        ? { ok: false, warn: true, detail: "élément trouvé mais verrouillé en LECTURE SEULE à cette étape du workflow" }
        : { ok: true, detail: "élément trouvé et éditable (le collage réel n'est pas simulé en analyse)" };
    }

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(400);

    if (isCKEditorReadOnly(el)) {
      return { ok: false, detail: "éditeur en LECTURE SEULE à cette étape du workflow (verrouillé — prérequis pas encore remplis sur la swat)" };
    }

    const beforeText = el.innerText || "";
    el.focus();
    await sleep(80);

    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    await sleep(120);

    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", code: "KeyA", keyCode: 65, which: 65, ctrlKey: true, bubbles: true, cancelable: true })
    );
    await sleep(200);

    // La promesse de confirmation réseau est créée AVANT de dispatcher le
    // collage (et donc avant les vérifications ci-dessous, qui prennent du
    // temps) : l'application peut déclencher son auto-save très vite après
    // la modification du DOM — l'attendre seulement APRÈS ces vérifications
    // risquerait de rater l'évènement s'il arrive entre-temps (constaté via
    // tests/fixture : un délai de sauvegarde aussi court que ~250ms peut
    // survenir avant la fin des `sleep()` de vérification ci-dessous).
    const savePromise = waitForSave(15000);

    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/html", html);
    dataTransfer.setData("text/plain", beforeText);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
    await sleep(300);

    const newPlainText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const afterText = (el.innerText || "").trim();
    // `el.innerText` insère un saut de ligne entre deux éléments de bloc
    // (ex. <h3>…</h3><p>…</p>) là où newPlainText (dérivé du HTML par un
    // simple remplacement de balises par un espace) n'a qu'un espace — sans
    // cette normalisation identique des deux côtés, une comparaison par
    // sous-chaîne dont les 15 premiers caractères chevauchent une frontière
    // de bloc échoue à tort (trouvé via tests/fixture, cf tests/run-tests.mjs).
    const afterTextNormalized = afterText.replace(/\s+/g, " ").trim();
    const applied = newPlainText && afterTextNormalized.includes(newPlainText.slice(0, 15));

    if (!applied) {
      return { ok: false, detail: "le collage automatique (évènement 'paste' simulé) n'a pas modifié le contenu visible — vérifier manuellement" };
    }

    if (beforeText.trim().length > 15 && afterText.length > newPlainText.length * 1.5) {
      return {
        ok: false,
        detail: `le texte a été inséré mais l'ancien contenu par défaut n'a pas été supprimé avant (${afterText.length} caractères au final contre ${newPlainText.length} attendus) — vérifie et corrige manuellement`
      };
    }

    el.blur();
    document.body.click();
    const saved = await savePromise;
    if (!saved) {
      return { ok: true, warn: true, detail: "collage confirmé visuellement, mais aucune confirmation réseau de sauvegarde reçue après 15s — vérifie manuellement avant de changer d'onglet si possible" };
    }
    return { ok: true };
  }

  // =======================================================================
  // Workload — appel API direct (inchangé depuis v2.8.0, seule partie de
  // v2.x qui suivait déjà le "bon" principe : parler à l'API réelle de
  // Swatsheet plutôt que de simuler des clics). Sert de modèle pour toute
  // future migration d'un autre champ vers l'API (voir README, feuille de
  // route) : jamais d'ID deviné, résolution en lecture seule d'abord.
  // =======================================================================

  function getSwCodeFromUrl() {
    const m = location.pathname.match(/\/swatsheet\/(SW-\d+-\d+)/i);
    return m ? m[1].toUpperCase() : null;
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} sur ${url}`);
      err.httpStatus = res.status;
      throw err;
    }
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch (e) {
      return text;
    }
  }

  async function resolveWorkloadTargets(cfg, workloadProfile, options) {
    const swCode = getSwCodeFromUrl();
    if (!swCode) return { ok: false, detail: "impossible de déterminer le numéro de la swat (SW-XXX-XXX) depuis l'URL de la page" };

    let parentId;
    try {
      const raw = await fetchJson(`/api/swatsheet/parent/${encodeURIComponent(swCode)}/parentId`, { headers: { Accept: "application/json" } });
      parentId = parseInt(raw, 10);
      if (!parentId) return { ok: false, detail: `réponse inattendue pour l'ID interne de la swat "${swCode}" : "${raw}"` };
    } catch (err) {
      return { ok: false, detail: `impossible de récupérer l'ID interne de la swat : ${err.message}` };
    }

    const groupName = (workloadProfile.groupe || "").trim();
    if (!groupName) return { ok: false, detail: "aucun groupe configuré dans le profil (workload.groupe) — création annulée" };

    let groupId;
    try {
      const feature = cfg.groupsFeature || "FEAT_SWATSHEET_REVIEW";
      const groups = await fetchJson(`/api/bdi/groups?feature=${encodeURIComponent(feature)}`, { headers: { Accept: "application/json" } });
      const target = normalizeText(groupName);
      const match = (groups || []).find((g) => normalizeText(g.name) === target || normalizeText(g.code) === target);
      if (!match) return { ok: false, detail: `groupe "${groupName}" introuvable dans la liste des groupes (feature=${feature}) — vérifie l'orthographe exacte dans le profil` };
      groupId = match.id;
    } catch (err) {
      return { ok: false, detail: `impossible de récupérer la liste des groupes : ${err.message}` };
    }

    const responsableName = (workloadProfile.responsable || (options.userValues && options.userValues.premierIntervenant) || "").trim();
    let userId = null;
    if (responsableName) {
      try {
        const users = await fetchJson(`/api/bdi/groups/${groupId}/users-relation`, { headers: { Accept: "application/json" } });
        const target = normalizeText(responsableName);
        const match = (users || []).find((u) => normalizeText(u.name) === target);
        if (!match) return { ok: false, detail: `responsable "${responsableName}" introuvable parmi les membres du groupe "${groupName}"` };
        userId = match.userId;
      } catch (err) {
        return { ok: false, detail: `impossible de récupérer les membres du groupe "${groupName}" : ${err.message}` };
      }
    }

    return { ok: true, swCode, parentId, groupId, groupName, userId, responsableName };
  }

  async function driveWorkload(cfg, workloadProfile, options, { dryRun = false } = {}) {
    const resolved = await resolveWorkloadTargets(cfg, workloadProfile, options);
    if (!resolved.ok) return resolved;

    if (dryRun) {
      return {
        ok: true,
        detail: `prêt — groupe "${resolved.groupName}" (ID ${resolved.groupId})${
          resolved.responsableName ? `, responsable "${resolved.responsableName}" (ID ${resolved.userId})` : ", aucun responsable configuré"
        } — la création elle-même n'est pas testée ici`
      };
    }

    try {
      const payload = {
        assignedBdiGroup: resolved.groupId,
        assignedBdiUser: resolved.userId,
        applyReviewEffectivity: cfg.applyReviewEffectivity !== false,
        addSwatTail: !!cfg.addSwatTail
      };
      const json = await fetchJson(`/api/workload/create/${resolved.parentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload)
      });

      if (json && json.hasError) {
        const msg = json.messages && json.messages.length ? json.messages.join(" / ") : "raison non précisée par l'API";
        return { ok: false, detail: `l'API a refusé la création du Workload : ${msg}` };
      }

      const wlNumber = json && json.data && json.data.workloadNumber;
      return { ok: true, detail: wlNumber ? `Workload ${wlNumber} créé — groupe "${resolved.groupName}"` : undefined };
    } catch (err) {
      return { ok: false, detail: `l'appel de création du Workload a échoué : ${err.message}` };
    }
  }

  // =======================================================================
  // Pipeline unique — remplace run()+diagnose() de la v2.
  // =======================================================================

  function errorDetail(err) {
    const stack = (err && err.stack) || "";
    const lines = stack.split("\n").map((l) => l.trim()).filter(Boolean);
    const frame = lines.find((l) => l.startsWith("at ")) || lines[1] || "";
    return frame ? `${err.message} — ${frame}` : String(err.message || err);
  }

  /**
   * @param {object} fieldMap   contenu de field-map.json
   * @param {object} profile    profil choisi (déjà fusionné avec surcharge), ou null pour dryRun structurel
   * @param {{dryRun?:boolean, fillEditors?:boolean, checkValidations?:boolean, attemptWorkload?:boolean, userValues?:object, onProgress?:function}} options
   */
  async function process(fieldMap, profile, options = {}) {
    const dryRun = !!options.dryRun;
    const startTime = (typeof performance !== "undefined" ? performance : Date).now();
    const results = [];
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

    if (!fieldMap) {
      return { ok: false, dryRun, durationMs: 0, okCount: 0, totalSteps: 0, errorCount: 1, results: [{ key: "fieldMap", label: "field-map.json", status: "error", detail: "non fourni" }] };
    }
    if (!dryRun && !profile) {
      return { ok: false, dryRun, durationMs: 0, okCount: 0, totalSteps: 0, errorCount: 1, results: [{ key: "profile", label: "profil", status: "error", detail: "aucun profil sélectionné" }] };
    }

    clearFieldCache();
    installSaveWatcher(fieldMap.saveWatch);

    const sequence = fieldMap.sequence || [];
    const checkboxDefs = fieldMap.checkboxes || [];
    const activeCheckboxes =
      options.checkValidations === false
        ? []
        : dryRun
        ? checkboxDefs
        : checkboxDefs.filter((cb) => profile.checkboxes && profile.checkboxes[cb.key]);

    const wantEditors = options.fillEditors !== false;
    const wantWorkload =
      dryRun
        ? !!(fieldMap.workload && profile && profile.workload && profile.workload.enabled)
        : !!(options.attemptWorkload && profile && profile.workload && profile.workload.enabled);

    const totalSteps = sequence.length + (wantEditors ? 2 : 0) + activeCheckboxes.length + (wantWorkload ? 1 : 0);
    let stepIndex = 0;

    const push = (key, label, driverResult) => {
      const status = driverResult.ok ? (driverResult.warn ? "warn" : "ok") : driverResult.warn ? "warn" : "error";
      results.push({ key, label, status, detail: driverResult.detail || (status === "ok" ? "OK" : "") });
      stepIndex += 1;
      onProgress({ step: stepIndex, total: totalSteps, label, status: status === "ok" ? "done" : status === "warn" ? "done" : "error" });
    };

    // ---------------------------------------------------------------
    // 1) Séquence de champs
    // ---------------------------------------------------------------
    for (const step of sequence) {
      const label = step.label || step.name || step.key;
      try {
        let value;
        if (step.userInput) {
          const fromUser = options.userValues && options.userValues[step.key];
          value = (fromUser && fromUser.trim()) || (profile && profile.fields && profile.fields[step.key]);
        } else {
          value = profile && profile.fields && profile.fields[step.key];
        }

        if (step.optional && !value) {
          push(step.key, label, { ok: true, detail: "champ optionnel sans valeur — ignoré" });
          continue;
        }

        const field = findField(step);
        if (!field) {
          push(step.key, label, { ok: false, detail: `introuvable dans le DOM (recherché par ${step.match === "name" ? `name="${step.name}"` : `label "${step.label}"`})` });
          continue;
        }

        if (dryRun && !value) {
          push(step.key, label, { ok: !field.input.disabled, warn: field.input.disabled, detail: field.input.disabled ? "champ trouvé mais DÉSACTIVÉ, et aucune valeur de profil à tester" : "champ trouvé (aucune valeur de profil à tester)" });
          continue;
        }

        const result = await driveSelect(field, value, { freeText: !!step.freeText, dryRun });
        push(step.key, label, result);
      } catch (err) {
        push(step.key, label, { ok: false, detail: `erreur JS : ${errorDetail(err)}` });
      }
    }

    // ---------------------------------------------------------------
    // 2) Éditeurs riches (onglet "Définition du problème")
    // ---------------------------------------------------------------
    if (wantEditors) {
      const editorSteps = [
        { key: "solutionFinale", label: "Solution Finale (éditeur 1)", index: 0, html: profile && profile.editors && profile.editors.solutionFinale },
        { key: "planAction", label: "Plan d'action (éditeur 2)", index: 1, html: profile && profile.editors && profile.editors.planAction }
      ];
      for (const ed of editorSteps) {
        try {
          const result = await driveRichText(ed.index, ed.html, { dryRun, tabLabel: fieldMap.tabs && fieldMap.tabs.definitionProbleme });
          push(ed.key, ed.label, result);
        } catch (err) {
          push(ed.key, ed.label, { ok: false, detail: `erreur JS : ${errorDetail(err)}` });
        }
      }
    }

    // ---------------------------------------------------------------
    // 3) Cases à cocher
    // ---------------------------------------------------------------
    for (const cb of activeCheckboxes) {
      const active = !!(profile && profile.checkboxes && profile.checkboxes[cb.key]);
      try {
        const result = await driveCheckbox(cb.name, true, { dryRun });
        if (dryRun && !active) {
          // Désactivée mais pas utilisée par ce profil : pas préoccupant,
          // on redescend en "ok" plutôt que de faire du bruit inutile dans
          // le rapport (comportement identique à la v2 sur ce point précis).
          if (result.warn) {
            result.warn = false;
            result.ok = true;
          }
          result.detail += " — non activée dans ce profil, information seulement";
        }
        push(cb.key, cb.label, result);
      } catch (err) {
        push(cb.key, cb.label, { ok: false, detail: `erreur JS : ${errorDetail(err)}` });
      }
    }

    // ---------------------------------------------------------------
    // 4) Workload — API directe (résolution en lecture seule en dryRun)
    // ---------------------------------------------------------------
    if (wantWorkload) {
      try {
        const result = await driveWorkload(fieldMap.workload, profile.workload, options, { dryRun });
        push("workload", "Workload (création via API)", result);
      } catch (err) {
        push("workload", "Workload (création via API)", { ok: false, detail: `erreur JS : ${errorDetail(err)}` });
      }
    }

    const durationMs = Math.round((typeof performance !== "undefined" ? performance : Date).now() - startTime);
    const errorCount = results.filter((r) => r.status === "error").length;
    const okCount = results.filter((r) => r.status === "ok").length;

    return { ok: true, dryRun, durationMs, okCount, totalSteps, errorCount, results };
  }

  /**
   * Ouvre la liste "Nom du premier intervenant", lit TOUS les noms qui y
   * apparaissent, referme sans rien sélectionner. Sert au bouton 🔄.
   */
  async function extractIntervenantNames(fieldMap) {
    clearFieldCache();
    const step = (fieldMap.sequence || []).find((s) => s.key === "intervenantName");
    if (!step) return { ok: false, error: "Configuration 'intervenantName' introuvable dans field-map.json" };
    try {
      const field = findField(step);
      if (!field) return { ok: false, error: "Champ 'Nom du premier intervenant' introuvable sur cette page — es-tu bien sur le formulaire RFC d'une swat ?" };
      const names = await extractOptionList(field, 3000);
      return { ok: true, names };
    } catch (err) {
      return { ok: false, error: errorDetail(err) };
    }
  }

  function mergeProfile(base, override) {
    if (!override) return base;
    const merged = JSON.parse(JSON.stringify(base));
    ["fields", "editors", "checkboxes", "workload"].forEach((section) => {
      if (override[section]) merged[section] = { ...(merged[section] || {}), ...override[section] };
    });
    return merged;
  }

  root.SwatEngine = {
    process,
    extractIntervenantNames,
    mergeProfile,
    // exposés surtout pour les tests automatisés (tests/engine.test.mjs)
    _internal: { findField, driveSelect, driveCheckbox, driveRichText, driveWorkload, resolveWorkloadTargets, installSaveWatcher, waitForSave, normalizeText, clearFieldCache }
  };
})(typeof window !== "undefined" ? window : globalThis);


  const FIELD_MAP = {
  "_comment": "Configuration du ciblage DOM sur Swatsheet Next. Si Bombardier change la mise en page du formulaire, commence par ajuster ce fichier avant de toucher au code JS. 'match':'name' cible un attribut name= réel (fiable) ; 'match':'label' cherche le texte du label visible le plus proche (comme avant, mais chaque valeur vient maintenant d'un profil JSON plutôt que d'être codée en dur).",
  "sequence": [
    {
      "key": "intervenantName",
      "match": "label",
      "label": "Acheminement - Nom du premier intervenant",
      "freeText": false,
      "optional": true,
      "userInput": true
    },
    {
      "key": "requiredBefore",
      "match": "name",
      "name": "requiredBefore",
      "freeText": false
    },
    {
      "key": "autorite",
      "match": "label",
      "label": "Autorité (RFC, RFQ/P&O, PCR)",
      "freeText": true,
      "optional": true
    },
    {
      "key": "chapitreAta",
      "match": "label",
      "label": "Chapitre Ata",
      "freeText": false
    },
    {
      "key": "causeFonction",
      "match": "label",
      "label": "Cause racine - Fonction",
      "freeText": false
    },
    {
      "key": "causeMetier",
      "match": "label",
      "label": "Cause racine - Métier",
      "freeText": false
    },
    {
      "key": "causeRaison",
      "match": "label",
      "label": "Cause racine - Raison",
      "freeText": false
    },
    {
      "key": "causeCategorie",
      "match": "label",
      "label": "Cause racine - Catégorie",
      "freeText": false
    },
    {
      "key": "causeSousCategorie",
      "match": "label",
      "label": "Cause racine - Sous-catégorie",
      "freeText": false
    }
  ],
  "checkboxes": [
    {
      "key": "priorite",
      "match": "name",
      "name": "priority",
      "label": "Priorité validée (P1, P2 or P3)"
    },
    {
      "key": "avionsImpactes",
      "match": "name",
      "name": "impact",
      "label": "Avions impactés validés"
    },
    {
      "key": "enjeuExistant",
      "match": "name",
      "name": "issue",
      "label": "Existence du même enjeu validé"
    },
    {
      "key": "instructionsTravail",
      "match": "name",
      "name": "work",
      "label": "Instructions de travail validées"
    },
    {
      "key": "documents",
      "match": "name",
      "name": "document",
      "label": "Documents validés (DWG, RV, DTS, SAP)"
    }
  ],
  "tabs": {
    "definitionProbleme": "DÉFINITION",
    "impact": "IMPACT"
  },
  "workload": {
    "_note": "v2.8.0 : la création ne passe plus par un clic sur '+ Workload' ni par une recherche de champs dans le DOM (ancienne approche, abandonnée — trop fragile). Confirmée par une capture .har réelle d'une création manuelle par Alex : un simple appel direct POST /api/workload/create/{parentId} avec { assignedBdiGroup, assignedBdiUser, applyReviewEffectivity, addSwatTail }. Gros avantage : plus besoin de changer d'onglet vers Impact, donc plus aucun risque d'y perdre du contenu CKEditor non sauvegardé. groupsFeature sert à résoudre le nom du groupe du profil (ex. 'MET-SUP54') vers son ID réel via GET /api/bdi/groups?feature=... — si le nom ne correspond à aucun groupe retourné, la création est annulée plutôt que de deviner.",
    "groupsFeature": "FEAT_SWATSHEET_REVIEW",
    "applyReviewEffectivity": true,
    "addSwatTail": false
  },
  "saveWatch": {
    "_note": "v3.0.0 : généralisé depuis l'ancien inject.js (qui codait ce pattern en dur). L'ID interne de la swat (parentId) est mis en cache une fois résolu pour ne plus faire un appel réseau supplémentaire à chaque champ.",
    "method": "PUT",
    "urlPattern": "/api/swatsheet/reviewandapprove/update"
  },
  "_intervenantNote": "v2.3.0 : 'Nom du premier intervenant' passé de freeText:true à false. Ce champ est en réalité une vraie liste déroulante (visible avec un chevron sur les captures), pas un champ texte libre — taper un nom puis quitter le champ (ancien comportement freeText) ne le faisait jamais vraiment sélectionner comme option, d'où le nom qui ne s'inscrivait pas. Le popup ne permet plus de le taper : la valeur vient maintenant d'un clic dans la liste définie dans intervenants.json, et doit donc correspondre exactement au texte de l'option réelle dans Swatsheet."
};
  const INTERVENANTS = {
  "_comment": "Liste des noms affichés dans le popup pour le champ 'Nom du premier intervenant' — un simple clic les sélectionne, plus besoin de taper. Édite cette liste directement (ajoute/retire une ligne dans 'names') pour qu'elle corresponde aux membres de ton groupe. Chaque nom doit correspondre EXACTEMENT (orthographe, accents, espaces) au texte de l'option telle qu'elle apparaît dans la vraie liste déroulante de Swatsheet, sinon le remplissage échouera avec 'option introuvable dans la liste' — utilise le bouton 🔍 Analyser pour vérifier après un ajout.",
  "names": [
    "Alex Alfonsi"
  ]
};
  const PROFILES_INDEX = [
  {
    "id": "methodes-ebenisterie",
    "label": "Méthodes ébénisterie",
    "color": "#1565c0",
    "data": {
      "id": "methodes-ebenisterie",
      "label": "Méthodes ébénisterie",
      "verified": true,
      "_note": "Valeurs de catégorie confirmées à partir d'une swat réelle déjà traitée (SW-236-127). Si Swatsheet change sa liste d'options, ajuste juste les chaînes ci-dessous — aucune modification de code nécessaire.",
      "fields": {
        "requiredBefore": "FABRICATION (M)",
        "autorite": "",
        "chapitreAta": "N/A not applicable",
        "causeFonction": "G 7/8 MÉTHODES ÉBÉNISTERIE",
        "causeMetier": "CONFIGURATION",
        "causeRaison": "AMÉLIORATION",
        "causeCategorie": "TOOLING",
        "causeSousCategorie": "ERGONOMIE"
      },
      "editors": {
        "solutionFinale": "<h3>Solution Finale</h3><p>Description de l'enjeu dans les mots de méthode:</p><p>&nbsp;</p><p>Description de la solution finale</p><p>&nbsp;</p><p>Court terme :</p><p>&nbsp;</p><p>Long terme :</p>",
        "planAction": "<h3>Plan d'action</h3><p>Section affectée par l'enjeu : N/A</p><p>&nbsp;</p><p>Pièces affectées par l'enjeu : N/A</p><p>&nbsp;</p><p>Dessins impactés par l'enjeu : N/A</p><p>&nbsp;</p><p>Validation DDD prod :</p><p>&nbsp;</p><p>Commentaires</p>"
      },
      "checkboxes": {
        "priorite": true,
        "avionsImpactes": false,
        "enjeuExistant": false,
        "instructionsTravail": false,
        "documents": false
      },
      "workload": {
        "enabled": true,
        "_note": "v2.8.0 : création via l'API REST (POST /api/workload/create), confirmée par une capture .har réelle où ce groupe exact (MET-SUP54, ID 4185) a été utilisé avec succès. 'groupe' doit correspondre EXACTEMENT au nom affiché par Swatsheet (résolu dynamiquement vers son ID réel à chaque exécution) ; 'responsable' vide utilise l'intervenant sélectionné dans le popup.",
        "groupe": "MET-SUP54",
        "responsable": ""
      }
    }
  },
  {
    "id": "production-ebenisterie",
    "label": "G7/8 Production (ébénisterie)",
    "color": "#2e7d32",
    "data": {
      "id": "production-ebenisterie",
      "label": "G7/8 Production (ébénisterie)",
      "verified": true,
      "_note": "Valeurs de catégorie confirmées via la capture d'écran fournie (Cause racine : G7/8 PRODUCTION / 918 - ÉBÉNISTE / AMÉLIORATION / DESSIN, COMPRÉHENSION / AUCUNE SOUS CATÉGORIE). L'ancien profil codé en dur avait '910 - TECHNICIEN EN PRÉVOL' au lieu de '918 - ÉBÉNISTE' — c'était le bug.",
      "fields": {
        "requiredBefore": "FABRICATION (M)",
        "autorite": "",
        "chapitreAta": "N/A not applicable",
        "causeFonction": "G7/8 PRODUCTION",
        "causeMetier": "918 - ÉBÉNISTE",
        "causeRaison": "AMÉLIORATION",
        "causeCategorie": "DESSIN, COMPRÉHENSION",
        "causeSousCategorie": "AUCUNE SOUS CATÉGORIE"
      },
      "editors": {
        "solutionFinale": "<h3>Solution Finale</h3><p>Description de l'enjeu dans les mots de méthode:</p><p>&nbsp;</p><p>Description de la solution finale</p><p>&nbsp;</p><p>Court terme :</p><p>&nbsp;</p><p>Long terme :</p>",
        "planAction": "<h3>Plan d'action</h3><p>Section affectée par l'enjeu : N/A</p><p>&nbsp;</p><p>Pièces affectées par l'enjeu : N/A</p><p>&nbsp;</p><p>Dessins impactés par l'enjeu : N/A</p><p>&nbsp;</p><p>Validation DDD prod :</p><p>&nbsp;</p><p>Commentaires</p>"
      },
      "checkboxes": {
        "priorite": true,
        "avionsImpactes": false,
        "enjeuExistant": false,
        "instructionsTravail": false,
        "documents": false
      },
      "workload": {
        "enabled": true,
        "_note": "v2.8.0 : création via l'API REST (POST /api/workload/create) — voir la note dans methodes-ebenisterie.json (groupe MET-SUP54 confirmé par capture .har réelle ; les autres groupes suivent le même principe mais n'ont pas encore été vérifiés individuellement). 'groupe' doit correspondre EXACTEMENT au nom affiché par Swatsheet.",
        "groupe": "PROD-SUP54",
        "responsable": ""
      }
    }
  },
  {
    "id": "ingenierie-ebenisterie",
    "label": "Ingénierie ébénisterie",
    "color": "#6a1b9a",
    "data": {
      "id": "ingenierie-ebenisterie",
      "label": "Ingénierie ébénisterie",
      "verified": false,
      "_note": "PLACEHOLDER — je n'ai aucun exemple réel pour ce profil, donc les valeurs de 'Cause racine' ci-dessous sont devinées par analogie avec 'Méthodes ébénisterie' et ne correspondent probablement PAS exactement aux options existantes dans la liste déroulante de Swatsheet. Corrige-les avant la première utilisation : ouvre une swat, choisis les bonnes valeurs à la main une fois, et recopie-les ici (Fonction / Métier / Raison / Catégorie / Sous-catégorie). Si une valeur ne correspond à aucune option, ce champ sera simplement signalé en erreur dans le rapport et les autres champs continueront à se remplir normalement.",
      "fields": {
        "requiredBefore": "FABRICATION (M)",
        "autorite": "",
        "chapitreAta": "N/A not applicable",
        "causeFonction": "G 7/8 INGÉNIERIE ÉBÉNISTERIE",
        "causeMetier": "À CONFIRMER",
        "causeRaison": "AMÉLIORATION",
        "causeCategorie": "À CONFIRMER",
        "causeSousCategorie": "À CONFIRMER"
      },
      "editors": {
        "solutionFinale": "<h3>Solution Finale</h3><p>Description de l'enjeu dans les mots de méthode:</p><p>&nbsp;</p><p>Description de la solution finale</p><p>&nbsp;</p><p>Court terme :</p><p>&nbsp;</p><p>Long terme :</p>",
        "planAction": "<h3>Plan d'action</h3><p>Section affectée par l'enjeu : N/A</p><p>&nbsp;</p><p>Pièces affectées par l'enjeu : N/A</p><p>&nbsp;</p><p>Dessins impactés par l'enjeu : N/A</p><p>&nbsp;</p><p>Validation DDD prod :</p><p>&nbsp;</p><p>Commentaires</p>"
      },
      "checkboxes": {
        "priorite": true,
        "avionsImpactes": false,
        "enjeuExistant": false,
        "instructionsTravail": false,
        "documents": false
      },
      "workload": {
        "enabled": true,
        "_note": "v2.8.0 : création via l'API REST (POST /api/workload/create) — voir la note dans methodes-ebenisterie.json (groupe MET-SUP54 confirmé par capture .har réelle ; les autres groupes suivent le même principe mais n'ont pas encore été vérifiés individuellement). 'groupe' doit correspondre EXACTEMENT au nom affiché par Swatsheet.",
        "groupe": "ING-SUP54",
        "responsable": ""
      }
    }
  },
  {
    "id": "cnc-ebenisterie",
    "label": "CNC ébénisterie",
    "color": "#ef6c00",
    "data": {
      "id": "cnc-ebenisterie",
      "label": "CNC ébénisterie",
      "verified": false,
      "_note": "PLACEHOLDER — mêmes réserves que ingenierie-ebenisterie.json : aucun exemple réel, valeurs devinées par analogie. À corriger avant la première utilisation.",
      "fields": {
        "requiredBefore": "FABRICATION (M)",
        "autorite": "",
        "chapitreAta": "N/A not applicable",
        "causeFonction": "G 7/8 CNC ÉBÉNISTERIE",
        "causeMetier": "À CONFIRMER",
        "causeRaison": "AMÉLIORATION",
        "causeCategorie": "À CONFIRMER",
        "causeSousCategorie": "À CONFIRMER"
      },
      "editors": {
        "solutionFinale": "<h3>Solution Finale</h3><p>Description de l'enjeu dans les mots de méthode:</p><p>&nbsp;</p><p>Description de la solution finale</p><p>&nbsp;</p><p>Court terme :</p><p>&nbsp;</p><p>Long terme :</p>",
        "planAction": "<h3>Plan d'action</h3><p>Section affectée par l'enjeu : N/A</p><p>&nbsp;</p><p>Pièces affectées par l'enjeu : N/A</p><p>&nbsp;</p><p>Dessins impactés par l'enjeu : N/A</p><p>&nbsp;</p><p>Validation DDD prod :</p><p>&nbsp;</p><p>Commentaires</p>"
      },
      "checkboxes": {
        "priorite": true,
        "avionsImpactes": false,
        "enjeuExistant": false,
        "instructionsTravail": false,
        "documents": false
      },
      "workload": {
        "enabled": true,
        "_note": "v2.8.0 : création via l'API REST (POST /api/workload/create) — voir la note dans methodes-ebenisterie.json (groupe MET-SUP54 confirmé par capture .har réelle ; les autres groupes suivent le même principe mais n'ont pas encore été vérifiés individuellement). 'groupe' doit correspondre EXACTEMENT au nom affiché par Swatsheet.",
        "groupe": "CNC-SUP54",
        "responsable": ""
      }
    }
  },
  {
    "id": "programmation-ebenisterie",
    "label": "Programmation ébénisterie",
    "color": "#00838f",
    "data": {
      "id": "programmation-ebenisterie",
      "label": "Programmation ébénisterie",
      "verified": false,
      "_note": "PLACEHOLDER — mêmes réserves que ingenierie-ebenisterie.json : aucun exemple réel, valeurs devinées par analogie. À corriger avant la première utilisation.",
      "fields": {
        "requiredBefore": "FABRICATION (M)",
        "autorite": "",
        "chapitreAta": "N/A not applicable",
        "causeFonction": "G 7/8 PROGRAMMATION ÉBÉNISTERIE",
        "causeMetier": "À CONFIRMER",
        "causeRaison": "AMÉLIORATION",
        "causeCategorie": "À CONFIRMER",
        "causeSousCategorie": "À CONFIRMER"
      },
      "editors": {
        "solutionFinale": "<h3>Solution Finale</h3><p>Description de l'enjeu dans les mots de méthode:</p><p>&nbsp;</p><p>Description de la solution finale</p><p>&nbsp;</p><p>Court terme :</p><p>&nbsp;</p><p>Long terme :</p>",
        "planAction": "<h3>Plan d'action</h3><p>Section affectée par l'enjeu : N/A</p><p>&nbsp;</p><p>Pièces affectées par l'enjeu : N/A</p><p>&nbsp;</p><p>Dessins impactés par l'enjeu : N/A</p><p>&nbsp;</p><p>Validation DDD prod :</p><p>&nbsp;</p><p>Commentaires</p>"
      },
      "checkboxes": {
        "priorite": true,
        "avionsImpactes": false,
        "enjeuExistant": false,
        "instructionsTravail": false,
        "documents": false
      },
      "workload": {
        "enabled": true,
        "_note": "v2.8.0 : création via l'API REST (POST /api/workload/create) — voir la note dans methodes-ebenisterie.json (groupe MET-SUP54 confirmé par capture .har réelle ; les autres groupes suivent le même principe mais n'ont pas encore été vérifiés individuellement). 'groupe' doit correspondre EXACTEMENT au nom affiché par Swatsheet.",
        "groupe": "PROG-SUP54",
        "responsable": ""
      }
    }
  }
];

  /* ---------------------------------------------------------------------
 * Interface flottante injectée directement sur la page Swatsheet.
 * -----------------------------------------------------------------------
 * Remplace le popup séparé de la variante extension : ici, pas de fenêtre
 * à part, pas d'onglet actif à retrouver — le panneau vit sur la page
 * elle-même, toujours au bon endroit. Persistance via localStorage (namespacé
 * "swat-af:") plutôt que chrome.storage — fonctionne à l'identique dans
 * n'importe quel navigateur supportant un gestionnaire de userscripts
 * (Chrome, Edge, Firefox...), sans permission particulière à accorder.
 * ------------------------------------------------------------------- */
(function () {
  "use strict";

  const STORAGE_PREFIX = "swat-af:";
  function storeGet(key, fallback) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }
  function storeSet(key, value) {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch (e) {
      /* quota / navigation privée : on continue sans persister */
    }
  }

  const DEFAULT_OPTIONS = { fillEditors: true, checkValidations: true, rememberLastProfile: true, attemptWorkload: false };

  const state = {
    selectedProfileId: storeGet("lastProfile", null),
    options: { ...DEFAULT_OPTIONS, ...storeGet("options", {}) },
    darkMode: storeGet("darkMode", null),
    profileOverrides: storeGet("profileOverrides", null),
    intervenantNames: storeGet("intervenantNamesCache", null) || INTERVENANTS.names || [],
    selectedIntervenant: storeGet("intervenantName", ""),
    collapsed: storeGet("collapsed", false)
  };

  // ---- squelette DOM + styles (préfixés .swat-af- pour ne jamais entrer
  // en collision avec les classes MUI de Swatsheet) --------------------
  const STYLE = `
  .swat-af-root{position:fixed;right:16px;bottom:16px;z-index:2147483000;font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;width:300px;max-height:82vh;display:flex;flex-direction:column;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);background:var(--swat-bg,#1e1f24);color:var(--swat-fg,#eee);overflow:hidden}
  .swat-af-root[data-theme="light"]{--swat-bg:#fff;--swat-fg:#1b1b1f;--swat-border:#ddd;--swat-muted:#666}
  .swat-af-root[data-theme="dark"]{--swat-bg:#1e1f24;--swat-fg:#eee;--swat-border:#3a3b42;--swat-muted:#a2a3ad}
  .swat-af-head{display:flex;align-items:center;gap:6px;padding:8px 10px;background:rgba(127,127,127,.12);cursor:pointer;user-select:none}
  .swat-af-head b{flex:1;font-size:13px;letter-spacing:.02em}
  .swat-af-body{padding:10px;overflow-y:auto}
  .swat-af-root.is-collapsed .swat-af-body{display:none}
  .swat-af-btn{border:1px solid var(--swat-border,#444);background:transparent;color:inherit;border-radius:6px;padding:6px 8px;cursor:pointer;font-size:12px}
  .swat-af-btn:hover{background:rgba(127,127,127,.15)}
  .swat-af-btn:disabled{opacity:.4;cursor:default}
  .swat-af-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
  .swat-af-chip{border:1px solid var(--swat-border,#444);border-radius:14px;padding:4px 10px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:5px;background:transparent;color:inherit}
  .swat-af-chip.is-selected{border-color:#4c8dff;background:rgba(76,141,255,.15)}
  .swat-af-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
  .swat-af-section-title{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--swat-muted,#999);margin:10px 0 6px}
  .swat-af-actions{display:flex;gap:6px;margin-top:8px}
  .swat-af-actions .swat-af-btn{flex:1}
  .swat-af-primary{background:#2e7d32;border-color:#2e7d32;color:#fff;font-weight:600}
  .swat-af-primary:disabled{opacity:.35}
  .swat-af-opt{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:12px}
  .swat-af-results{list-style:none;margin:8px 0 0;padding:0;max-height:220px;overflow-y:auto;border-top:1px solid var(--swat-border,#444);padding-top:6px}
  .swat-af-results li{padding:3px 0;font-size:11.5px;display:flex;flex-direction:column}
  .swat-af-results li .d{color:var(--swat-muted,#999);font-size:11px}
  .swat-af-results li.ok{color:#4caf50}
  .swat-af-results li.warn{color:#ffb300}
  .swat-af-results li.error{color:#ef5350}
  .swat-af-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#222;color:#fff;padding:8px 14px;border-radius:6px;font-size:12px;z-index:2147483001;box-shadow:0 4px 16px rgba(0,0,0,.4)}
  .swat-af-summary{font-size:11.5px;color:var(--swat-muted,#999);margin-top:6px}
  textarea.swat-af-textarea{width:100%;min-height:90px;background:transparent;color:inherit;border:1px solid var(--swat-border,#444);border-radius:6px;font-family:monospace;font-size:11px;padding:6px;box-sizing:border-box}
  `;

  const styleEl = document.createElement("style");
  styleEl.textContent = STYLE;
  document.documentElement.appendChild(styleEl);

  const root = document.createElement("div");
  root.className = "swat-af-root" + (state.collapsed ? " is-collapsed" : "");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", state.darkMode === null ? (prefersDark ? "dark" : "light") : state.darkMode ? "dark" : "light");

  root.innerHTML = `
    <div class="swat-af-head" id="swatAfHead">
      <span>✈</span><b>SWAT AUTOFILL</b>
      <button class="swat-af-btn" id="swatAfTheme" title="Thème">🌓</button>
      <span id="swatAfChevron">${state.collapsed ? "▸" : "▾"}</span>
    </div>
    <div class="swat-af-body">
      <div class="swat-af-section-title">Profil</div>
      <div class="swat-af-row" id="swatAfProfiles"></div>

      <div class="swat-af-section-title">1er intervenant <button class="swat-af-btn" id="swatAfRefreshNames" title="Relire la vraie liste depuis la page (lecture seule)">🔄</button></div>
      <div class="swat-af-row" id="swatAfIntervenants"></div>

      <div class="swat-af-section-title">Options</div>
      <label class="swat-af-opt"><input type="checkbox" id="swatAfOptEditors"> Remplir les éditeurs (CKEditor)</label>
      <label class="swat-af-opt"><input type="checkbox" id="swatAfOptChecks"> Cocher les validations</label>
      <label class="swat-af-opt"><input type="checkbox" id="swatAfOptWorkload"> Créer le Workload (⚠ expérimental)</label>

      <div class="swat-af-actions">
        <button class="swat-af-btn swat-af-primary" id="swatAfLaunch" disabled>▶ LANCER</button>
        <button class="swat-af-btn" id="swatAfDiagnose" disabled title="Analyse complète en lecture seule">🔍 Analyser</button>
      </div>

      <div class="swat-af-summary" id="swatAfSummary"></div>
      <ul class="swat-af-results" id="swatAfResults" style="display:none"></ul>

      <div class="swat-af-section-title">⚙ Surcharges JSON (par profil)</div>
      <textarea class="swat-af-textarea" id="swatAfOverrides" spellcheck="false" placeholder='{"methodes-ebenisterie":{"fields":{"chapitreAta":"57 - AILES"}}}'></textarea>
      <div class="swat-af-actions">
        <button class="swat-af-btn" id="swatAfSaveOverrides">Enregistrer</button>
        <button class="swat-af-btn" id="swatAfResetOverrides">Réinitialiser</button>
      </div>
    </div>
  `;
  document.documentElement.appendChild(root);

  const qs = (id) => root.querySelector("#" + id);

  qs("swatAfHead").addEventListener("click", (e) => {
    if (e.target.id === "swatAfTheme") return;
    state.collapsed = !state.collapsed;
    root.classList.toggle("is-collapsed", state.collapsed);
    qs("swatAfChevron").textContent = state.collapsed ? "▸" : "▾";
    storeSet("collapsed", state.collapsed);
  });
  qs("swatAfTheme").addEventListener("click", () => {
    const isDark = root.getAttribute("data-theme") === "dark";
    state.darkMode = !isDark;
    root.setAttribute("data-theme", state.darkMode ? "dark" : "light");
    storeSet("darkMode", state.darkMode);
  });

  let toastTimer = null;
  function showToast(message) {
    let toast = document.querySelector(".swat-af-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "swat-af-toast";
      document.documentElement.appendChild(toast);
    }
    toast.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.remove(), 3200);
  }

  // ---- profils --------------------------------------------------------
  function renderProfiles() {
    const container = qs("swatAfProfiles");
    container.innerHTML = "";
    PROFILES_INDEX.forEach((p) => {
      const btn = document.createElement("button");
      btn.className = "swat-af-chip" + (state.selectedProfileId === p.id ? " is-selected" : "");
      btn.innerHTML = `<span class="swat-af-dot" style="background:${p.color || "#888"}"></span>${p.label}`;
      btn.addEventListener("click", () => selectProfile(p.id));
      container.appendChild(btn);
    });
  }
  function selectProfile(id) {
    state.selectedProfileId = id;
    renderProfiles();
    qs("swatAfLaunch").disabled = false;
    qs("swatAfDiagnose").disabled = false;
    if (state.options.rememberLastProfile) storeSet("lastProfile", id);
  }

  // ---- 1er intervenant --------------------------------------------------
  function renderIntervenants() {
    const container = qs("swatAfIntervenants");
    container.innerHTML = "";
    if (!state.intervenantNames.length) {
      container.innerHTML = '<span class="d" style="opacity:.6">Aucun nom — clique 🔄 sur une swat ouverte</span>';
      return;
    }
    state.intervenantNames.forEach((name) => {
      const btn = document.createElement("button");
      btn.className = "swat-af-chip" + (state.selectedIntervenant === name ? " is-selected" : "");
      btn.textContent = name;
      btn.addEventListener("click", () => {
        state.selectedIntervenant = state.selectedIntervenant === name ? "" : name;
        storeSet("intervenantName", state.selectedIntervenant);
        renderIntervenants();
      });
      container.appendChild(btn);
    });
  }

  qs("swatAfRefreshNames").addEventListener("click", async () => {
    // Laisse le clic d'ORIGINE (sur ce bouton) finir sa propagation sur LA
    // PAGE avant d'ouvrir quoi que ce soit côté Swatsheet : sans ce point
    // de reprise différé, tout le travail DOM synchrone d'avant le premier
    // `await` réel plus bas s'exécute encore DANS la phase de bulle du clic
    // d'origine — s'il ouvre un menu (ici, ou dans process() pour
    // ▶ LANCER/🔍 Analyser), le clic d'origine continue ensuite de remonter
    // jusqu'à `document`, APRÈS coup, et peut se faire prendre par erreur
    // pour "un clic en dehors" par le vrai ClickAwayListener MUI de la page
    // — qui refermerait alors le menu qu'on vient tout juste d'ouvrir.
    // Repéré via tests/fixture (tests/run-tests.mjs, suite B), qui reproduit
    // ce même mécanisme de fermeture ; s'applique potentiellement à la
    // vraie page Swatsheet puisque ses propres composants MUI ont le même
    // genre d'écouteur. Concerne uniquement cette variante (userscript) :
    // le bouton vit SUR la page, contrairement au popup de l'extension.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const btn = qs("swatAfRefreshNames");
    btn.disabled = true;
    try {
      const result = await window.SwatEngine.extractIntervenantNames(FIELD_MAP);
      if (!result.ok) {
        showToast("Échec : " + result.error);
        return;
      }
      if (!result.names.length) {
        showToast("Aucun nom trouvé — es-tu bien sur le formulaire RFC d'une swat ?");
        return;
      }
      state.intervenantNames = result.names;
      storeSet("intervenantNamesCache", result.names);
      renderIntervenants();
      showToast(`${result.names.length} nom(s) trouvé(s) — liste mise à jour`);
    } catch (err) {
      showToast("Erreur : " + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ---- options ----------------------------------------------------------
  qs("swatAfOptEditors").checked = state.options.fillEditors;
  qs("swatAfOptChecks").checked = state.options.checkValidations;
  qs("swatAfOptWorkload").checked = state.options.attemptWorkload;
  ["swatAfOptEditors", "swatAfOptChecks", "swatAfOptWorkload"].forEach((id) => {
    qs(id).addEventListener("change", () => {
      state.options = {
        ...state.options,
        fillEditors: qs("swatAfOptEditors").checked,
        checkValidations: qs("swatAfOptChecks").checked,
        attemptWorkload: qs("swatAfOptWorkload").checked
      };
      storeSet("options", state.options);
    });
  });

  // ---- surcharges JSON ---------------------------------------------------
  qs("swatAfOverrides").value = state.profileOverrides ? JSON.stringify(state.profileOverrides, null, 2) : "";
  qs("swatAfSaveOverrides").addEventListener("click", () => {
    const raw = qs("swatAfOverrides").value.trim();
    if (!raw) {
      state.profileOverrides = null;
      storeSet("profileOverrides", null);
      showToast("Surcharges réinitialisées");
      return;
    }
    try {
      state.profileOverrides = JSON.parse(raw);
      storeSet("profileOverrides", state.profileOverrides);
      showToast("Surcharges enregistrées");
    } catch (e) {
      showToast("JSON invalide : " + e.message);
    }
  });
  qs("swatAfResetOverrides").addEventListener("click", () => {
    qs("swatAfOverrides").value = "";
  });

  // ---- résultats (partagé remplissage réel / analyse) --------------------
  function summarize(results) {
    return {
      okCount: results.filter((r) => r.status === "ok").length,
      warnCount: results.filter((r) => r.status === "warn").length,
      errorCount: results.filter((r) => r.status === "error").length
    };
  }

  function renderResults(report, { dryRun }) {
    const { okCount, warnCount, errorCount } = summarize(report.results);
    qs("swatAfSummary").textContent =
      `${dryRun ? "Analyse" : "Remplissage"} — ${(report.durationMs / 1000).toFixed(1)}s — ${okCount}/${report.totalSteps} OK` +
      (warnCount ? `, ${warnCount} avertissement(s)` : "") +
      (errorCount ? `, ${errorCount} erreur(s)` : "");

    const list = qs("swatAfResults");
    list.style.display = "";
    list.innerHTML = "";
    report.results.forEach((r) => {
      const li = document.createElement("li");
      li.className = r.status;
      const icon = r.status === "ok" ? "✔" : r.status === "warn" ? "⚠" : "✖";
      li.innerHTML = `<span>${icon} ${r.label}</span><span class="d">${r.detail || ""}</span>`;
      list.appendChild(li);
    });

    showToast(errorCount ? `Terminé avec ${errorCount} problème(s)` : dryRun ? "Analyse terminée ✅" : "Remplissage terminé ✅");
  }

  function currentProfile() {
    const meta = PROFILES_INDEX.find((p) => p.id === state.selectedProfileId);
    if (!meta) return null;
    const base = meta.data;
    const override = state.profileOverrides ? state.profileOverrides[state.selectedProfileId] : null;
    return window.SwatEngine.mergeProfile(base, override);
  }

  qs("swatAfLaunch").addEventListener("click", async () => {
    // Voir le commentaire équivalent sur swatAfRefreshNames plus haut : sans
    // ce point de reprise différé, process() ouvrirait son premier menu
    // encore DANS la phase de bulle du clic sur ce bouton, avant que celui-ci
    // ait fini de remonter jusqu'à document — où un ClickAwayListener MUI de
    // la page pourrait le refermer aussitôt.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const profile = currentProfile();
    if (!profile) return;
    if (profile.verified === false) showToast("⚠ Profil non vérifié — vérifie le rapport après coup");

    const btn = qs("swatAfLaunch");
    btn.disabled = true;
    btn.textContent = "⏳ EN COURS…";
    try {
      const report = await window.SwatEngine.process(FIELD_MAP, profile, {
        dryRun: false,
        fillEditors: state.options.fillEditors,
        checkValidations: state.options.checkValidations,
        attemptWorkload: state.options.attemptWorkload,
        userValues: { intervenantName: state.selectedIntervenant, premierIntervenant: state.selectedIntervenant },
        onProgress: () => {} // le panneau affiche le rapport final ; pas de flux détaillé pas-à-pas ici
      });
      renderResults(report, { dryRun: false });
    } catch (err) {
      showToast("Erreur : " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "▶ LANCER";
    }
  });

  qs("swatAfDiagnose").addEventListener("click", async () => {
    // Voir le commentaire sur swatAfLaunch juste au-dessus.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const profile = currentProfile();
    if (!profile) return;
    const btn = qs("swatAfDiagnose");
    btn.disabled = true;
    btn.textContent = "⏳…";
    try {
      const report = await window.SwatEngine.process(FIELD_MAP, profile, { dryRun: true });
      renderResults(report, { dryRun: true });
    } catch (err) {
      showToast("Erreur : " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "🔍 Analyser";
    }
  });

  renderProfiles();
  renderIntervenants();
  if (state.selectedProfileId) {
    qs("swatAfLaunch").disabled = false;
    qs("swatAfDiagnose").disabled = false;
  }
})();

})();
