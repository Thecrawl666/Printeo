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
        : {
            ok: false,
            warn: true,
            detail:
              `valeur "${textToSelect}" INTROUVABLE dans la liste actuellement affichée — ` +
              `si ce champ dépend d'un autre choisi plus haut (ex. une liste en cascade), ` +
              `ce peut être un faux avertissement : l'analyse n'écrit jamais rien, donc le ` +
              `champ dont celui-ci dépend n'a pas encore été réellement sélectionné à ce ` +
              `stade — vérifie avec ▶ LANCER, qui remplit dans l'ordre et donc dans le bon contexte`
          };
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
  /**
   * Sélectionne tout le contenu de `el` (sélection native + un vrai Ctrl+A
   * dispatché, que CKEditor 5 écoute pour agir sur son modèle interne — cf
   * commentaire historique plus bas).
   */
  async function selectAllContent(el) {
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
  }

  function normalizedInnerText(el) {
    return (el.innerText || "").replace(/\s+/g, " ").trim();
  }

  /**
   * v3.1.0 — CKEditor 5 garde un MODÈLE interne séparé du DOM affiché : si
   * un collage ne passe pas par son pipeline officiel (plugin Clipboard),
   * le DOM peut changer un court instant puis être "réparé" (re-rendu à
   * partir du modèle, resté inchangé) dès que l'éditeur se re-synchronise
   * — ce qui ressemble à un succès immédiat suivi d'une disparition. La
   * vérification précédente (un seul contrôle ~300ms après le collage) ne
   * pouvait pas distinguer ça d'un vrai succès. Ici : un contrôle immédiat
   * ET un second après un délai de stabilisation, qui doivent TOUS LES
   * DEUX confirmer le contenu attendu.
   *
   * @returns {Promise<"ok"|"never-applied"|"reverted">}
   */
  async function verifyContentSettles(el, expectedSlice, settleMs = 1200) {
    await sleep(300);
    const immediate = normalizedInnerText(el).includes(expectedSlice);
    if (!immediate) return "never-applied";

    await sleep(settleMs);
    const settled = normalizedInnerText(el).includes(expectedSlice);
    return settled ? "ok" : "reverted";
  }

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
    const newPlainText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const expectedSlice = newPlainText.slice(0, 15);

    el.focus();
    await sleep(80);

    // ---- tentative 1 : évènement 'paste' simulé (pipeline officiel de
    // CKEditor 5, cf historique v2.2.0) ------------------------------------
    await selectAllContent(el);

    // La promesse de confirmation réseau est créée AVANT de dispatcher le
    // collage : l'application peut déclencher son auto-save très vite après
    // la modification du DOM — l'attendre seulement après les vérifications
    // ci-dessous risquerait de rater l'évènement s'il arrive entre-temps.
    let savePromise = waitForSave(8000);

    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/html", html);
    dataTransfer.setData("text/plain", beforeText);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dataTransfer, bubbles: true, cancelable: true }));

    let outcome = await verifyContentSettles(el, expectedSlice);

    // ---- tentative 2 (repli) : document.execCommand('insertHTML', …) —
    // mécanisme d'édition natif du navigateur, indépendant du plugin
    // Clipboard de CKEditor. À la différence du collage simulé, il déclenche
    // de vraies mutations DOM + évènements 'input' natifs, que CKEditor 5
    // réconcilie normalement avec son modèle au même titre qu'une saisie
    // clavier réelle — utile si le plugin Clipboard ne traite pas notre
    // évènement synthétique comme un collage valide (ex. DataTransfer
    // construit par script jugé incomplet). Tenté uniquement si la 1re
    // méthode n'a jamais pris OU a été annulée par CKEditor après coup.
    if (outcome !== "ok") {
      await selectAllContent(el);
      savePromise = waitForSave(8000);
      let execOk = false;
      try {
        execOk = document.execCommand("insertHTML", false, html);
      } catch (e) {
        execOk = false;
      }
      outcome = execOk ? await verifyContentSettles(el, expectedSlice) : "never-applied";

      if (outcome !== "ok") {
        const afterText = normalizedInnerText(el);
        const reason =
          outcome === "reverted"
            ? "le texte a été inséré (collage simulé puis document.execCommand) mais annulé par l'éditeur peu après — CKEditor a probablement rejeté les deux tentatives et restauré son contenu par défaut : à corriger manuellement, et à remonter avec le détail exact vu à l'écran"
            : "ni le collage simulé ni document.execCommand n'ont modifié le contenu visible — vérifier manuellement";
        return { ok: false, detail: `${reason} (contenu actuel : ${afterText.length} caractères)` };
      }
    }

    const afterText = normalizedInnerText(el);
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
      return { ok: true, warn: true, detail: "collage confirmé et stable, mais aucune confirmation réseau de sauvegarde reçue après 8s — vérifie manuellement avant de changer d'onglet si possible" };
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
      // Le corps d'une réponse d'erreur (403 notamment) explique souvent la
      // vraie raison côté serveur (jeton manquant, origine refusée, règle
      // métier…) — l'inclure ici évite d'avoir à redemander une capture
      // .har rien que pour voir ce texte. Best-effort : certaines réponses
      // d'erreur n'ont pas de corps lisible, ou `res.text()` peut lui-même
      // échouer (flux déjà consommé, connexion coupée) — jamais bloquant.
      let bodySnippet = "";
      try {
        const body = await res.text();
        if (body) bodySnippet = ` — corps de la réponse : ${body.slice(0, 300)}`;
      } catch (e) {
        // ignoré, best-effort
      }
      const err = new Error(`HTTP ${res.status} sur ${url}${bodySnippet}`);
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
