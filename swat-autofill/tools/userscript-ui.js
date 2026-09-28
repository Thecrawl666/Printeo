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
