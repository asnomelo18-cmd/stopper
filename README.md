<p align="center">
  <img src="icons/icon128.png" width="96" alt="Stopper">
</p>

<h1 align="center">Stopper</h1>

<p align="center">
  Bloqueur de publicités, de traqueurs et de pop-ups pour Chrome et Edge (Manifest V3).
</p>

---

## Fonctionnalités

- **Blocage réseau** : environ 99 000 domaines de pubs et de traqueurs, issus d'EasyList, Liste FR et EasyPrivacy
- **Masquage visuel** : 15 000 sélecteurs CSS génériques, plus des règles propres à environ 9 000 sites
- **Nettoyage en direct** : un `MutationObserver` retire les pubs ajoutées après le chargement de la page (cadres vides, blocs « Publicité »)
- **Anti pop-up** : ferme les onglets ouverts par une page quand ils partent vers une régie pub (pop-unders, clics piégés)
- **Liste blanche** : bouton « Autoriser les pubs sur ce site »
- **Compteur** d'éléments bloqués sur l'icône, et total des pop-ups fermés
- **Interrupteur** pour tout désactiver en un clic

## Installation

1. Télécharger le projet : **Code → Download ZIP** puis décompresser, ou bien :
   ```bash
   git clone https://github.com/<votre-compte>/stopper.git
   ```
2. Ouvrir `chrome://extensions` (ou `edge://extensions`).
3. Activer le **Mode développeur** (en haut à droite).
4. Cliquer sur **Charger l'extension non empaquetée** et choisir le dossier `stopper`.
5. Épingler l'icône rouge dans la barre d'outils.

> Après une mise à jour de l'extension, cliquez sur ↻ dans `chrome://extensions`
> **et** actualisez les onglets déjà ouverts.

## Mettre à jour les listes de filtres

Il faut [Node.js](https://nodejs.org) version 18 ou plus récente.

```bash
npm run build
```

Cette commande télécharge les listes et régénère `rules/` et `generated/`. Ensuite, rechargez l'extension.
`npm run build:offline` reconstruit à partir des listes déjà téléchargées dans `tools/cache/`.

Chrome garantit 30 000 règles réseau par extension. Le script reste sous cette limite en regroupant
les domaines bloqués : une règle peut contenir des milliers de domaines.

## Structure du projet

```
stopper/
├── manifest.json          Déclaration de l'extension (MV3)
├── background.js          Service worker : activation, liste blanche, CSS par site, anti pop-up
├── content.js             Script de page : MutationObserver, nettoyage des blocs vides
├── popup.html/.css/.js    Fenêtre de l'icône
├── icons/                 Icônes 16 / 48 / 128 px
├── rules/
│   ├── base.json          Règles maison
│   ├── easylist.json      ┐
│   ├── liste_fr.json      ├ Générées par tools/build.js
│   └── easyprivacy.json   ┘
├── generated/
│   ├── cosmetic.json      Sélecteurs CSS (génériques + par site)
│   └── popups.json        Domaines de pop-ups
└── tools/
    └── build.js           Convertisseur listes Adblock Plus → declarativeNetRequest
```

## Limites connues

- Les pubs intégrées *dans* la vidéo d'un lecteur externe ne sont pas bloquées (seuls ses pop-ups sont fermés).
- YouTube et les réseaux sociaux mélangent pubs et contenu sur le même domaine : le blocage y est partiel.
- Les syntaxes avancées d'uBlock Origin (`:has-text`, scriptlets, `redirect`…) ne sont pas prises en charge.

## Crédits et licence

Les listes de filtres viennent de [EasyList](https://easylist.to), [Liste FR](https://forums.lanik.us/viewforum.php?f=91)
et [EasyPrivacy](https://easylist.to). Elles sont maintenues par leurs communautés et distribuées sous double
licence GPLv3 / CC BY-SA 3.0.

Stopper est distribué sous licence **GNU GPL v3 ou ultérieure**, ce qui est compatible avec ces listes.
