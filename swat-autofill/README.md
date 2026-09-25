# SWAT Autofill (v3 — refonte)

Remplissage automatique du formulaire RFC de Swatsheet Next (Bombardier), à
partir de profils métier (secteur ébénisterie : Méthodes / Production /
Ingénierie / CNC / Programmation). Choisis un profil correspondant au
problème traité, clique **▶ LANCER**, et les champs de catégorisation, le
texte des éditeurs "Solution Finale"/"Plan d'action", les validations et le
Workload associé sont renseignés automatiquement.

Cette v3 est une refonte complète du **principe** de fonctionnement (pas
juste un nouveau correctif) — voir `CHANGELOG.md` pour le détail technique
de ce qui a changé et pourquoi, et la section **Tests** ci-dessous pour ce
qui a été vérifié avant livraison, au lieu d'après.

## Principe

Le remplissage lui-même reste une automatisation du DOM (simuler la saisie
comme le ferait un humain) : c'est la seule option réaliste sans accès à
une documentation d'API complète de Swatsheet Next — voir "Pourquoi pas une
approche 100% API ?" plus bas. Ce qui change :

1. **Un seul moteur, deux façons de le charger.** Toute la logique
   (`core/engine.js`) est indépendante de toute API de navigateur. Elle
   peut être injectée par une extension (comme avant) OU directement par un
   **userscript** (Tampermonkey/Violentmonkey) — nouvelle option
   recommandée, voir ci-dessous.
2. **Un seul chemin de code pour remplir et pour analyser.** Avant : deux
   fonctions séparées (`run()`/`diagnose()`) qui dupliquaient la même
   logique de repérage de champs, avec un risque de désynchronisation déjà
   rencontré en v2.1.1. Maintenant : une seule fonction
   `process(fieldMap, profile, { dryRun })` — `dryRun:true` correspond au
   bouton "🔍 Analyser" (rien n'est modifié, juste vérifié).
3. **Testé avant livraison, pas après.** Une page de test reproduit le
   comportement DOM/React/MUI/CKEditor 5 dont dépend le script, et une
   suite automatisée (Playwright) pilote les deux variantes contre elle.
   Voir la section **Tests**.

## Les deux façons de l'utiliser

| | **Userscript** (recommandé) | **Extension** |
|---|---|---|
| Installation | Un seul fichier (`userscript/swat-autofill.user.js`), glissé dans Tampermonkey/Violentmonkey | Dossier `chrome://extensions` / `edge://extensions` en mode développeur |
| Mise à jour en équipe | Un fichier à repartager (ou une URL à héberger, avec auto-update) | Redistribuer tout le dossier à chacun |
| Interface | Panneau flottant directement sur la page Swatsheet | Fenêtre popup séparée (icône de la barre d'outils) |
| Fiabilité de la détection réseau | Directe (le script tourne déjà dans le contexte de la page) | Passe par `inject.js` + un pont d'évènement (mécanisme plus indirect, seule vraie source de complexité propre à cette variante) |
| Politique IT restrictive ("mode développeur" bloqué) | Contourne le problème si Tampermonkey est déjà autorisé | Bloqué si le "mode développeur"/chargement non empaqueté est désactivé par la politique de l'entreprise |
| Dépendance | Nécessite Tampermonkey/Violentmonkey (souvent déjà autorisé en entreprise) | Aucune dépendance externe |

**Recommandation : commence par le userscript.** Il élimine une source de
fragilité historique (voir `CHANGELOG.md`, v2.6.0-v2.7.0 : le mécanisme de
détection de sauvegarde réseau existe uniquement parce qu'une extension vit
dans un "monde isolé", séparé du `window.fetch` réel de la page — un
userscript standard n'a pas ce problème), et un seul fichier à réinstaller
est beaucoup plus simple à faire adopter à toute l'équipe qu'un dossier
d'extension à recharger à chaque mise à jour. Garde l'extension en
solution de repli si Tampermonkey n'est pas autorisé sur ton poste.

### Pourquoi pas une approche 100% API ?

La création de Workload (`core/engine.js`, `driveWorkload`) le fait déjà :
un appel direct à `POST /api/workload/create/{parentId}`, découvert via une
capture .har réelle. C'est plus robuste que toute simulation de clic, et
c'est le modèle à suivre. Mais pour les autres champs (catégorisation,
éditeurs), le point de sauvegarde connu (`PUT
/api/swatsheet/reviewandapprove/update`) est un **gros appel qui envoie tout
l'enregistrement** — sans capture .har de ce payload complet (tous les
champs, avec leurs vrais noms internes), migrer ces champs vers l'API
reviendrait à deviner un format non documenté, bien plus risqué que du DOM
piloté par des sélecteurs vérifiés. C'est une piste sérieuse pour la suite
— voir **Propositions d'amélioration**, elle demande une capture .har d'une
sauvegarde manuelle complète pour être faite sans risque.

## Installation — Chrome et Edge

Les deux navigateurs sont Chromium (Edge depuis 2020) : mêmes moteurs de
rendu et JavaScript, même modèle d'extensions (`chrome.*`, Manifest V3
standard, sans API propriétaire ici), même prise en charge des
userscripts. Rien dans ce projet n'est spécifique à un seul des deux.

### Option A — Userscript (recommandé)

1. Installer l'extension **Tampermonkey** :
   - Chrome : [Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - Edge : [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)
2. Ouvrir le tableau de bord Tampermonkey → **Créer un script** (ou
   glisser-déposer directement `userscript/swat-autofill.user.js`).
3. Coller/enregistrer le contenu du fichier. Un panneau **✈ SWAT AUTOFILL**
   apparaît en bas à droite dès qu'une page `swatsheet.ca.aero.bombardier.net`
   est ouverte.

### Option B — Extension (mode développeur)

1. Ouvrir `chrome://extensions` (Chrome) ou `edge://extensions` (Edge).
2. Activer le **Mode développeur**.
3. **Charger l'extension non empaquetée** → sélectionner le dossier racine
   de ce projet (celui qui contient `manifest.json`).
4. L'icône ✈ apparaît dans la barre d'outils.

## Utilisation

1. Ouvrir le formulaire RFC d'une swat dans Swatsheet.
2. Ouvrir le panneau (userscript, déjà visible sur la page) ou cliquer sur
   l'icône ✈ (extension).
3. Choisir un profil.
4. Sélectionner ton nom dans "1er intervenant" (optionnel).
5. Ajuster les options si besoin (éditeurs, validations, Workload —
   expérimental).
6. **▶ LANCER** pour remplir, ou **🔍 Analyser** pour vérifier sans rien
   modifier avant de te lancer.

## Structure du projet

```
core/                   Moteur partagé (aucune dépendance chrome.*)
  engine.js              Toute la logique de remplissage/analyse
  field-map.json          Ciblage DOM (name=/label) + config Workload/saveWatch
  profiles/*.json          Un fichier par profil métier
  intervenants.json        Liste des noms cliquables pour "1er intervenant"

userscript/
  swat-autofill.user.js  Variante userscript — GÉNÉRÉ, ne pas éditer à la main

tools/
  userscript-ui.js        Panneau flottant (source, édité à la main)
  build-userscript.mjs     Assemble core/* + userscript-ui.js -> userscript/*.user.js

manifest.json, background.js, content.js, inject.js, popup.*   Variante extension

tests/
  fixture/swatsheet-fixture.html   Page de test (reproduit Swatsheet Next)
  run-tests.mjs                     Suite Playwright (3 suites, 13 scénarios)
```

**Après toute modification de `core/engine.js` ou `tools/userscript-ui.js`,
régénérer le userscript** :
```
node tools/build-userscript.mjs
```

## Profils, ciblage DOM, intervenants

Fonctionnement inchangé par rapport à la v2 (ce système fonctionnait bien,
la refonte porte sur le moteur et la livraison, pas sur ce modèle) :

- **`core/field-map.json`** : où trouver chaque champ (attribut `name=`
  quand il existe — fiable —, sinon texte de label le plus proche). Si
  Bombardier change la mise en page, ajuster ce fichier avant de toucher au
  code.
- **`core/profiles/<id>.json`** : les valeurs à saisir pour un profil
  donné (catégorisation, texte des éditeurs, cases à cocher, config
  Workload). Ajouter un profil = ajouter un fichier + une entrée dans
  `core/profiles/index.json`, sans toucher au code.
- **`core/intervenants.json`** : liste des noms cliquables pour "1er
  intervenant" — à éditer pour correspondre aux membres de l'équipe
  (ou utiliser le bouton 🔄, qui relit la vraie liste depuis la page
  ouverte).

État des profils (inchangé, à vérifier au fil de l'usage) :

| Profil | Statut |
|---|---|
| Méthodes ébénisterie | ✅ Vérifié (SW-236-127) |
| G7/8 Production (ébénisterie) | ✅ Vérifié (capture d'écran) |
| Ingénierie ébénisterie | ⚠️ Placeholder |
| CNC ébénisterie | ⚠️ Placeholder |
| Programmation ébénisterie | ⚠️ Placeholder |

## Tests

```
cd tests
npm install        # installe playwright (une fois)
npm test           # ou : node run-tests.mjs
```

La suite (`tests/run-tests.mjs`) pilote **Chromium** (le même moteur que
Chrome et Edge — Edge est Chromium depuis sa version 79, et consomme le
même modèle d'extensions `chrome.*`) contre une page de test
(`tests/fixture/swatsheet-fixture.html`) qui reproduit fidèlement les
comportements dont dépend le script :

- **Suite A** (9 scénarios) — `core/engine.js` seul, injecté directement :
  remplissage complet réussi, analyse en lecture seule qui ne modifie
  rien, option introuvable dans une liste, case verrouillée, éditeur en
  lecture seule, duplication de contenu non effacé, échec de résolution
  du Workload (groupe introuvable → aucun appel de création envoyé),
  extraction de la liste des intervenants.
- **Suite B** (1 scénario) — la variante **userscript**, injectée telle
  quelle (comme le ferait Tampermonkey) : panneau flottant, sélection de
  profil, remplissage complet via l'interface réelle.
- **Suite C** (3 scénarios) — la variante **extension**, chargée "non
  empaquetée" exactement comme dans `chrome://extensions`/
  `edge://extensions` : démarrage du service worker, chargement du popup
  et de ses 5 profils, remplissage complet de bout en bout (content script
  + `inject.js` + confirmation réseau réelle de sauvegarde).

**13/13 au vert.** Cette suite a trouvé et permis de corriger plusieurs
bugs réels avant toute mise en situation réelle — voir `CHANGELOG.md` pour
le détail (comparaison de texte cassée par un saut de ligne CKEditor,
condition de course sur la confirmation de sauvegarde, interaction entre
clic différé et fermeture de menu MUI, modèle de permission fragile).

### Ce que ces tests NE couvrent PAS

Honnêteté avant tout : cette page de test **reproduit** le comportement de
Swatsheet Next (structure MUI, CKEditor 5, endpoints API), elle n'EST PAS
Swatsheet Next. Deux choses n'ont pas pu être vérifiées directement depuis
cet environnement :

1. **Le vrai site `swatsheet.ca.aero.bombardier.net`** — interne à
   Bombardier, non accessible depuis ce sandbox. Si la vraie mise en page a
   changé depuis les dernières captures (v2.1.2 et suivantes), certains
   sélecteurs de `field-map.json` pourraient nécessiter un ajustement — le
   bouton **🔍 Analyser** est fait pour détecter ça en un clic, sans rien
   modifier.
2. **Un vrai binaire Microsoft Edge** — cet environnement ne dispose que de
   Chromium (pas d'Edge installé). Le raisonnement "Edge = Chromium, donc
   même comportement" est solide (Manifest V3 standard, aucune API
   propriétaire Chrome utilisée ici, les userscripts fonctionnent de façon
   identique via Tampermonkey sur les deux), mais une vérification manuelle
   d'installation sur un vrai poste Edge (5 minutes, voir **Installation**
   ci-dessus) reste la seule confirmation à 100 %.

## Propositions d'amélioration pour la suite

Par ordre d'impact/risque, pas nécessairement d'urgence :

1. **Capture .har d'une sauvegarde manuelle complète** (`PUT
   /api/swatsheet/reviewandapprove/update`, avec TOUS les champs remplis à
   la main, cf DevTools → onglet Réseau) — permettrait de migrer la
   catégorisation et les éditeurs vers un appel API direct, sur le modèle
   du Workload (déjà fait, déjà robuste). C'est le changement qui
   éliminerait le plus de fragilité restante (plus de simulation de clic
   du tout), mais il faut connaître le format exact du payload avant de s'y
   risquer sur un vrai enregistrement aérospatial.
2. **Compléter les 3 profils "placeholder"** (Ingénierie, CNC,
   Programmation) avec de vraies valeurs vérifiées — actuellement recopiées
   sans confirmation terrain. Remplir une swat à la main une fois pour
   chaque secteur, recopier les valeurs choisies dans le profil JSON
   correspondant, `verified: true`.
3. **Auto-update du userscript** — Tampermonkey vérifie automatiquement les
   mises à jour si `@updateURL`/`@downloadURL` pointent vers une URL stable
   (ex. un raw GitHub une fois ce projet poussé sur un dépôt accessible à
   l'équipe). Éviterait de redistribuer le fichier à la main à chaque
   changement.
4. **Étendre `tests/fixture` à un second profil non-vérifié** (ex. CNC) et
   à la variante "workload désactivé" — actuellement seul le profil
   Méthodes ébénisterie (vérifié) est exercé de bout en bout ; ajouter un
   second cas de test réduirait le risque qu'une régression spécifique à un
   autre profil passe inaperçue.
5. **CI** — exécuter `tests/run-tests.mjs` automatiquement (ex. GitHub
   Actions) à chaque modification de `core/`, plutôt que manuellement.
   Peu de valeur tant que le projet reste sur une machine locale, mais
   trivial à ajouter si le dépôt est poussé sur GitHub.
6. **Élargir le panneau userscript** à un vrai indicateur de progression
   pas-à-pas (actuellement : rapport final seulement, contrairement au
   popup de l'extension qui affiche chaque étape en direct) — cosmétique,
   mais utile pour repérer visuellement où un remplissage bloque avant la
   fin.
