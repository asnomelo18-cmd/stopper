// Stopper - popup

const $ = (id) => document.getElementById(id);

function showHint() {
  $("hint").classList.add("show");
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol.startsWith("http") ? u.hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

async function render() {
  const { enabled = true, allowlist = [], popupsBlocked = 0 } = await chrome.storage.local.get([
    "enabled",
    "allowlist",
    "popupsBlocked",
  ]);
  const tab = await currentTab();
  const host = tab ? hostOf(tab.url) : null;

  $("enabled").checked = enabled;
  $("version").textContent = "v" + chrome.runtime.getManifest().version;
  $("popups").textContent =
    popupsBlocked > 0 ? `${popupsBlocked} pop-up${popupsBlocked > 1 ? "s" : ""} de pub fermé${popupsBlocked > 1 ? "s" : ""} au total` : "";

  if (tab) {
    const badge = await chrome.action.getBadgeText({ tabId: tab.id });
    $("count").textContent = badge || "0";
  }

  const btn = $("allow");
  if (!host) {
    $("host").textContent = "Page non prise en charge";
    btn.disabled = true;
    return;
  }
  $("host").textContent = host;
  const allowed = allowlist.includes(host);
  btn.textContent = allowed
    ? "Bloquer à nouveau sur ce site"
    : "Autoriser les pubs sur ce site";
  btn.onclick = async () => {
    const next = allowed
      ? allowlist.filter((d) => d !== host)
      : [...allowlist, host];
    await chrome.storage.local.set({ allowlist: next });
    showHint();
    render();
  };
}

$("enabled").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
  showHint();
});

render();
