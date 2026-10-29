# Inventaire consommables (PWA)

Application de gestion d'inventaire avec scan de codes-barres. Fonctionne sur iPhone, iPad et Android.
La caméra exige une page **HTTPS**.

## Option A : Netlify Drop (le plus simple, sans compte Git)
1. Aller sur https://app.netlify.com/drop
2. Glisser-déposer ce dossier. Netlify donne une adresse https://xxxx.netlify.app

## Option B : GitHub Pages
1. Créer un dépôt sur GitHub (ex. `inventaire`), puis :
   git remote add origin https://github.com/VOTRE-COMPTE/inventaire.git
   git push -u origin main
2. Dépôt > Settings > Pages > Source : branche `main`, dossier `/ (root)`.
3. Adresse : https://VOTRE-COMPTE.github.io/inventaire/

## Option C : serveur interne (IIS / Apache / nginx) en HTTPS
Copier les fichiers du dossier tels quels (site statique).

## Installer sur l'appareil
- iPhone/iPad : ouvrir l'adresse dans Safari > Partager > « Sur l'écran d'accueil ».
- Android : Chrome > menu > « Installer l'application ».

Note : en dépôt public, le code est visible, mais les données d'inventaire restent sur l'appareil.
