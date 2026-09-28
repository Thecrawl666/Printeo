/**
 * background.js
 * -----------------------------------------------------------------------
 * Service worker minimal (MV3). N'exécute rien en continu : sert
 * uniquement à initialiser les valeurs par défaut du storage à
 * l'installation de l'extension.
 */

const DEFAULT_SETTINGS = {
  darkMode: false,
  lastProfile: null,
  options: {
    fillEditors: true,
    checkValidations: true,
    rememberLastProfile: true,
    showProgress: true,
    attemptWorkload: false
  },
  profileOverrides: null // surcharges JSON par identifiant de profil, éditées via "⚙ Paramètres"
};

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await chrome.storage.local.set(DEFAULT_SETTINGS);
  }
  if (details.reason === "update") {
    const stored = await chrome.storage.local.get("options");
    if (stored.options && !("attemptWorkload" in stored.options)) {
      await chrome.storage.local.set({ options: { ...stored.options, attemptWorkload: false } });
    }
  }
});
