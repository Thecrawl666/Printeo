#!/usr/bin/env node
/**
 * run-tests.mjs — suite de régression automatisée
 * -----------------------------------------------------------------------
 * Remplace le principe de développement de la v2 ("patch, redistribue à
 * Alex, attends un test en conditions réelles sur un VRAI enregistrement
 * aérospatial, recommence") par : "vérifie contre une page de test fidèle
 * AVANT toute chose". La page de test (tests/fixture/swatsheet-fixture.html)
 * reproduit les comportements DOM/React/MUI/CKEditor5 dont core/engine.js
 * dépend, ainsi que les 5 appels API impliqués dans la création de
 * Workload et la détection de sauvegarde — pas l'application réelle, mais
 * assez fidèle pour attraper la quasi-totalité des régressions listées
 * dans CHANGELOG.md (v2.0 à v2.8) avant un test réel.
 *
 * Trois suites :
 *   A. Moteur (core/engine.js) — injecté directement dans la page, sans
 *      aucune extension ni userscript autour. C'est le coeur partagé par
 *      les deux variantes ci-dessous.
 *   B. Variante userscript (userscript/swat-autofill.user.js) — injecté
 *      tel quel, comme le ferait Tampermonkey/Violentmonkey.
 *   C. Variante extension (manifest.json, packagée telle qu'on la charge
 *      en "non empaquetée" dans chrome://extensions ou edge://extensions).
 *
 * Chromium (headless "new", qui supporte les extensions MV3) est le même
 * moteur de rendu que Google Chrome ET Microsoft Edge (Edge est basé sur
 * Chromium depuis la v79, et consomme le même namespace chrome.* pour les
 * extensions) — voir README.md, section "Tests" pour le détail de ce que
 * ça couvre et ce que ça ne couvre pas.
 *
 * Usage : node tests/run-tests.mjs
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE_PATH = path.join(ROOT, "tests/fixture/swatsheet-fixture.html");
const FIXTURE_ORIGIN = "https://swatsheet.ca.aero.bombardier.net";
const FIXTURE_PATHNAME = "/swatsheet/SW-236-127/rfc";

const methodesProfile = JSON.parse(readFileSync(path.join(ROOT, "core/profiles/methodes-ebenisterie.json"), "utf8"));
const fieldMap = JSON.parse(readFileSync(path.join(ROOT, "core/field-map.json"), "utf8"));

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ✖ ${name}`);
    console.log(`      ${err.message}`);
  }
}

/**
 * Mock réseau des mêmes endpoints que le <script> inline de la fixture
 * (tests/fixture/swatsheet-fixture.html), au niveau réseau plutôt qu'en
 * surchargeant window.fetch côté page. Depuis le pont fetch d'inject.js
 * (v3.2.0), la suite C route ses appels Workload par le window.fetch de LA
 * PAGE — donc par le mock JS de la fixture, comme les suites A/B — ce mock
 * réseau Node ne sert plus de chemin principal pour ces appels, mais reste
 * utile comme garde-fou : si le pont n'était pas disponible pour une raison
 * quelconque, un fetch() isolé du content script tomberait ici plutôt que
 * de sortir sur le vrai réseau (voir routeFixture ci-dessous, qui bloque
 * tout le reste).
 */
const networkCallLog = { workloadPayload: null };

function mockApiResponse(url, method, postDataJson) {
  const json = (data, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(data) });
  if (/\/api\/swatsheet\/parent\/SW-\d+-\d+\/parentId/i.test(url.pathname)) {
    return { status: 200, contentType: "text/plain", body: "424242" };
  }
  if (/\/api\/bdi\/groups$/i.test(url.pathname)) {
    return json([
      { id: 4185, name: "MET-SUP54" },
      { id: 4186, name: "PROD-SUP54" },
      { id: 4187, name: "CNC-SUP54" },
      { id: 4188, name: "ING-SUP54" },
      { id: 4189, name: "PROG-SUP54" }
    ]);
  }
  const gm = url.pathname.match(/\/api\/bdi\/groups\/(\d+)\/users-relation/);
  if (gm) return json([{ userId: 77, name: "Alex Alfonsi" }]);
  if (/\/api\/workload\/create\/\d+/i.test(url.pathname) && method === "POST") {
    networkCallLog.workloadPayload = postDataJson;
    return json({ hasError: false, data: { workloadNumber: "WL-000123" } });
  }
  if (/\/api\/swatsheet\/reviewandapprove\/update/i.test(url.pathname) && method === "PUT") {
    return json({ ok: true });
  }
  return null;
}

async function routeFixture(context) {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === FIXTURE_ORIGIN && url.pathname === FIXTURE_PATHNAME) {
      let html = readFileSync(FIXTURE_PATH, "utf8");
      return route.fulfill({ status: 200, contentType: "text/html", body: html });
    }
    if (url.origin === FIXTURE_ORIGIN) {
      let postDataJson = null;
      try {
        postDataJson = route.request().postDataJSON();
      } catch (e) {
        // pas de corps JSON (GET) — normal, on ignore
      }
      const mocked = mockApiResponse(url, route.request().method(), postDataJson);
      if (mocked) return route.fulfill(mocked);
    }
    // chrome-extension:// n'est jamais un appel réseau réel (lecture de
    // fichiers locaux de l'extension — popup.css/popup.js/core/*.json) : le
    // laisser passer. Seul du vrai trafic http(s) hors fixture est bloqué,
    // pour garder les tests hermétiques à tout accès réseau accidentel.
    if (url.protocol === "chrome-extension:") return route.continue();
    return route.abort();
  });
}

function fixtureUrl(scenarioQuery = "") {
  return `${FIXTURE_ORIGIN}${FIXTURE_PATHNAME}${scenarioQuery}`;
}

// =========================================================================
// Suite A — core/engine.js seul, injecté directement dans la page fixture
// =========================================================================
async function suiteA(browser) {
  console.log("\n[A] Moteur core/engine.js (injection directe, sans extension ni userscript)");
  const context = await browser.newContext();
  await routeFixture(context);

  async function freshPage(scenarioQuery = "") {
    const page = await context.newPage();
    await page.goto(fixtureUrl(scenarioQuery));
    await page.addScriptTag({ path: path.join(ROOT, "core/engine.js") });
    return page;
  }

  await test("remplissage réel — profil Méthodes ébénisterie, tous les champs OK", async () => {
    const page = await freshPage();
    const report = await page.evaluate(
      async ([fieldMap, profile]) => {
        return window.SwatEngine.process(fieldMap, profile, {
          dryRun: false,
          fillEditors: true,
          checkValidations: true,
          attemptWorkload: true,
          userValues: { intervenantName: "Alex Alfonsi", premierIntervenant: "Alex Alfonsi" }
        });
      },
      [fieldMap, methodesProfile]
    );
    const errors = report.results.filter((r) => r.status === "error");
    assert.equal(errors.length, 0, "aucune erreur attendue, obtenu: " + JSON.stringify(errors, null, 2));
    assert.equal(report.results.find((r) => r.key === "requiredBefore").status, "ok");
    assert.equal(report.results.find((r) => r.key === "solutionFinale").status, "ok");
    assert.equal(report.results.find((r) => r.key === "planAction").status, "ok");
    assert.equal(report.results.find((r) => r.key === "workload").status, "ok");

    const savedText = await page.evaluate(() => document.querySelectorAll(".ck-editor__editable")[0].innerText);
    assert.ok(savedText.includes("Solution Finale"), "le texte collé doit être présent dans l'éditeur");

    const priorityChecked = await page.evaluate(() => document.querySelector('input[name="priority"]').checked);
    assert.equal(priorityChecked, true);

    const saveCount = await page.evaluate(() => window.__calls.saveCount);
    assert.ok(saveCount >= 1, "le PUT de sauvegarde doit avoir été observé au moins une fois");

    const workloadPayload = await page.evaluate(() => window.__calls.workloadPayload);
    assert.equal(workloadPayload.assignedBdiGroup, 4185, "groupe MET-SUP54 -> id 4185");
    await page.close();
  });

  await test("analyse (dryRun) — ne modifie RIEN sur la page", async () => {
    const page = await freshPage();
    const before = await page.evaluate(() => document.querySelector('input[name="requiredBefore"]').value);
    const diag = await page.evaluate(
      ([fieldMap, profile]) => window.SwatEngine.process(fieldMap, profile, { dryRun: true }),
      [fieldMap, methodesProfile]
    );
    const after = await page.evaluate(() => document.querySelector('input[name="requiredBefore"]').value);
    assert.equal(before, after, "la valeur ne doit pas changer en dryRun");
    assert.equal(before, "", "le champ doit rester vide (rien coché/sélectionné) en dryRun");
    const errors = diag.results.filter((r) => r.status === "error");
    assert.equal(errors.length, 0, "aucune erreur attendue en analyse sur ce profil vérifié : " + JSON.stringify(errors));
    const priorityChecked = await page.evaluate(() => document.querySelector('input[name="priority"]').checked);
    assert.equal(priorityChecked, false, "la case ne doit pas être cochée par une simple analyse");
    const saveCount = await page.evaluate(() => window.__calls.saveCount);
    assert.equal(saveCount, 0, "aucune sauvegarde réseau ne doit partir en dryRun");
    const workloadCalled = await page.evaluate(() => window.__calls.workloadCreateCalled);
    assert.equal(workloadCalled, false, "le POST de création de Workload ne doit JAMAIS partir en dryRun");
    await page.close();
  });

  await test("option introuvable dans la liste -> avertissement en dryRun, erreur en remplissage réel", async () => {
    const page = await freshPage("?missingOption=1");
    const diag = await page.evaluate(
      ([fieldMap, profile]) => window.SwatEngine.process(fieldMap, profile, { dryRun: true }),
      [fieldMap, methodesProfile]
    );
    assert.equal(diag.results.find((r) => r.key === "causeCategorie").status, "warn");

    const page2 = await freshPage("?missingOption=1");
    const report = await page2.evaluate(
      ([fieldMap, profile]) => window.SwatEngine.process(fieldMap, profile, { dryRun: false, attemptWorkload: false }),
      [fieldMap, methodesProfile]
    );
    assert.equal(report.results.find((r) => r.key === "causeCategorie").status, "error");
    await page.close();
    await page2.close();
  });

  await test("case à cocher requise mais désactivée -> avertissement en dryRun, erreur en remplissage réel", async () => {
    const page = await freshPage("?lockedPriority=1");
    const diag = await page.evaluate(
      ([fieldMap, profile]) => window.SwatEngine.process(fieldMap, profile, { dryRun: true }),
      [fieldMap, methodesProfile]
    );
    assert.equal(diag.results.find((r) => r.key === "priorite").status, "warn");

    const page2 = await freshPage("?lockedPriority=1");
    const report = await page2.evaluate(
      ([fieldMap, profile]) => window.SwatEngine.process(fieldMap, profile, { dryRun: false, attemptWorkload: false }),
      [fieldMap, methodesProfile]
    );
    assert.equal(report.results.find((r) => r.key === "priorite").status, "error");
    await page.close();
    await page2.close();
  });

  await test("case désactivée mais NON utilisée par ce profil -> pas d'avertissement (documents)", async () => {
    const page = await freshPage();
    const diag = await page.evaluate(
      ([fieldMap, profile]) => window.SwatEngine.process(fieldMap, profile, { dryRun: true }),
      [fieldMap, methodesProfile]
    );
    assert.equal(diag.results.find((r) => r.key === "documents").status, "ok");
    await page.close();
  });

  await test("éditeur verrouillé (lecture seule) -> détecté sans tenter de collage", async () => {
    const page = await freshPage("?readonlyEditor=1");
    const report = await page.evaluate(
      ([fieldMap, profile]) => window.SwatEngine.process(fieldMap, profile, { dryRun: false, checkValidations: false, attemptWorkload: false }),
      [fieldMap, methodesProfile]
    );
    assert.equal(report.results.find((r) => r.key === "planAction").status, "error");
    assert.match(report.results.find((r) => r.key === "planAction").detail, /lecture seule/i);
    await page.close();
  });

  await test("duplication de contenu (ancien texte non effacé) -> détectée et signalée comme erreur", async () => {
    const page = await freshPage("?dupEditor=1");
    const report = await page.evaluate(
      ([fieldMap, profile]) => window.SwatEngine.process(fieldMap, profile, { dryRun: false, checkValidations: false, attemptWorkload: false }),
      [fieldMap, methodesProfile]
    );
    assert.equal(report.results.find((r) => r.key === "solutionFinale").status, "error");
    assert.match(report.results.find((r) => r.key === "solutionFinale").detail, /pas été supprimé/i);
    await page.close();
  });

  await test("collage annulé par l'éditeur (CKEditor 'répare' le DOM) -> repli document.execCommand, contenu final correct et stable", async () => {
    // Reproduit le bug réel trouvé sur swatsheet.ca.aero.bombardier.net le
    // 2026-09-25 (SW-236-359) : le collage simulé modifiait le DOM un
    // instant, mais le texte par défaut de Bombardier revenait après coup —
    // signe que CKEditor n'avait jamais traité l'évènement comme un vrai
    // collage (son modèle interne, resté inchangé, "réparait" le DOM).
    const page = await freshPage("?revertPaste=1");
    const report = await page.evaluate(
      ([fieldMap, profile]) =>
        window.SwatEngine.process(fieldMap, profile, { dryRun: false, checkValidations: false, attemptWorkload: false }),
      [fieldMap, methodesProfile]
    );
    const solutionFinale = report.results.find((r) => r.key === "solutionFinale");
    assert.notEqual(solutionFinale.status, "error", "le repli execCommand doit rattraper le collage annulé : " + JSON.stringify(solutionFinale));

    // Le contenu doit être celui du PROFIL, pas resté celui par défaut de
    // Bombardier (exactement le symptôme observé en réel).
    const finalText = await page.evaluate(() => document.querySelectorAll(".ck-editor__editable")[0].innerText);
    assert.match(finalText, /Solution Finale/, "le contenu final doit être celui du profil, pas le texte par défaut inséré par Bombardier");
    assert.doesNotMatch(finalText, /Texte par défaut inséré par Bombardier/, "le texte par défaut ne doit plus être présent");
    await page.close();
  });

  await test("Workload — groupe introuvable côté API -> création annulée avec raison claire, aucun POST envoyé", async () => {
    const page = await freshPage("?missingGroup=1");
    const report = await page.evaluate(
      ([fieldMap, profile]) => window.SwatEngine.process(fieldMap, profile, { dryRun: false, fillEditors: false, checkValidations: false, attemptWorkload: true }),
      [fieldMap, methodesProfile]
    );
    assert.equal(report.results.find((r) => r.key === "workload").status, "error");
    assert.match(report.results.find((r) => r.key === "workload").detail, /introuvable/i);
    const called = await page.evaluate(() => window.__calls.workloadCreateCalled);
    assert.equal(called, false, "jamais de POST si la résolution a échoué — pas d'ID deviné");
    await page.close();
  });

  await test("extraction de la liste des intervenants (bouton 🔄) — lecture seule", async () => {
    const page = await freshPage();
    const result = await page.evaluate((fieldMap) => window.SwatEngine.extractIntervenantNames(fieldMap), fieldMap);
    assert.equal(result.ok, true);
    assert.deepEqual(result.names, ["Alex Alfonsi", "Autre Personne"]);
    const value = await page.evaluate(() => {
      const roots = document.querySelectorAll(".MuiFormControl-root");
      return roots[0].querySelector("input").value;
    });
    assert.equal(value, "", "l'extraction ne doit rien sélectionner");
    await page.close();
  });

  await context.close();
}

// =========================================================================
// Suite B — variante userscript, injectée telle quelle (comme Tampermonkey)
// =========================================================================
async function suiteB(browser) {
  console.log("\n[B] Variante userscript (injection directe, comme Tampermonkey/Violentmonkey)");
  const context = await browser.newContext();
  await routeFixture(context);

  await test("panneau flottant injecté + remplissage complet via l'UI", async () => {
    const page = await context.newPage();
    await page.goto(fixtureUrl());

    let src = readFileSync(path.join(ROOT, "userscript/swat-autofill.user.js"), "utf8");
    // Retire le bloc de métadonnées ==UserScript==, propre au gestionnaire
    // de userscripts (Tampermonkey ne l'exécute pas comme du JS) — le reste
    // est du JavaScript standard, injectable tel quel.
    src = src.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n/, "");
    await page.addScriptTag({ content: src });

    await page.waitForSelector(".swat-af-root");
    const profileButtons = await page.locator(".swat-af-root .swat-af-chip").count();
    assert.ok(profileButtons >= 5, "au moins les 5 profils ébénisterie doivent apparaître comme puces cliquables");

    await page.getByText("Méthodes ébénisterie", { exact: false }).click();
    await page.locator("#swatAfLaunch").click();

    await page.waitForFunction(() => {
      const el = document.querySelector("#swatAfSummary");
      return el && el.textContent && el.textContent.length > 0;
    });

    const summary = await page.locator("#swatAfSummary").textContent();
    assert.doesNotMatch(summary, /erreur/i, "le résumé ne doit signaler aucune erreur : " + summary);

    const requiredBefore = await page.evaluate(() => document.querySelector('input[name="requiredBefore"]').value);
    assert.equal(requiredBefore, "FABRICATION (M)");

    const priorityChecked = await page.evaluate(() => document.querySelector('input[name="priority"]').checked);
    assert.equal(priorityChecked, true);

    await page.close();
  });

  await context.close();
}

// =========================================================================
// Suite C — variante extension : chargée "non empaquetée" comme dans
// chrome://extensions ou edge://extensions, avec Manifest V3 standard.
// =========================================================================
async function suiteC() {
  console.log("\n[C] Variante extension (chargée non-empaquetée, Manifest V3 — Chrome & Edge)");

  const userDataDir = path.join(ROOT, "tests/.tmp-user-data");
  const context = await chromium.launchPersistentContext(userDataDir, {
    // channel:"chromium" est ESSENTIEL ici : sans lui, Playwright lance par
    // défaut le binaire "headless_shell" (mode headless historique) quand
    // headless:true, qui NE SUPPORTE PAS les extensions et ajoute même son
    // propre --disable-extensions en argument par défaut — le service
    // worker de l'extension ne démarre alors jamais, silencieusement
    // (trouvé en comparant `ps` d'un lancement direct vs. via Playwright,
    // voir README.md § Tests). channel:"chromium" force le vrai binaire
    // Chrome/Chromium, qui supporte les extensions en --headless=new.
    channel: "chromium",
    headless: true,
    args: [
      "--headless=new",
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      "--no-sandbox"
    ]
  });
  await routeFixture(context);

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 10000 });
    const extensionId = new URL(sw.url()).host;

    await test("le service worker (background.js) démarre sans erreur et initialise le storage par défaut", async () => {
      // chrome.runtime.onInstalled (qui écrit les valeurs par défaut) est
      // asynchrone et n'est pas garanti terminé dès que le service worker
      // apparaît dans context.serviceWorkers() — on patiente un peu plutôt
      // que de vérifier au tout premier instant.
      const hasDefaults = await sw.evaluate(async () => {
        for (let i = 0; i < 20; i++) {
          const stored = await chrome.storage.local.get(["options"]);
          if (stored.options) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return false;
      });
      assert.equal(hasDefaults, true);
    });

    // Les id d'onglet AVANT ouverture de la fixture, pour la repérer par
    // différence plus bas — le manifest ne demande QUE "activeTab" (le
    // strict nécessaire pour popup.js en usage réel, cf manifest.json),
    // jamais la permission large "tabs" : chrome.tabs.query({}) depuis le
    // service worker ne renvoie donc PAS `url`/`title` pour des onglets que
    // l'extension n'a pas explicitement le droit de lire (aucun de ceux
    // ouverts ici, en dehors d'un vrai geste utilisateur sur l'icône) —
    // seul `id` reste toujours lisible, d'où le diff plutôt qu'un filtre
    // par URL.
    const idsBefore = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.id));
    const fixturePage = await context.newPage();
    await fixturePage.goto(fixtureUrl());
    const fixtureTabId = await sw.evaluate(async (before) => {
      const tabs = await chrome.tabs.query({});
      const created = tabs.map((t) => t.id).find((id) => !before.includes(id));
      return created ?? null;
    }, idsBefore);
    assert.ok(fixtureTabId, "impossible d'identifier l'onglet fixture par diff d'ids");

    await test("popup.html charge bien core/field-map.json et les 5 profils via chrome.runtime.getURL", async () => {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.waitForSelector(".profile-btn", { timeout: 8000 });
      const count = await popup.locator(".profile-btn").count();
      assert.equal(count, 5, "profiles/index.json liste 5 profils ébénisterie");
      await popup.close();
    });

    await test("remplissage réel de bout en bout, orchestré comme le ferait popup.js (content.js + core/engine.js + inject.js)", async () => {
      // Compte les requêtes passées par le pont fetch d'inject.js (voir
      // core/engine.js, pageFetch()) — sert plus bas à prouver que la
      // résolution/création du Workload est bien passée par LA PAGE
      // (contexte MAIN world), pas par le fetch() isolé du content script.
      await fixturePage.evaluate(() => {
        window.__bridgeRequestCount = 0;
        document.addEventListener("swat-autofill-fetch-request", () => {
          window.__bridgeRequestCount += 1;
        });
      });

      // On pilote depuis le service worker plutôt que depuis une page
      // popup.html ouverte comme onglet : un vrai popup MV3 n'est PAS un
      // onglet (chrome.tabs.query({active:true}) le confond sinon avec le
      // popup lui-même). Le service worker dispose des mêmes API
      // chrome.scripting/chrome.tabs que popup.js — on reproduit exactement
      // la même séquence d'injection, seule la sélection de l'onglet cible
      // diffère (par id connu d'avance plutôt que "onglet actif").
      const result = await sw.evaluate(
        async ([fieldMap, profile, tabId]) => {
          await chrome.scripting.executeScript({ target: { tabId }, files: ["core/engine.js", "content.js"] });

          const [{ result: report }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (fieldMap, profile, options) => window.SwatAutofill.process(fieldMap, profile, options),
            args: [
              fieldMap,
              profile,
              {
                dryRun: false,
                fillEditors: true,
                checkValidations: true,
                attemptWorkload: true,
                userValues: { intervenantName: "Alex Alfonsi", premierIntervenant: "Alex Alfonsi" }
              }
            ]
          });
          return report;
        },
        [fieldMap, methodesProfile, fixtureTabId]
      );

      const errors = result.results.filter((r) => r.status === "error");
      assert.equal(errors.length, 0, "aucune erreur attendue : " + JSON.stringify(errors, null, 2));

      const requiredBefore = await fixturePage.evaluate(() => document.querySelector('input[name="requiredBefore"]').value);
      assert.equal(requiredBefore, "FABRICATION (M)");
      const saveCount = await fixturePage.evaluate(() => window.__calls.saveCount);
      assert.ok(saveCount >= 1, "inject.js doit avoir observé la sauvegarde réseau réelle de la page");

      // Le pont fetch (v3.2.0) doit avoir été utilisé : les 3 GET de
      // résolution (parentId, groupes, membres) + le POST de création
      // partent tous de core/engine.js -> resolveWorkloadTargets/
      // driveWorkload -> fetchJson -> pageFetch(), donc du contexte MAIN
      // world de la page (inject.js), plus jamais du fetch() isolé du
      // content script — c'est tout l'objet de ce changement (piste pour
      // le 403 persistant, voir CHANGELOG.md).
      const bridgeRequestCount = await fixturePage.evaluate(() => window.__bridgeRequestCount);
      assert.ok(bridgeRequestCount >= 4, `le pont fetch doit avoir vu au moins 4 requêtes (parentId, groupes, membres, création) — vu : ${bridgeRequestCount}`);

      // Passant par le pont, ces appels traversent maintenant le fetch()
      // DE LA PAGE — donc le mock JS de la fixture elle-même (le même
      // mécanisme que les suites A/B), plus le mock réseau Node
      // (networkCallLog) qui ne servait qu'à l'ancien chemin isolé.
      const workloadPayload = await fixturePage.evaluate(() => window.__calls.workloadPayload);
      assert.ok(workloadPayload, "le POST de création du Workload doit avoir été observé par le mock de la fixture");
      assert.equal(workloadPayload.assignedBdiGroup, 4185);
    });

    await fixturePage.close();
  } finally {
    await context.close();
  }
}

// =========================================================================
async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    await suiteA(browser);
    await suiteB(browser);
  } finally {
    await browser.close();
  }
  await suiteC();

  console.log(`\n${passed} test(s) réussi(s), ${failed} échoué(s).`);
  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
