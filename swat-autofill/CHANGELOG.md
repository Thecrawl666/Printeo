# Changelog

## v3.1.1 — fetchJson : capture le corps de la réponse en cas d'erreur HTTP

Petit changement, porté d'une branche v2.x parallèle (voir note ci-dessous)
qui l'avait déjà fait en v2.9.2 : `fetchJson()` (utilisée par la résolution
Workload) inclut maintenant le corps de la réponse HTTP dans le message
d'erreur en cas d'échec (`res.status` hors 2xx), au lieu de juste
`HTTP 403 sur /api/...`. Le corps d'une réponse 403/401 explique souvent la
vraie raison côté serveur — inclure ça évite d'avoir à redemander une
capture réseau rien que pour voir ce texte.

### Note — deux lignées parallèles du même projet

Un document de passation (`HANDOFF.md`, daté du 28 septembre) a révélé
qu'une **branche v2.x séparée** de cette même extension (simple dossier
JS/JSON, sans `core/engine.js` ni variante userscript, livrée en zip) a
continué d'évoluer en parallèle de cette refonte v3, jusqu'à sa version
2.9.2, via une autre session. Les deux lignées documentent **le même bug
non résolu** :

**`GET /api/swatsheet/parent/{code}/parentId` → 403 Forbidden**, systématique
dès le premier appel de résolution du Workload — alors que ce même appel
répond `200 OK` de façon fiable quand c'est la page Swatsheet elle-même qui
l'exécute (confirmé par plusieurs captures `.har` sur la lignée v2.x).

Deux correctifs déjà tentés sur la lignée v2.x, **sans succès confirmé** —
à ne pas retenter en l'état sur cette branche sans nouvelle piste :
- ajouter l'en-tête `X-Requested-With: XMLHttpRequest` ;
- expliciter `credentials: "same-origin"`.

Hypothèses non tranchées (aucune confirmée, aucune infirmée) :
- authentification réseau/proxy de type Windows Integrated/NTLM/Kerberos,
  courante sur les intranets d'entreprise — expliquerait un 403 "propre"
  malgré une session utilisateur par ailleurs valide ;
- une différence sur les en-têtes `Referer`/`Origin`/`Sec-Fetch-Site` entre
  un fetch émis par la page elle-même et un fetch émis par un content
  script (même origine, mais deux contextes d'exécution distincts —
  voir `README.md` sur la différence extension/userscript à ce sujet) ;
- deux tentatives de capturer l'appel RÉEL et défaillant de l'extension
  (pas celui de la page) via DevTools ont échoué (l'appel n'apparaissait
  dans aucune des deux captures Réseau), sans qu'on sache si c'est un
  problème de timing de capture ou une particularité de Chrome/DevTools
  qui masquerait certains `fetch()` de content script — jamais vérifié.

Cette branche a un avantage que la lignée v2.x n'avait pas pour investiguer
ça : `host_permissions` (v3.0.0) au lieu de `activeTab`, qui change le
contexte de permission du `fetch()` — pas confirmé que ça change quoi que
ce soit au 403 (les causes suspectées ci-dessus sont plutôt réseau/en-têtes
que permissions d'extension), mais à noter au prochain test réel.

**À faire au prochain rapport d'erreur** : le message inclut maintenant le
corps de la réponse (voir ci-dessus) — c'est la piste la plus rapide vers
la vraie cause, plutôt que deviner un énième en-tête à ajouter.

## v3.1.0 — Collage CKEditor : détection d'une annulation par l'éditeur + repli natif

Trouvé sur un premier vrai test en conditions réelles (2026-09-25,
SW-236-359, profil G7/8 Production) : la catégorisation et les cases à
cocher se remplissaient correctement, mais le texte des éditeurs "Solution
Finale"/"Plan d'action" restait celui par défaut de Bombardier après le
remplissage — le collage simulé (évènement `paste`) semblait réussir sur
l'instant, mais n'avait jamais persisté.

**Cause probable** : CKEditor 5 garde un modèle interne séparé du DOM
affiché. Si son plugin Clipboard ne traite pas notre évènement `paste`
synthétique comme un collage valide (l'hypothèse la plus probable, sans
pouvoir le confirmer en direct — voir plus bas), le DOM peut changer un
court instant puis être "réparé" à partir du modèle (resté inchangé) au
rendu suivant — indiscernable d'un succès par la vérification précédente,
qui ne contrôlait le résultat qu'une seule fois, ~300ms après le collage.

**Correctifs (`core/engine.js`, `driveRichText`)** :
- Le résultat du collage est maintenant vérifié deux fois : immédiatement,
  puis après un court délai de stabilisation — pour distinguer un vrai
  succès d'un collage annulé après coup par l'éditeur.
- Si le collage simulé est annulé (ou n'a jamais pris), un second
  mécanisme est tenté : `document.execCommand("insertHTML", …)`, une
  commande d'édition native du navigateur, indépendante du plugin
  Clipboard de CKEditor — elle déclenche de vraies mutations DOM que
  CKEditor 5 réconcilie normalement avec son modèle, au même titre qu'une
  saisie clavier réelle.
- Le délai d'attente de confirmation réseau de sauvegarde est réduit de
  15s à 8s (il ne sert plus à rien d'attendre aussi longtemps une
  confirmation qui, en cas d'échec des deux méthodes, n'arrivera jamais).
- `tests/fixture` : nouveau scénario `?revertPaste=1` qui reproduit ce
  comportement (le DOM change puis revient en arrière ~700ms après le
  collage), avec un test dédié qui vérifie que le repli
  `execCommand` rattrape bien la situation et que le contenu final est
  correct et stable.

**Limite assumée** : cette correction a été conçue et testée uniquement
contre une page de test qui *simule* ce comportement — impossible de
confirmer contre le vrai `swatsheet.ca.aero.bombardier.net` (inaccessible
depuis l'environnement de développement). À reconfirmer sur un vrai test,
DevTools ouverts (Console + Réseau), avant de considérer le problème
résolu.

## v3.0.0 — Refonte complète (principe, moteur, tests, variante userscript)

Réponse à la demande : repenser entièrement le principe et le fonctionnement
du remplissage des swats, en gardant la fonction de base (remplissage
automatique d'une swat selon un profil/problème), en évaluant une
alternative plus simple que l'extension seule, et en testant réellement le
résultat plutôt que de livrer à l'aveugle.

### Changement de principe n°1 — un moteur unique, deux habillages

Toute la logique de remplissage/analyse (repérage des champs, Select/
Autocomplete, cases à cocher, éditeurs riches, appel API Workload) est
regroupée dans **`core/engine.js`**, un fichier qui ne connaît AUCUNE API
propriétaire de navigateur (`chrome.*`). Deux "habillages" minces
l'utilisent tel quel :

- **`userscript/swat-autofill.user.js`** (Tampermonkey/Violentmonkey) —
  **nouvelle variante recommandée**, voir la section dédiée du README.
- **L'extension Chrome/Edge** (`manifest.json`, `popup.*`, `content.js`,
  `background.js`, `inject.js`) — conservée, simplifiée, toujours
  disponible pour les postes où un gestionnaire de userscripts n'est pas
  souhaitable.

### Changement de principe n°2 — fin des deux implémentations parallèles run()/diagnose()

La v2 avait deux fonctions séparées (`run()` pour remplir, `diagnose()` pour
analyser en lecture seule), qui dupliquaient la même logique de repérage
avec un risque réel de désynchronisation (déjà arrivé en v2.1.1 : le
diagnostic ne suivait pas exactement la même règle que le remplissage réel
pour un champ optionnel). `core/engine.js` expose maintenant une seule
fonction, `process(fieldMap, profile, options)`, avec `options.dryRun` qui
bascule entre "remplir pour de vrai" et "vérifier sans rien modifier" — les
deux modes empruntent exactement le même chemin de code.

### Changement de principe n°3 — tester avant de livrer, pas après

Toute la v2 (voir l'historique plus bas) a été développée par itérations
"patch → redistribution à Alex → test sur un enregistrement réel →
nouveau patch", faute d'un moyen de vérifier le comportement autrement
qu'en conditions réelles. `tests/fixture/swatsheet-fixture.html` reproduit
fidèlement les comportements DOM/React/MUI/CKEditor 5 dont `core/engine.js`
dépend (Select/Autocomplete MUI, cases à cocher React, CKEditor 5, appels
réseau de l'API Workload et de sauvegarde), et `tests/run-tests.mjs`
(Playwright) pilote les DEUX variantes contre cette page, en Chromium —
13 scénarios, y compris les cas d'erreur (option introuvable, case
verrouillée, éditeur en lecture seule, duplication de contenu, groupe
Workload introuvable).

**Cette suite a immédiatement trouvé, puis permis de corriger, plusieurs
bugs réels qui seraient autrement passés inaperçus jusqu'à un test en
conditions réelles :**

- Une comparaison de texte trop stricte dans la vérification du collage
  CKEditor (`afterText.includes(newPlainText.slice(0,15))`) échouait dès
  que les 15 premiers caractères du nouveau contenu chevauchaient une
  frontière entre deux blocs HTML (ex. `<h3>…</h3><p>…</p>`, où
  `el.innerText` insère un saut de ligne là où la comparaison attendait un
  espace) — corrigé en normalisant les espaces des deux côtés avant de
  comparer.
- Une vraie condition de course dans l'attente de confirmation réseau de
  sauvegarde (`waitForSave`) : la promesse d'attente était créée APRÈS le
  collage et ses vérifications, qui prennent du temps — si la sauvegarde
  réseau de l'application arrive entre-temps (observé avec un délai aussi
  court que ~250ms), l'évènement pouvait être manqué. Corrigé en créant la
  promesse d'attente avant même de dispatcher le collage.
- Un risque architectural propre à la variante userscript : le bouton
  "▶ LANCER" vit désormais SUR la page elle-même (voir plus bas), donc son
  clic est un évènement DOM comme un autre, qui continue de remonter
  jusqu'à `document` même après que son gestionnaire (asynchrone) a rendu
  la main au premier `await`. S'il ouvre un menu Select/Autocomplete AVANT
  ce premier `await` (ce qui est le cas), le clic d'origine peut atteindre
  `document` juste APRÈS coup et se faire prendre pour "un clic en dehors"
  par le vrai `ClickAwayListener` MUI de la page — qui refermerait alors le
  menu tout juste ouvert. Corrigé en laissant explicitement le clic
  d'origine finir sa propagation (`await new Promise(r => setTimeout(r,
  0))`) avant de commencer le remplissage.
- Le modèle de permission de l'extension reposait sur `activeTab`, qui
  n'accorde l'accès à un onglet qu'en réponse à un geste utilisateur précis
  (clic sur l'icône de la barre d'outils) — fragile à vérifier et
  impossible à automatiser fidèlement en test. Remplacé par un
  `host_permissions` explicite et étroit, limité à
  `swatsheet.ca.aero.bombardier.net` : ni plus large (pas `<all_urls>`), ni
  dépendant d'un geste UI précis à chaque fois.

### Autres changements

- **Nettoyage** : suppression du code mort de détection "avion/effectivité"
  (`detectAvionValue`, `avionHeaderPatterns`) — `field-map.json` ne contient
  plus aucune entrée `"dynamic":"avion"` depuis la v2.1.2, ce chemin de code
  n'était donc plus jamais emprunté.
- `field-map.json` : le pattern de surveillance réseau (auparavant codé en
  dur dans `inject.js`) est maintenant configurable via une entrée
  `saveWatch`, réutilisée par les deux variantes.
- `manifest.json` : version bump 2.8.0 → 3.0.0, permissions resserrées
  (voir plus haut).

---

## Historique v2.x (conservé pour mémoire — voir git blame pour le détail
## ligne à ligne de chaque correctif)

**v2.8.0** — Création du Workload : abandon complet de l'ancienne approche
par clic sur "+ Workload" + diff avant/après du DOM (fragile, dépendait de
l'onglet Impact et du texte exact des labels). Remplacée par un appel
direct à l'API REST, découverte via une capture .har réelle d'une
création MANUELLE (onglet Réseau de DevTools) :
`POST /api/workload/create/{parentId}`.

**v2.7.0** — Vraie cause de "le texte Solution Finale disparaît" : trouvée
via 2 captures .har réelles comparant une saisie manuelle et un
remplissage par l'extension — la sauvegarde de "Définition du problème"
n'est PAS auto-sauvegardée par champ, mais en un seul gros appel `PUT
/api/swatsheet/reviewandapprove/update`. Nouveau fichier `inject.js`,
chargé dans le contexte de LA PAGE, pour observer les vrais appels
réseau (un content script classique a son propre `window.fetch`, séparé
de celui de la page).

**v2.6.0** — Cause racine (et correctif) pour "le texte Solution Finale
disparaît" : Swatsheet fait un auto-save React après modification,
confirmé par un toast temporaire non instantané (2-3s). Le script
changeait d'onglet immédiatement après le collage, sans attendre cette
confirmation.

**v2.5.1** — Bouton "+ Workload" : recherche par attente active (jusqu'à
3s) au lieu d'un seul `sleep(300)` suivi d'une lecture unique.

**v2.5.0** — Bouton 🔄 à côté de la liste "Nom du premier intervenant" :
lit la vraie liste sur la page Swatsheet affichée plutôt que de recopier
les noms à la main.

**v2.4.1** — Le texte se collait par-dessus l'ancien au lieu de le
remplacer : un `KeyboardEvent` sans `keyCode` numérique ne correspondait à
rien pour le raccourci Ctrl+A de CKEditor.

**v2.4.0** — Workload : ciblage des champs corrigé (barre de filtre
confondue avec les champs d'édition réels).

**v2.3.0** — Sélection "tout effacer" renforcée par un vrai raccourci
Ctrl+A (CKEditor 5 garde son propre modèle de sélection interne, distinct
de la sélection native). "Nom du premier intervenant" passé de champ texte
libre à vraie liste déroulante cliquable.

**v2.2.0** — Mécanisme de remplissage CKEditor entièrement revu : plus de
recherche d'instance interne (CKEditor 5 n'en expose aucune), collage via
un vrai évènement `paste` avec HTML en `clipboardData` — intégration
publique et stable du plugin Clipboard de CKEditor 5.

**v2.1.2** — "Modèle"/"Numéro d'avion" retirés (n'existent pas comme champs
éditables sur les swats ébénisterie). Faux avertissement sur "Chapitre
Ata" corrigé (court-circuit manquant quand la valeur affichée correspond
déjà à la cible).

**v2.1.1** — Plusieurs faux positifs de diagnostic corrigés (numéro
d'avion, délai CKEditor désynchronisé, comparaison de labels sensible à
la casse/aux accents, bouton "+ Workload" introuvable).

**v2.1.0** — Nouveau bouton "🔍 Analyser" (analyse complète en lecture
seule).

**v2.0.1** — Case "Priorité validée" : React attache son `onChange` à
l'évènement natif `click`, pas `change` — un seul vrai `.click()` requis.

**v2.0.0** — Passage à des profils métier en fichiers JSON plutôt que codés
en dur ; ciblage des champs externalisé dans `field-map.json`.
