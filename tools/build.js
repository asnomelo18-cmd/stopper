'use strict';
// Construit les règles de Stopper à partir des listes EasyList.
//
//   node tools/build.js            télécharge les listes puis génère les règles
//   node tools/build.js --offline  réutilise les listes déjà dans tools/cache
//
// Sorties :
//   rules/<liste>.json        règles réseau (declarativeNetRequest)
//   generated/cosmetic.json   sélecteurs CSS à masquer (génériques + par site)

const fs = require('fs');
const path = require('path');
const { domainToASCII } = require('url');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(__dirname, 'cache');
const RULES_DIR = path.join(ROOT, 'rules');
const GEN_DIR = path.join(ROOT, 'generated');
const OFFLINE = process.argv.includes('--offline');

// Chrome garantit 30 000 règles statiques actives par extension.
const MAX_TOTAL_RULES = 30000;
// Ordre = priorité si on dépasse la limite.
const LISTS = [
  { id: 'easylist', url: 'https://easylist.to/easylist/easylist.txt' },
  { id: 'liste_fr', url: 'https://easylist-downloads.adblockplus.org/liste_fr.txt' },
  { id: 'easyprivacy', url: 'https://easylist.to/easylist/easyprivacy.txt' },
];

// ---------------------------------------------------------------- réseau

const TYPES = {
  script: 'script', image: 'image', stylesheet: 'stylesheet', css: 'stylesheet',
  object: 'object', 'object-subrequest': 'object',
  xmlhttprequest: 'xmlhttprequest', xhr: 'xmlhttprequest',
  subdocument: 'sub_frame', frame: 'sub_frame',
  ping: 'ping', beacon: 'ping', media: 'media', font: 'font',
  websocket: 'websocket', other: 'other',
};
const ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'];

function toDomain(d) {
  if (!d || d.includes('*') || d.includes('/')) return null;
  const ascii = domainToASCII(d.toLowerCase());
  return /^[a-z0-9.-]+$/.test(ascii) && ascii.includes('.') ? ascii : null;
}

// Renvoie { pattern, options } ou null.
function splitOptions(line) {
  const i = line.lastIndexOf('$');
  if (i > 0) {
    const opts = line.slice(i + 1);
    if (/^[a-z0-9~,=.|*_-]+$/i.test(opts)) return { pattern: line.slice(0, i), options: opts.split(',') };
  }
  return { pattern: line, options: [] };
}

function validPattern(p) {
  if (p.length > 1 && p.startsWith('/') && p.endsWith('/')) return false; // regex : ignoré
  if (/[^\x21-\x7e]/.test(p)) return false;                               // ASCII imprimable seulement
  if (p.startsWith('||*')) return false;
  let core = p.startsWith('||') ? p.slice(2) : p.startsWith('|') ? p.slice(1) : p;
  if (core.endsWith('|')) core = core.slice(0, -1);
  return !core.includes('|');
}

// Convertit une ligne réseau Adblock Plus en règle DNR (sans id), ou null si non convertible.
function parseNetwork(line) {
  let exception = false;
  if (line.startsWith('@@')) { exception = true; line = line.slice(2); }
  const { pattern: rawPattern, options } = splitOptions(line);

  const types = new Set();
  const excluded = new Set();
  const condition = {};
  let priority = exception ? 2 : 1;
  let caseSensitive = false;
  let documentRule = false;

  for (const raw of options) {
    const neg = raw.startsWith('~');
    const opt = (neg ? raw.slice(1) : raw).toLowerCase();
    if (TYPES[opt]) { (neg ? excluded : types).add(TYPES[opt]); continue; }
    if (opt === 'third-party' || opt === '3p') { condition.domainType = neg ? 'firstParty' : 'thirdParty'; continue; }
    if (opt === 'first-party' || opt === '1p') { condition.domainType = neg ? 'thirdParty' : 'firstParty'; continue; }
    if (opt === 'match-case') { caseSensitive = true; continue; }
    if (opt === 'important') { if (!exception) priority = 3; continue; }
    if (opt === 'all' && !neg) { ALL_TYPES.forEach((t) => types.add(t)); continue; }
    if ((opt === 'document' || opt === 'doc') && !neg) { documentRule = true; continue; }
    if (raw.startsWith('domain=') || raw.startsWith('from=')) {
      const inc = [], exc = [];
      for (const d of raw.slice(raw.indexOf('=') + 1).split('|')) {
        const isNeg = d.startsWith('~');
        const dom = toDomain(isNeg ? d.slice(1) : d);
        if (dom) (isNeg ? exc : inc).push(dom);
        else if (!isNeg) return null; // domaine positif non convertible : on ne devine pas
      }
      if (inc.length) condition.initiatorDomains = inc;
      if (exc.length) condition.excludedInitiatorDomains = exc;
      continue;
    }
    return null; // option inconnue / non supportée (popup, csp, redirect, elemhide…)
  }

  let pattern = rawPattern;
  if (pattern === '' || pattern === '*') {
    if (!condition.initiatorDomains) return null; // trop large
    pattern = null;
  } else if (!validPattern(pattern)) {
    return null;
  }
  if (pattern && !caseSensitive) pattern = pattern.toLowerCase();

  let action = { type: exception ? 'allow' : 'block' };
  if (documentRule) {
    if (exception) {
      if (types.size) return null;
      action = { type: 'allowAllRequests' };
      types.add('main_frame').add('sub_frame');
    } else {
      types.add('main_frame');
    }
  }

  if (types.size) {
    excluded.forEach((t) => types.delete(t));
    if (!types.size) return null;
    condition.resourceTypes = [...types];
  } else if (excluded.size) {
    excluded.add('main_frame');
    condition.excludedResourceTypes = [...excluded];
  }

  // ||domaine.com^ seul -> requestDomains (permet de regrouper plein de domaines en une règle)
  const simple = pattern && /^\|\|([a-z0-9][a-z0-9.-]*\.[a-z0-9-]+)\^\|?$/.exec(pattern);
  if (simple) {
    condition.requestDomains = [simple[1]];
  } else if (pattern) {
    condition.urlFilter = pattern;
    if (caseSensitive) condition.isUrlFilterCaseSensitive = true;
  }
  return { priority, action, condition };
}

// --------------------------------------------------------------- cosmétique

const COSMETIC_RE = /^([a-z0-9.,~*_:\[\]-]*)(#@?[?$%]?#|\$@?\$)(.+)$/i;
// Syntaxes "procédurales" d'uBlock/ABP que le CSS ne comprend pas.
const PROCEDURAL_RE = /:-abp-|:has-text|:contains|:xpath|:matches-|:upward|:remove|:style\(|:min-text|:watch-attr|:others|:if\(|:if-not|:nth-ancestor|:spath/i;

function addTo(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

// --------------------------------------------------------------- principal

async function getList({ id, url }) {
  const file = path.join(CACHE_DIR, `${id}.txt`);
  if (!OFFLINE) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'stopper-build' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, await res.text());
    } catch (e) {
      console.warn(`! ${id} : téléchargement impossible (${e.message}), on utilise le cache s'il existe`);
    }
  }
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

async function main() {
  fs.mkdirSync(RULES_DIR, { recursive: true });
  fs.mkdirSync(GEN_DIR, { recursive: true });

  const baseCount = JSON.parse(fs.readFileSync(path.join(RULES_DIR, 'base.json'), 'utf8')).length;
  let budget = MAX_TOTAL_RULES - baseCount;

  const seenRules = new Set();          // règles déjà émises (toutes listes)
  const seenDomains = new Map();        // clé de groupe -> Set(domaines) déjà émis
  const generic = new Set();
  const popupDomains = new Set();       // ||domaine^$popup : onglets à fermer
  const genericExceptions = new Set();
  const specific = new Map();
  const exceptions = new Map();
  const summary = [];

  for (const list of LISTS) {
    const text = await getList(list);
    const groups = new Map();           // clé -> règle avec requestDomains[]
    const others = [];
    let skipped = 0;

    for (const rawLine of (text || '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('!') || line.startsWith('[')) continue;

      const cos = COSMETIC_RE.exec(line);
      if (cos) {
        const [, domainsPart, sep, selector] = cos;
        if (sep !== '##' && sep !== '#@#') { skipped++; continue; }
        if (selector.startsWith('+js') || selector.startsWith('^') || /[{}]/.test(selector)
            || PROCEDURAL_RE.test(selector) || selector.length > 500) { skipped++; continue; }
        const isException = sep === '#@#';
        const doms = domainsPart ? domainsPart.split(',') : [];
        const pos = [], neg = [];
        for (const d of doms) {
          const n = d.startsWith('~');
          const dom = toDomain(n ? d.slice(1) : d);
          if (dom) (n ? neg : pos).push(dom);
        }
        if (isException) {
          if (!doms.length) genericExceptions.add(selector);
          pos.forEach((d) => addTo(exceptions, d, selector));
        } else if (pos.length) {
          pos.forEach((d) => addTo(specific, d, selector));
          neg.forEach((d) => addTo(exceptions, d, selector));
        } else if (!doms.length || neg.length === doms.length) {
          generic.add(selector);
          neg.forEach((d) => addTo(exceptions, d, selector));
        }
        continue;
      }

      // ||domaine^$popup (sans restriction de site) -> liste des pop-ups à fermer
      const pop = /^\|\|([a-z0-9][a-z0-9.-]*\.[a-z0-9-]+)\^?\|?\$([a-z0-9~,=.|-]+)$/i.exec(line);
      if (pop) {
        const opts = pop[2].toLowerCase().split(',');
        if (opts.includes('popup')) {
          const d = toDomain(pop[1]);
          if (d && !opts.some((o) => o.startsWith('domain=') || o.startsWith('from='))) popupDomains.add(d);
          continue;
        }
      }

      const rule = parseNetwork(line);
      if (!rule) { skipped++; continue; }
      if (rule.condition.requestDomains && !rule.condition.urlFilter) {
        const domain = rule.condition.requestDomains[0];
        const { requestDomains, ...rest } = rule.condition;
        const key = JSON.stringify([rule.priority, rule.action, rest]);
        if (!seenDomains.has(key)) seenDomains.set(key, new Set());
        if (seenDomains.get(key).has(domain)) continue;
        seenDomains.get(key).add(domain);
        if (!groups.has(key)) groups.set(key, { ...rule, condition: { ...rest, requestDomains: [] } });
        groups.get(key).condition.requestDomains.push(domain);
      } else {
        const key = JSON.stringify(rule);
        if (seenRules.has(key)) continue;
        seenRules.add(key);
        others.push(rule);
      }
    }

    // Règles groupées par domaine d'abord : les plus efficaces.
    let rules = [...groups.values(), ...others];
    const dropped = Math.max(0, rules.length - budget);
    rules = rules.slice(0, budget);
    budget -= rules.length;
    rules.forEach((r, i) => { r.id = i + 1; });

    fs.writeFileSync(path.join(RULES_DIR, `${list.id}.json`), JSON.stringify(rules));
    const domains = [...groups.values()].reduce((n, g) => n + g.condition.requestDomains.length, 0);
    summary.push({ liste: list.id, chargée: !!text, règles: rules.length, domaines_groupés: domains,
      ignorées: skipped, coupées_limite: dropped });
  }

  genericExceptions.forEach((s) => generic.delete(s));
  const toObj = (map) => Object.fromEntries([...map].map(([k, v]) => [k, [...v]]));
  const cosmetic = { generic: [...generic], specific: toObj(specific), exceptions: toObj(exceptions) };
  fs.writeFileSync(path.join(GEN_DIR, 'cosmetic.json'), JSON.stringify(cosmetic));
  fs.writeFileSync(path.join(GEN_DIR, 'popups.json'), JSON.stringify([...popupDomains]));

  console.table(summary);
  console.log(`Total règles réseau : ${MAX_TOTAL_RULES - budget} / ${MAX_TOTAL_RULES}`);
  console.log(`Cosmétique : ${generic.size} sélecteurs génériques, ${specific.size} sites avec règles spécifiques`);
  console.log(`Pop-ups : ${popupDomains.size} domaines`);
}

main().catch((e) => { console.error(e); process.exit(1); });
