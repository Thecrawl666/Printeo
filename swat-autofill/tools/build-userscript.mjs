#!/usr/bin/env node
/**
 * build-userscript.mjs
 * -----------------------------------------------------------------------
 * Assemble userscript/swat-autofill.user.js à partir de :
 *   - core/engine.js                (moteur, identique à la variante extension)
 *   - core/field-map.json + core/profiles/*.json + core/intervenants.json
 *     (données, injectées en dur pour que le script reste un seul fichier
 *     à distribuer/installer — pas de requête réseau nécessaire au premier
 *     lancement)
 *   - tools/userscript-ui.js        (panneau flottant, propre à cette variante)
 *
 * Objectif : une seule source de vérité pour la logique de remplissage
 * (core/engine.js, core/*.json) — ce script ne fait QUE composer le
 * fichier final, il ne duplique aucune règle métier à la main.
 *
 * Usage : node tools/build-userscript.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const readText = (p) => readFileSync(p, "utf8");

const VERSION = readJson(path.join(ROOT, "manifest.json")).version;

const fieldMap = readJson(path.join(ROOT, "core/field-map.json"));
const intervenants = readJson(path.join(ROOT, "core/intervenants.json"));
const profilesIndex = readJson(path.join(ROOT, "core/profiles/index.json"));

const profilesInline = profilesIndex.profiles.map((p) => ({
  id: p.id,
  label: p.label,
  color: p.color,
  data: readJson(path.join(ROOT, "core", p.file))
}));

const engineSrc = readText(path.join(ROOT, "core/engine.js"));
const uiSrc = readText(path.join(ROOT, "tools/userscript-ui.js"));

const header = `// ==UserScript==
// @name         SWAT Autofill
// @namespace    swat-autofill
// @version      ${VERSION}
// @description  Remplissage automatique des formulaires RFC/SWAT (Swatsheet) — panneau flottant, profils JSON embarqués. Généré depuis core/ — ne pas éditer ce fichier à la main, voir tools/build-userscript.mjs.
// @author       Alex Alfonsi
// @match        *://swatsheet.ca.aero.bombardier.net/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
`;

const banner = `/**
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
 * le contexte de la page (\`@grant none\`) : pas de "monde isolé", donc pas
 * besoin d'inject.js ni de pont par CustomEvent pour observer les vrais
 * appels réseau de sauvegarde — core/engine.js les intercepte lui-même.
 */
`;

const body = `
(function () {
  "use strict";

  ${engineSrc}

  const FIELD_MAP = ${JSON.stringify(fieldMap, null, 2)};
  const INTERVENANTS = ${JSON.stringify(intervenants, null, 2)};
  const PROFILES_INDEX = ${JSON.stringify(profilesInline, null, 2)};

  ${uiSrc}
})();
`;

const out = header + banner + body;
const outPath = path.join(ROOT, "userscript/swat-autofill.user.js");
writeFileSync(outPath, out, "utf8");
console.log(`✔ ${path.relative(ROOT, outPath)} généré (${(out.length / 1024).toFixed(1)} Ko, v${VERSION}, ${profilesInline.length} profil(s) embarqué(s))`);
