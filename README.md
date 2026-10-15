# PAINT IT

Jeu solo dans le navigateur. Un pistolet à peinture, une pièce en clay render blanc, 60 secondes. Recouvre au moins **70 %** de la pièce avant la fin du temps. La partie s'arrête dès que l'objectif est atteint.

Stack : **Three.js r186 + TypeScript + Vite**, `three-mesh-bvh` pour les raycasts, `lil-gui` pour les réglages. Aucun asset externe : la géométrie est procédurale et le son est synthétisé en WebAudio.

## Lancer

```bash
npm install
npm run dev          # http://localhost:5173
```

Build de production :

```bash
npm run build
npm run preview      # sert dist/ (un serveur est nécessaire : modules ES + Web Workers)
```

Il faut un navigateur récent avec WebGL 2 (Chrome, Edge, Firefox, Safari 17+). Si la 3D ne démarre pas, un écran d'erreur explicite s'affiche.

## Commandes

- **Souris** : viser. **Clic gauche maintenu** : peindre.
- **Échap** : pause / reprise. Une perte de focus coupe le jet et met en pause. Après une pause, il faut relâcher puis recliquer.

### Gun gyroscope (ESP32)

Bouton **Connecter le gun** sur l'accueil (ou en pause). Web Serial : **Chrome ou Edge** uniquement, à 115200 bauds.
L'Arduino envoie une ligne par mesure : `gyro.x, gyro.y, gyro.z, gachette, dt` (rad/s, `1` si gâchette appuyée, µs depuis la mesure précédente).

- À la connexion, une calibration de 2 s démarre : garder le gun immobile, pointé vers le centre de l'écran.
- **Gâchette maintenue** : peindre. Sur l'accueil elle lance la partie, en pause elle reprend.
- **C** : recalibrer · **R** : recentrer · **A** : détecter les axes (tourner à droite puis vers le haut) · **D** : valeurs de debug.
- Axes, inversions, sensibilité, angles max, zone morte et lissage : dossier **Gun** du panneau Réglages.

## Architecture

```
src/
  config.ts              Paramètres d'équilibrage, de qualité et d'effets (persistés)
  scene/
    shapes.ts            Surfaces paramétriques (rounded box, lathe) → géométrie + "charts" UV
    World.ts             Pièce, mobilier, lumières, caméra fixe (cadrage adapté au ratio)
    clayMaterial.ts      Matériau clay + injection shader (peinture, brillance humide, AO, relief)
  paint/
    PaintSystem.ts       Masques par mesh, texels de surface, tampons, combinaison, atteignabilité
    Drips.ts             Coulures (canal décoratif)
    aoWorker.ts          Bake d'occlusion ambiante en Web Workers parallèles
  game/
    Game.ts              Machine d'états, boucle à pas fixe, visée, liaison FX/audio/UI
    Score.ts             Couverture pondérée par l'aire, valeur officielle figée
    Input.ts             Souris, blocage du tir après pause
  fx/
    Tools.ts             Pistolet en premier plan, centré en bas (ressorts, recul, inertie)
    Jets.ts              Jet de peinture visible + gouttelettes (pool)
    Audio.ts             Sons synthétisés (jet pulsé, tics, paliers, fin)
  ui/                    Écrans, HUD, ressorts DOM, panneau de réglages
```

### Peinture et score

- Chaque surface peignable est construite à partir de **charts paramétriques** : des fonctions (u,v) → position/normale. La même fonction génère le mesh **et** les texels du masque. Chaque texel a donc une position monde, une normale, une **aire réelle** et un drapeau « atteignable ».
- Le masque RGBA de chaque mesh contient : R = couverture **scorée**, G = peinture **décorative** (coulures, gouttelettes, non scorée), B = inutilisé (brillance humide, héritée de la version duel), A = AO bakée.
- La simulation tourne à **pas fixe de 120 Hz** : dépôts et chronomètre ne dépendent pas de la fréquence d'affichage.
- **Atteignabilité** : seules les surfaces visibles depuis la caméra comptent (environ 66 m²).
- **Score** : `peint % = Σ aire·d(c) / Σ aire` sur les texels atteignables, avec `d(c)` une rampe 0,3→0,7 alignée sur le seuil visuel du shader.

## Réglages

Le bouton **Réglages** (accueil ou pause) ouvre le panneau. Les valeurs sont sauvegardées dans `localStorage`. Valeurs par défaut dans `src/config.ts` :

| Paramètre | Défaut | Effet |
|---|---|---|
| `matchDuration` (s) | 60 | Temps imparti |
| `goal` (%) | 70 | Couverture à atteindre |
| `paint.radius` (m) | 0.27 | Largeur du jet sur la surface |
| `paint.rate` (/s) | 7.5 | Couverture ajoutée par seconde |
| `paint.center` / `paint.edge` | 1.0 / 0.45 | Intensité au centre / au bord de l'empreinte |
| `paintIrregularity` | 0.22 | Contours irréguliers des taches |

Repère : un bot qui balaie en lignes peint environ 63 % de la pièce en 60 s. L'objectif de 70 % demande donc de viser efficacement. Effets réduits, coulures, son et qualité (Basse/Moyenne/Haute) sont aussi réglables.
