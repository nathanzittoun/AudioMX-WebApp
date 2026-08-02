# Rapport de préparation — hero AudioMX

Trois livrables de validation, avant tout rendu final : six stills, un animatic
de 14 s, et ce rapport. Rien de coûteux n'a été lancé.

---

## 1. Comment les textures sont mappées

**Objet cible :** `Screen-1`, la dalle existante du modèle. Aucune géométrie
modifiée, aucun objet ajouté.

**Coordonnées.** Le matériau `SCREEN_glass` utilise les coordonnées *Generated*
(boîte englobante normalisée de l'objet), avec **X → U** et **Z → V**. Ce choix
rend le mapping indépendant de la position et de la rotation du device : la
texture reste calée sur la dalle quel que soit l'angle de caméra.

**Chaîne émissive.** La PNG alimente `Emission Color` à une intensité de **5.2**,
sous le verre existant : base quasi noire (0.0015), spéculaire 0.10, rugosité
0.30. L'interface se lit donc comme un OLED sous une vitre, pas comme un
autocollant — c'est le verre qui reçoit les reflets du studio, pas l'image.

**Ratio.** La dalle mesure 53 × 33 mm, soit un rapport de **1,606**. Tes PNG font
960 × 600, soit **1,600**. L'écart est de 0,4 %, ce qui étire l'image
verticalement d'environ **2 px sur 600**. Invisible à l'œil, mais si tu veux
l'exactitude au pixel je peux corriger le V d'un facteur 0,9963 — dis-le-moi.

---

## 2. Ce qui est animé, et comment

Dans l'animatic, **les six plaques sont tes PNG statiques**. C'était le but :
valider le minutage et le mouvement de caméra sans engager de rendu.

Pour le rendu final, je ne régénère pas tes écrans. Je **composite les éléments
animés par-dessus tes plaques**, qui restent la source de vérité pour la
typographie, la mise en page et les couleurs. Éléments à reconstruire :

| Écran | Élément animé | Méthode |
|---|---|---|
| 01 | Surbrillance du patient sélectionné | Rectangle arrondi recomposé, opacité et luminosité montantes |
| 02 | Deux anneaux qui se rejoignent, une pulsation | Anneaux redessinés, translation puis pulsation d'échelle |
| 03 | La sélection Pa-Ta-Ka se pose | Pilule bleue, expansion verticale de 8 px + fondu |
| 04 | Chrono 0.0 → 8.0 s, waveform, ligne de progression | Chiffres en Geist Mono, barres redessinées par frame |
| 05 | Trois mesures qui s'inscrivent l'une après l'autre | Cartes recomposées, apparition décalée de 0,25 s |
| 06 | La coche se trace puis tient | Arc progressif sur le cercle existant |

**Typographie.** J'ai trouvé tes polices dans `assets/fonts/` et je les ai
converties de woff2 en TTF. Ce sont des **fontes variables**, axe de graisse
100–900, et l'axe est pilotable — je peux donc reproduire exactement les
graisses de tes plaques, y compris le Geist Mono des chiffres. Vérifié par un
rendu test avant d'écrire ce rapport.

---

## 3. Minutage retenu

| Temps | Frames (15 fps) | État |
|---|---|---|
| 0,0 – 2,0 s | 1 – 30 | Sélection du patient |
| 2,0 – 3,5 s | 31 – 52 | Connexion Epic |
| 3,5 – 5,5 s | 53 – 82 | Choix Pa-Ta-Ka |
| 5,5 – 9,0 s | 83 – 135 | Enregistrement |
| 9,0 – 11,0 s | 136 – 165 | Validation et sauvegarde |
| 11,0 – 14,0 s | 166 – 210 | Écran final et recul caméra |

**Caméra.** Trois quarts large jusqu'à 1,5 s, puis passage progressif en macro
jusqu'à 5,5 s avec redressement de −25° à 0°. Maintien macro pendant
l'enregistrement et la validation. Recul vers la pose d'ouverture de 11 à 14 s.
La dalle s'éteint doucement sur les 14 dernières frames, ce qui permet à la
dernière image de raccorder proprement sur la première.

---

## 4. Garde-fous respectés

Aucun diagnostic, score de risque ou probabilité n'apparaît. Les identifiants
patients sont synthétiques et repris tels quels de tes plaques. Aucun logo
partenaire. « Epic connected » reste un état de connexion : rien n'affirme que
l'enregistrement a été écrit dans un dossier.

---

## 5. Ce qui reste à faire après ton accord

- Générer les six séquences d'interface animées (environ 420 images).
- Rendre 420 frames en Cycles à 900 × 1160 — **compter une heure**.
- Convertir en WebP, produire l'image poster.
- Produire la version *reduced-motion* figée sur l'état final.
- Sauvegarder le `.blend` avec les calques nommés.

Un point à trancher : ton `.blend` est actuellement sur le Bureau sous le nom
`Untitled.blend`. Je peux l'enregistrer dans ce dossier sous un nom explicite
au moment du rendu final.
