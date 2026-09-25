/**
 * popup.js
 * -----------------------------------------------------------------------
 * UI popup : chargement dynamique des profils (core/profiles/*.json) et du
 * field-map (core/field-map.json), sélection de profil, options, thème,
 * lancement de l'automatisation dans l'onglet actif (mode réel OU
 * dry-run/"Analyser" — un seul pipeline, voir core/engine.js), suivi de
 * progression en temps réel, affichage du rapport, surcharges JSON.
 */

const DEFAULT_OPTIONS = {
  fillEditors: true,
  checkValidations: true,
  rememberLastProfile: true,
  showProgress: true,
  attemptWorkload: false
};

let state = {
  selectedProfileId: null,
  options: { ...DEFAULT_OPTIONS },
  darkMode: false,
  profileOverrides: null,
  profilesIndex: [],
  fieldMap: null,
  intervenantNames: [],
  selectedIntervenant: ""
};

const el = (id) => document.getElementById(id);

init();

async function init() {
  const stored = await chrome.storage.local.get([
    "darkMode",
    "lastProfile",
    "options",
    "profileOverrides",
    "intervenantName",
    "intervenantNamesCache"
  ]);

  state.darkMode = !!stored.darkMode;
  state.options = { ...DEFAULT_OPTIONS, ...(stored.options || {}) };
  state.profileOverrides = stored.profileOverrides || null;
  state.selectedIntervenant = stored.intervenantName || "";

  applyTheme();
  applyOptionsToUI();

  try {
    const [index, fieldMap] = await Promise.all([
      fetchJson("core/profiles/index.json"),
      fetchJson("core/field-map.json")
    ]);
    state.profilesIndex = index.profiles || [];
    state.fieldMap = fieldMap;
    renderProfileButtons();

    if (state.options.rememberLastProfile && stored.lastProfile) {
      const stillExists = state.profilesIndex.some((p) => p.id === stored.lastProfile);
      if (stillExists) selectProfile(stored.lastProfile);
    }
  } catch (err) {
    el("profilesSection").innerHTML = `<p class="profiles__loading">Erreur de chargement des profils : ${err.message}</p>`;
    console.error("[SWAT Autofill]", err);
  }

  try {
    if (stored.intervenantNamesCache && stored.intervenantNamesCache.length) {
      state.intervenantNames = stored.intervenantNamesCache;
    } else {
      const intervenants = await fetchJson("core/intervenants.json");
      state.intervenantNames = intervenants.names || [];
    }
    renderIntervenantList();
  } catch (err) {
    el("intervenantList").innerHTML = `<p class="intervenant-list__empty">Erreur de chargement de intervenants.json : ${err.message}</p>`;
    console.error("[SWAT Autofill]", err);
  }

  bindEvents();
  chrome.runtime.onMessage.addListener(onProgressMessage);
}

async function fetchJson(relativePath) {
  const res = await fetch(chrome.runtime.getURL(relativePath));
  if (!res.ok) throw new Error(`${relativePath} (${res.status})`);
  return res.json();
}

// -----------------------------------------------------------------------
// Thème
// -----------------------------------------------------------------------
function applyTheme() {
  document.documentElement.setAttribute("data-theme", state.darkMode ? "dark" : "light");
}

function toggleTheme() {
  state.darkMode = !state.darkMode;
  applyTheme();
  chrome.storage.local.set({ darkMode: state.darkMode });
}

// -----------------------------------------------------------------------
// Profils
// -----------------------------------------------------------------------
function renderProfileButtons() {
  const section = el("profilesSection");
  section.innerHTML = "";

  state.profilesIndex.forEach((p) => {
    const btn = document.createElement("button");
    btn.className = "profile-btn";
    btn.dataset.profile = p.id;

    const dot = document.createElement("span");
    dot.className = "profile-btn__dot";
    dot.style.background = p.color || "#888";
    btn.appendChild(dot);

    const label = document.createElement("span");
    label.textContent = p.label;
    btn.appendChild(label);

    btn.addEventListener("click", () => selectProfile(p.id));
    section.appendChild(btn);
  });
}

function selectProfile(profileId) {
  state.selectedProfileId = profileId;
  document.querySelectorAll(".profile-btn").forEach((btn) => {
    btn.classList.toggle("is-selected", btn.dataset.profile === profileId);
  });
  el("launchBtn").disabled = false;
  el("diagnoseBtn").disabled = false;
  if (state.options.rememberLastProfile) {
    chrome.storage.local.set({ lastProfile: profileId });
  }
}

// -----------------------------------------------------------------------
// Nom du premier intervenant
// -----------------------------------------------------------------------
function renderIntervenantList() {
  const container = el("intervenantList");
  container.innerHTML = "";

  if (!state.intervenantNames.length) {
    container.innerHTML = '<p class="intervenant-list__empty">Aucun nom configuré — ajoute-les dans core/intervenants.json</p>';
    return;
  }

  state.intervenantNames.forEach((name) => {
    const btn = document.createElement("button");
    btn.className = "intervenant-btn";
    btn.textContent = name;
    btn.classList.toggle("is-selected", name === state.selectedIntervenant);
    btn.addEventListener("click", () => selectIntervenant(name));
    container.appendChild(btn);
  });
}

function selectIntervenant(name) {
  state.selectedIntervenant = state.selectedIntervenant === name ? "" : name;
  document.querySelectorAll(".intervenant-btn").forEach((btn) => {
    btn.classList.toggle("is-selected", btn.textContent === state.selectedIntervenant);
  });
  chrome.storage.local.set({ intervenantName: state.selectedIntervenant });
}

async function refreshIntervenantNames() {
  const btn = el("intervenantRefresh");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳";

  try {
    const tab = await getActiveTab();
    await ensureInjected(tab);

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (fieldMap) => window.SwatAutofill.extractIntervenantNames(fieldMap),
      args: [state.fieldMap]
    });

    if (!result || !result.ok) {
      showToast("Échec : " + (result && result.error ? result.error : "erreur inconnue"));
      return;
    }
    if (!result.names.length) {
      showToast("Aucun nom trouvé — es-tu bien sur la page du formulaire RFC d'une swat ?");
      return;
    }

    state.intervenantNames = result.names;
    chrome.storage.local.set({ intervenantNamesCache: result.names });
    renderIntervenantList();
    showToast(`${result.names.length} nom(s) trouvé(s) — liste mise à jour`);
  } catch (err) {
    showToast("Erreur : " + err.message);
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// -----------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------
function applyOptionsToUI() {
  el("optFillEditors").checked = state.options.fillEditors;
  el("optCheckValidations").checked = state.options.checkValidations;
  el("optRememberProfile").checked = state.options.rememberLastProfile;
  el("optShowProgress").checked = state.options.showProgress;
  el("optAttemptWorkload").checked = state.options.attemptWorkload;
}

function readOptionsFromUI() {
  state.options = {
    fillEditors: el("optFillEditors").checked,
    checkValidations: el("optCheckValidations").checked,
    rememberLastProfile: el("optRememberProfile").checked,
    showProgress: el("optShowProgress").checked,
    attemptWorkload: el("optAttemptWorkload").checked
  };
  chrome.storage.local.set({ options: state.options });
}

// -----------------------------------------------------------------------
// Toast
// -----------------------------------------------------------------------
let toastTimer = null;
function showToast(message) {
  const toast = el("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2600);
}

// -----------------------------------------------------------------------
// Progression
// -----------------------------------------------------------------------
function resetProgressUI(total) {
  const list = el("progressList");
  list.innerHTML = "";
  el("progressFill").style.width = "0%";
  el("progressPercent").textContent = "0%";
  el("progressSection").classList.remove("hidden");
  el("reportSection").classList.add("hidden");

  for (let i = 0; i < total; i++) {
    const li = document.createElement("li");
    li.dataset.step = String(i + 1);
    li.className = "status-pending";
    li.textContent = "○ …";
    list.appendChild(li);
  }
}

function onProgressMessage(message) {
  if (message.type !== "swat-progress") return;
  if (!state.options.showProgress) return;

  const { step, total, label, status } = message;
  const percent = Math.round((step / total) * 100);
  el("progressFill").style.width = percent + "%";
  el("progressPercent").textContent = percent + "%";

  const list = el("progressList");
  let li = list.querySelector(`li[data-step="${step}"]`);
  if (!li) {
    li = document.createElement("li");
    li.dataset.step = String(step);
    list.appendChild(li);
  }
  li.className = `status-${status}`;
  const icon = status === "done" ? "✔" : status === "error" ? "✖" : "…";
  li.textContent = `${icon} ${label}`;
  li.scrollIntoView({ block: "nearest" });
}

// -----------------------------------------------------------------------
// Rendu du rapport — un seul format ({durationMs, results[]}), utilisé pour
// le remplissage réel ET l'analyse (dry-run). C'est le pipeline unique de
// core/engine.js (process()) qui produit cette forme dans les deux cas.
// -----------------------------------------------------------------------
function summarize(results) {
  return {
    okCount: results.filter((r) => r.status === "ok").length,
    warnCount: results.filter((r) => r.status === "warn").length,
    errorCount: results.filter((r) => r.status === "error").length
  };
}

function renderReport(report) {
  el("reportSection").classList.remove("hidden");
  const { okCount, errorCount } = summarize(report.results);

  el("reportDuration").textContent = (report.durationMs / 1000).toFixed(1) + "s";
  el("reportFilled").textContent = `${okCount}/${report.totalSteps}`;
  el("reportErrors").textContent = String(errorCount);

  const errorList = el("reportErrorList");
  errorList.innerHTML = "";
  report.results
    .filter((r) => r.status === "error")
    .forEach((r) => {
      const li = document.createElement("li");
      li.textContent = `${r.label} (${r.detail})`;
      errorList.appendChild(li);
    });
}

let lastDiagnosticText = "";

function renderDiagnostic(diag, profile) {
  const { okCount, warnCount, errorCount } = summarize(diag.results);

  el("diagnosticSection").classList.remove("hidden");
  el("diagnosticSummary").textContent =
    `${profile.label || state.selectedProfileId} — ${(diag.durationMs / 1000).toFixed(1)}s — ` +
    `${okCount} OK, ${warnCount} avertissement(s), ${errorCount} erreur(s)`;

  const list = el("diagnosticList");
  list.innerHTML = "";
  diag.results.forEach((r) => {
    const li = document.createElement("li");
    li.className = `status-${r.status}`;
    const icon = r.status === "ok" ? "✔" : r.status === "warn" ? "⚠" : "✖";

    const labelEl = document.createElement("span");
    labelEl.className = "diagnostic__label";
    labelEl.textContent = `${icon} ${r.label}`;

    const detailEl = document.createElement("span");
    detailEl.className = "diagnostic__detail";
    detailEl.textContent = r.detail;

    li.appendChild(labelEl);
    li.appendChild(detailEl);
    list.appendChild(li);
  });

  lastDiagnosticText =
    `SWAT Autofill — Rapport d'analyse\n` +
    `Profil : ${profile.label || state.selectedProfileId}\n` +
    `Durée : ${(diag.durationMs / 1000).toFixed(1)}s — ${okCount} OK, ${warnCount} avertissement(s), ${errorCount} erreur(s)\n\n` +
    diag.results.map((r) => `${r.status === "ok" ? "✔" : r.status === "warn" ? "⚠" : "✖"} ${r.label}\n   ${r.detail}`).join("\n");

  showToast(errorCount ? `Analyse terminée — ${errorCount} erreur(s)` : "Analyse terminée ✅");
}

// -----------------------------------------------------------------------
// Fusion d'une surcharge JSON par-dessus un profil
// -----------------------------------------------------------------------
function mergeProfile(base, override) {
  if (!override) return base;
  const merged = JSON.parse(JSON.stringify(base));
  ["fields", "editors", "checkboxes", "workload"].forEach((section) => {
    if (override[section]) merged[section] = { ...(merged[section] || {}), ...override[section] };
  });
  return merged;
}

// -----------------------------------------------------------------------
// Préparation commune (lancement ET diagnostic)
// -----------------------------------------------------------------------
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("Aucun onglet actif détecté");
  return tab;
}

async function ensureInjected(tab) {
  const [{ result: alreadyInjected }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => !!window.__swatInjected
  });

  if (!alreadyInjected) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["core/engine.js", "content.js"]
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        window.__swatInjected = true;
      }
    });
  }
}

async function prepareRun() {
  const profileMeta = state.profilesIndex.find((p) => p.id === state.selectedProfileId);
  const baseProfile = await fetchJson(`core/${profileMeta.file}`);
  const override = state.profileOverrides ? state.profileOverrides[state.selectedProfileId] : null;
  const profile = mergeProfile(baseProfile, override);

  const tab = await getActiveTab();
  await ensureInjected(tab);

  return { tab, profile };
}

// -----------------------------------------------------------------------
// Lancement de l'automatisation (mode réel)
// -----------------------------------------------------------------------
async function launch() {
  if (!state.selectedProfileId) return;

  const launchBtn = el("launchBtn");
  launchBtn.disabled = true;
  launchBtn.textContent = "⏳ EN COURS…";

  try {
    const { tab, profile } = await prepareRun();

    if (profile.verified === false) {
      showToast("⚠ Profil non vérifié — les catégories peuvent être fausses, vérifie le rapport");
    }

    const checkboxCount =
      state.options.checkValidations === false
        ? 0
        : state.fieldMap.checkboxes.filter((cb) => profile.checkboxes && profile.checkboxes[cb.key]).length;
    const estimatedSteps =
      state.fieldMap.sequence.length +
      (state.options.fillEditors ? 2 : 0) +
      checkboxCount +
      (state.options.attemptWorkload && profile.workload && profile.workload.enabled ? 1 : 0);
    resetProgressUI(estimatedSteps);

    const intervenantName = state.selectedIntervenant;
    const [{ result: report }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (fieldMap, profile, options) => window.SwatAutofill.process(fieldMap, profile, options),
      args: [
        state.fieldMap,
        profile,
        {
          dryRun: false,
          fillEditors: state.options.fillEditors,
          checkValidations: state.options.checkValidations,
          attemptWorkload: state.options.attemptWorkload,
          userValues: { intervenantName, premierIntervenant: intervenantName }
        }
      ]
    });

    if (!report || !report.ok) {
      showToast((report && report.results && report.results[0] && report.results[0].detail) || "Échec de l'automatisation");
      return;
    }

    renderReport(report);
    const { errorCount } = summarize(report.results);
    showToast(errorCount ? `Terminé avec ${errorCount} problème(s)` : "Tous les champs ont été remplis avec succès ✅");
  } catch (err) {
    showToast("Erreur : " + err.message);
    console.error(err);
  } finally {
    launchBtn.disabled = false;
    launchBtn.textContent = "▶ LANCER";
  }
}

// -----------------------------------------------------------------------
// Diagnostic complet — bouton "🔍 Analyser" — même pipeline que "▶ LANCER",
// juste avec dryRun:true (voir core/engine.js).
// -----------------------------------------------------------------------
async function runDiagnostics() {
  if (!state.selectedProfileId) return;

  const diagnoseBtn = el("diagnoseBtn");
  diagnoseBtn.disabled = true;
  diagnoseBtn.textContent = "⏳ Analyse…";
  el("progressSection").classList.add("hidden");
  el("reportSection").classList.add("hidden");

  try {
    const { tab, profile } = await prepareRun();

    const [{ result: diag }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (fieldMap, profile) => window.SwatAutofill.process(fieldMap, profile, { dryRun: true }),
      args: [state.fieldMap, profile]
    });

    if (!diag || !diag.ok) {
      showToast("Échec de l'analyse");
      return;
    }

    renderDiagnostic(diag, profile);
  } catch (err) {
    showToast("Erreur : " + err.message);
    console.error(err);
  } finally {
    diagnoseBtn.disabled = false;
    diagnoseBtn.textContent = "🔍 Analyser";
  }
}

async function copyDiagnostic() {
  if (!lastDiagnosticText) {
    showToast("Lance d'abord une analyse");
    return;
  }
  try {
    await navigator.clipboard.writeText(lastDiagnosticText);
    showToast("Rapport copié dans le presse-papiers");
  } catch (err) {
    showToast("Impossible de copier : " + err.message);
  }
}

// -----------------------------------------------------------------------
// Paramètres (édition JSON des surcharges, par identifiant de profil)
// -----------------------------------------------------------------------
function openSettings() {
  const data = state.profileOverrides || {};
  el("profilesJson").value = Object.keys(data).length ? JSON.stringify(data, null, 2) : "";
  el("settingsError").classList.add("hidden");
  el("settingsModal").classList.remove("hidden");
}

function closeSettings() {
  el("settingsModal").classList.add("hidden");
}

function saveSettings() {
  const raw = el("profilesJson").value.trim();
  if (!raw) {
    state.profileOverrides = null;
    chrome.storage.local.set({ profileOverrides: null });
    closeSettings();
    showToast("Surcharges réinitialisées — profils par défaut utilisés");
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    state.profileOverrides = parsed;
    chrome.storage.local.set({ profileOverrides: parsed });
    closeSettings();
    showToast("Surcharges enregistrées");
  } catch (e) {
    el("settingsError").textContent = "JSON invalide : " + e.message;
    el("settingsError").classList.remove("hidden");
  }
}

function resetSettings() {
  el("profilesJson").value = "";
}

// -----------------------------------------------------------------------
// Bindings
// -----------------------------------------------------------------------
function bindEvents() {
  el("themeToggle").addEventListener("click", toggleTheme);
  el("launchBtn").addEventListener("click", launch);
  el("diagnoseBtn").addEventListener("click", runDiagnostics);
  el("diagnosticCopy").addEventListener("click", copyDiagnostic);
  el("intervenantRefresh").addEventListener("click", refreshIntervenantNames);

  el("optionsToggle").addEventListener("click", () => {
    el("optionsToggle").parentElement.classList.toggle("is-open");
  });

  ["optFillEditors", "optCheckValidations", "optRememberProfile", "optShowProgress", "optAttemptWorkload"].forEach((id) => {
    el(id).addEventListener("change", readOptionsFromUI);
  });

  el("settingsBtn").addEventListener("click", openSettings);
  el("settingsClose").addEventListener("click", closeSettings);
  el("settingsSave").addEventListener("click", saveSettings);
  el("settingsReset").addEventListener("click", resetSettings);
  el("settingsModal").addEventListener("click", (e) => {
    if (e.target.id === "settingsModal") closeSettings();
  });
}
