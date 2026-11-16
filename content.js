// Stopper - script de page
// 1. Demande au service worker d'injecter le CSS de masquage pour ce site.
// 2. Surveille la page (MutationObserver) pour nettoyer les pubs ajoutées après coup :
//    - cadres / images / objets venant de régies pub (sinon il reste un rectangle vide)
//    - blocs vides qui ne contiennent plus qu'une étiquette « Publicité », « Sponsored »…

(() => {
  if (window.__stopperLoaded) return;
  window.__stopperLoaded = true;

  const LABEL_RE =
    /^(publicit[ée]s?|annonces?|sponsoris[ée]e?s?|contenu sponsoris[ée]|advertisements?|sponsored|ads?|anzeige|pub)$/i;
  const MEDIA_SELECTOR = "iframe, img, embed, object";
  const LABEL_SELECTOR = "span, div, p, small, a, label, strong, em, h2, h3, h4";

  let adDomains = [];
  const pending = new Set();
  let scheduled = false;

  function isAdUrl(src) {
    if (!src) return false;
    try {
      const host = new URL(src, location.href).hostname;
      return adDomains.some((d) => host === d || host.endsWith("." + d));
    } catch {
      return false;
    }
  }

  function hide(el) {
    if (el === document.body || el === document.documentElement) return;
    el.style.setProperty("display", "none", "important");
    el.setAttribute("data-stopper", "hidden");
  }

  function isEffectivelyEmpty(container, except) {
    for (const child of container.children) {
      if (child === except || child.contains(except)) continue;
      if (child.offsetWidth > 0 || child.offsetHeight > 0) return false;
    }
    return true;
  }

  function cleanMedia(root) {
    const list = root.matches(MEDIA_SELECTOR) ? [root] : root.querySelectorAll(MEDIA_SELECTOR);
    for (const el of list) {
      if (isAdUrl(el.getAttribute("src") || el.getAttribute("data"))) hide(el);
    }
  }

  function cleanLabels(root) {
    const list = root.matches(LABEL_SELECTOR) ? [root] : root.querySelectorAll(LABEL_SELECTOR);
    for (const el of list) {
      if (el.childElementCount > 0) continue;
      const text = el.textContent.trim();
      if (text.length > 25 || !LABEL_RE.test(text)) continue;
      // On remonte de 1 à 2 niveaux tant que le bloc n'a rien d'autre de visible.
      let target = null;
      let node = el.parentElement;
      for (let depth = 0; node && depth < 2; depth++, node = node.parentElement) {
        if (node === document.body || node.offsetHeight > 800) break;
        if (isEffectivelyEmpty(node, el)) target = node;
        else break;
      }
      if (target) hide(target);
    }
  }

  function flush() {
    scheduled = false;
    const roots = [...pending];
    pending.clear();
    for (const root of roots) {
      if (!root.isConnected) continue;
      cleanMedia(root);
      cleanLabels(root);
    }
  }

  function schedule(node) {
    if (node.nodeType !== Node.ELEMENT_NODE || node.getAttribute("data-stopper")) return;
    pending.add(node);
    if (scheduled) return;
    scheduled = true;
    // Regroupe les mutations pour ne pas ralentir la page.
    (window.requestIdleCallback || ((cb) => setTimeout(cb, 200)))(flush, { timeout: 500 });
  }

  function start() {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes") schedule(m.target);
        else m.addedNodes.forEach(schedule);
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "data"],
    });
    const scanAll = () => document.body && schedule(document.body);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", scanAll, { once: true });
    } else {
      scanAll();
    }
  }

  chrome.runtime
    .sendMessage({ type: "stopper:cosmetic", host: location.hostname })
    .then((res) => {
      if (!res?.active) return;
      adDomains = res.adDomains || [];
      start();
    })
    .catch(() => {});
})();
