// Stopper - service worker
// - active / désactive les jeux de règles réseau
// - gère la liste blanche (sites où les pubs sont autorisées)
// - injecte le CSS de masquage adapté à chaque site (règles cosmétiques EasyList)

const RULESETS = ["base", "easylist", "liste_fr", "easyprivacy"];
const ALLOW_RULE_BASE = 10000; // ids des règles dynamiques "autoriser ce site"
const ALLOW_PRIORITY = 100;    // au-dessus de toutes les règles des listes

// Sélecteurs maison, ajoutés aux sélecteurs génériques d'EasyList.
const BASE_SELECTORS = [
  "ins.adsbygoogle",
  "[id^='google_ads_']",
  "[id^='div-gpt-ad']",
  "iframe[src*='doubleclick.net']",
  "iframe[src*='googlesyndication.com']",
  "iframe[id^='google_ads_iframe']",
  "[data-ad-slot]",
  "[data-ad-client]",
  "[data-google-query-id]",
  ".ad-banner",
  ".ad-container",
  ".ad-slot",
  ".advertisement",
  ".banner-ad",
  ".taboola",
  "[id^='taboola-']",
  ".OUTBRAIN",
  "div[aria-label='Advertisement']",
  "div[aria-label='Publicité']",
];

// ------------------------------------------------------------------ état

async function getState() {
  const { enabled = true, allowlist = [] } = await chrome.storage.local.get([
    "enabled",
    "allowlist",
  ]);
  return { enabled, allowlist };
}

function isAllowed(host, allowlist) {
  return allowlist.some((d) => host === d || host.endsWith("." + d));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function applyEnabled(enabled) {
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    enabled ? { enableRulesetIds: RULESETS } : { disableRulesetIds: RULESETS }
  );
}

async function applyAllowlist(allowlist) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: allowlist.map((domain, i) => ({
      id: ALLOW_RULE_BASE + i,
      priority: ALLOW_PRIORITY,
      action: { type: "allowAllRequests" },
      condition: { requestDomains: [domain], resourceTypes: ["main_frame", "sub_frame"] },
    })),
  });
}

async function init() {
  const { enabled, allowlist } = await getState();
  await applyEnabled(enabled);
  await applyAllowlist(allowlist);
  await chrome.declarativeNetRequest.setExtensionActionOptions({
    displayActionCountAsBadgeText: true,
  });
  await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (changes.enabled) await applyEnabled(changes.enabled.newValue);
  if (changes.allowlist) await applyAllowlist(changes.allowlist.newValue || []);
});

// ------------------------------------------------------------ cosmétique

const toCss = (selectors) =>
  selectors.map((s) => `${s}{display:none!important}`).join("\n");

let dataPromise = null;
function loadData() {
  dataPromise ??= (async () => {
    const [cosmetic, base] = await Promise.all([
      fetch(chrome.runtime.getURL("generated/cosmetic.json")).then((r) => r.json()),
      fetch(chrome.runtime.getURL("rules/base.json")).then((r) => r.json()),
    ]);
    const generic = [...new Set([...BASE_SELECTORS, ...cosmetic.generic])];
    return {
      generic,
      genericCss: toCss(generic),
      specific: cosmetic.specific,
      exceptions: cosmetic.exceptions,
      adDomains: base.flatMap((r) => r.condition.requestDomains || []),
    };
  })().catch((e) => {
    console.error("Stopper : données cosmétiques illisibles", e);
    dataPromise = null;
    return null;
  });
  return dataPromise;
}

// "a.b.exemple.fr" -> ["a.b.exemple.fr", "b.exemple.fr", "exemple.fr"]
function hostChain(host) {
  const parts = host.split(".");
  const chain = [];
  for (let i = 0; i < parts.length - 1; i++) chain.push(parts.slice(i).join("."));
  return chain;
}

function cssForHost(data, host) {
  const chain = hostChain(host);
  const exc = new Set(chain.flatMap((d) => data.exceptions[d] || []));
  const specific = chain.flatMap((d) => data.specific[d] || []).filter((s) => !exc.has(s));
  let css = exc.size ? toCss(data.generic.filter((s) => !exc.has(s))) : data.genericCss;
  if (specific.length) css += "\n" + toCss(specific);
  return css;
}

async function handleCosmetic(host, sender) {
  const { enabled, allowlist } = await getState();
  const topHost = hostOf(sender.tab.url || "");
  if (!enabled || !host || isAllowed(topHost, allowlist)) return { active: false };

  const data = await loadData();
  if (!data) return { active: false };

  try {
    // origin USER : prioritaire sur le CSS du site, et le site ne peut pas le retirer.
    await chrome.scripting.insertCSS({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId] },
      css: cssForHost(data, host),
      origin: "USER",
    });
  } catch {
    // cadre fermé entre-temps : rien à faire
  }
  return { active: true, adDomains: data.adDomains };
}

// --------------------------------------------------------------- pop-ups
// Un onglet ouvert par une page (window.open, clic piégé, pop-under) est surveillé
// quelques secondes : s'il part vers une régie pub, on le ferme.

const POPUP_WATCH_MS = 8000;
const watchedTabs = new Map(); // tabId -> { until, openerTabId }

let popupSetPromise = null;
function loadPopupDomains() {
  popupSetPromise ??= (async () => {
    const getJson = (p) => fetch(chrome.runtime.getURL(p)).then((r) => r.json());
    const set = new Set(await getJson("generated/popups.json"));
    for (const id of RULESETS) {
      for (const r of await getJson(`rules/${id}.json`)) {
        const c = r.condition;
        // Seulement les domaines bloqués partout et pour tout type de ressource.
        if (r.action.type === "block" && c.requestDomains && !c.urlFilter && !c.initiatorDomains
            && !c.resourceTypes && !c.excludedResourceTypes && c.domainType !== "firstParty") {
          c.requestDomains.forEach((d) => set.add(d));
        }
      }
    }
    return set;
  })().catch((e) => {
    console.error("Stopper : liste pop-ups illisible", e);
    popupSetPromise = null;
    return new Set();
  });
  return popupSetPromise;
}

function watchTab(tabId, openerTabId) {
  if (openerTabId === undefined || openerTabId < 0) return;
  watchedTabs.set(tabId, { until: Date.now() + POPUP_WATCH_MS, openerTabId });
  loadPopupDomains(); // commence à charger la liste pendant que l'onglet démarre
}

async function checkPopup(tabId, url) {
  const w = watchedTabs.get(tabId);
  if (!w) return;
  if (Date.now() > w.until) { watchedTabs.delete(tabId); return; }
  const host = hostOf(url || "");
  if (!host) return;

  const { enabled, allowlist } = await getState();
  if (!enabled) return;
  const opener = await chrome.tabs.get(w.openerTabId).catch(() => null);
  if (opener && isAllowed(hostOf(opener.url || ""), allowlist)) return;

  const set = await loadPopupDomains();
  if (!hostChain(host).some((d) => set.has(d))) return;

  watchedTabs.delete(tabId);
  await chrome.tabs.remove(tabId).catch(() => {});
  const { popupsBlocked = 0 } = await chrome.storage.local.get("popupsBlocked");
  await chrome.storage.local.set({ popupsBlocked: popupsBlocked + 1 });
}

chrome.tabs.onCreated.addListener((tab) => watchTab(tab.id, tab.openerTabId));
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  watchTab(d.tabId, d.sourceTabId);
  checkPopup(d.tabId, d.url);
});
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0) checkPopup(d.tabId, d.url);
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) checkPopup(tabId, info.url);
});
chrome.tabs.onRemoved.addListener((tabId) => watchedTabs.delete(tabId));

// ------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "stopper:cosmetic" || !sender.tab) return;
  handleCosmetic(msg.host, sender).then(sendResponse);
  return true; // réponse asynchrone
});
