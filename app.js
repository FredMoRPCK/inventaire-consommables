import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc,
  onSnapshot, query, orderBy, limit, writeBatch, increment, getDocs }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// ---------- Firebase ----------
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const fs = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
const colArt = collection(fs, 'articles');
const colMv = collection(fs, 'mouvements');
const colMag = collection(fs, 'magasins');

// Administrateurs : doit correspondre à la liste dans firestore.rules (les règles font foi, l'interface ne fait que masquer)
const ADMINS = ['frederic.morin@ropack.com'];
const isAdmin = () => !!user && ADMINS.includes((user.email || '').toLowerCase());

// Un article = un code dans un magasin. Même code dans deux magasins = deux documents, deux stocks.
const idArt = (mid, code) => mid + '__' + encodeURIComponent(code);

let magasins = {};   // id -> {id, nom}
let articles = {};   // idArt -> article
let histo = [];      // mouvements récents
let user = null;
let unsubs = [];
let mCur = '';       // magasin actif
try { mCur = localStorage.getItem('inv-magasin') || ''; } catch (e) {}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const bas = a => a.min > 0 && a.qte <= a.min;
const fmt = n => Math.round(n * 1000) / 1000;
const nomMag = id => (magasins[id] && magasins[id].nom) || '(magasin supprimé)';
const erreur = e => { console.error(e); toast('Erreur : ' + (e.code || e.message || e)); };
const arts = () => Object.values(articles).filter(a => magasins[a.magasin]);
const artsMag = () => arts().filter(a => a.magasin === mCur);

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 2600);
}
function beep() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    const o = c.createOscillator(); o.frequency.value = 880; o.connect(c.destination);
    o.start(); setTimeout(() => { o.stop(); c.close(); }, 90);
  } catch (e) {}
  if (navigator.vibrate) navigator.vibrate(50);
}
const mvDoc = (type, a, delta, apres, note) =>
  ({ t: Date.now(), type, magasin: a.magasin, code: a.code, nom: a.nom, delta, apres, note: note || '', user: user ? user.email : '' });

// ---------- Connexion ----------
onAuthStateChanged(auth, u => {
  user = u;
  unsubs.forEach(f => f()); unsubs = [];
  $('#login').classList.toggle('hidden', !!u);
  document.body.classList.toggle('est-admin', isAdmin());
  if (!u) { magasins = {}; articles = {}; histo = []; stopScan(); render(); return; }
  $('#userInfo').textContent = 'Connecté : ' + u.email + (isAdmin() ? ' (administrateur)' : '');
  unsubs.push(onSnapshot(colMag, snap => {
    magasins = {};
    snap.forEach(d => { magasins[d.id] = { id: d.id, ...d.data() }; });
    // Reprend le dernier magasin choisi sur cet appareil ; sinon le premier de la liste
    let saved = ''; try { saved = localStorage.getItem('inv-magasin') || ''; } catch (e) {}
    if (magasins[saved]) mCur = saved;
    else if (!magasins[mCur]) mCur = Object.keys(magasins).sort((a, b) => nomMag(a).localeCompare(nomMag(b), 'fr'))[0] || '';
    render();
  }, erreur));
  unsubs.push(onSnapshot(colArt, { includeMetadataChanges: true }, snap => {
    articles = {};
    snap.forEach(d => { articles[d.id] = d.data(); });
    $('#syncInfo').textContent = snap.metadata.fromCache
      ? '⚠ Hors-ligne ou en attente de synchronisation' : '✓ Synchronisé';
    render();
  }, erreur));
  unsubs.push(onSnapshot(query(colMv, orderBy('t', 'desc'), limit(600)), snap => {
    histo = snap.docs.map(d => ({ ...d.data(), _id: d.id })); render();
  }, erreur));
});
$('#formLogin').onsubmit = async e => {
  e.preventDefault(); $('#l_err').textContent = '';
  try { await signInWithEmailAndPassword(auth, $('#l_email').value.trim(), $('#l_pass').value); $('#l_pass').value = ''; }
  catch (err) {
    $('#l_err').textContent = ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found'].includes(err.code)
      ? 'Courriel ou mot de passe incorrect.' : err.code === 'auth/network-request-failed' ? 'Réseau indisponible.' : 'Erreur : ' + err.code;
  }
};
$('#l_reset').onclick = async () => {
  const em = $('#l_email').value.trim();
  if (!em) { $('#l_err').textContent = 'Entrez votre courriel, puis réessayez.'; return; }
  try { await sendPasswordResetEmail(auth, em); $('#l_err').textContent = 'Courriel de réinitialisation envoyé (si le compte existe).'; }
  catch (err) { $('#l_err').textContent = 'Erreur : ' + err.code; }
};
$('#btnLogout').onclick = () => signOut(auth);

// ---------- Magasins ----------
$('#selMagasin').onchange = e => {
  mCur = e.target.value;
  try { localStorage.setItem('inv-magasin', mCur); } catch (err) {}
  $('#dernier').classList.add('hidden');
  render();
};
$('#btnAjoutMag').onclick = () => {
  const nom = $('#nouveauMag').value.trim();
  if (!isAdmin() || !nom) return;
  if (Object.values(magasins).some(m => m.nom.toLowerCase() === nom.toLowerCase())) return toast('Ce magasin existe déjà');
  const ref = doc(colMag);
  const batch = writeBatch(fs); batch.set(ref, { nom }); batch.commit().catch(erreur);
  $('#nouveauMag').value = '';
  if (!mCur) mCur = ref.id;
  toast('Magasin ajouté');
};
function renderListeMag() {
  const ids = Object.keys(magasins).sort((a, b) => nomMag(a).localeCompare(nomMag(b), 'fr'));
  $('#listeMag').innerHTML = ids.length ? ids.map(id => `
    <div class="mag"><span>${esc(magasins[id].nom)}</span>
    <button data-ren="${esc(id)}">Renommer</button><button data-del="${esc(id)}" class="danger">Supprimer</button></div>`).join('')
    : '<p class="aide">Aucun magasin. Ajoutez-en un pour commencer.</p>';
  $$('#listeMag [data-ren]').forEach(b => b.onclick = () => {
    const nom = (prompt('Nouveau nom du magasin :', magasins[b.dataset.ren].nom) || '').trim();
    if (!nom || !isAdmin()) return;
    const batch = writeBatch(fs); batch.update(doc(colMag, b.dataset.ren), { nom }); batch.commit().catch(erreur);
  });
  $$('#listeMag [data-del]').forEach(b => b.onclick = () => {
    if (!isAdmin()) return;
    if (arts().some(a => a.magasin === b.dataset.del)) return alert('Ce magasin contient encore des articles. Videz-le ou supprimez ses articles d\'abord.');
    if (!confirm(`Supprimer le magasin « ${magasins[b.dataset.del].nom} » ?`)) return;
    const batch = writeBatch(fs); batch.delete(doc(colMag, b.dataset.del)); batch.commit().catch(erreur);
  });
}

// Données créées avant l'arrivée des magasins : sans champ « magasin », donc invisibles tant qu'elles ne sont pas rattachées.
const legacyArts = () => Object.entries(articles).filter(([, a]) => !a.magasin);
const legacyMvs = () => histo.filter(h => !h.magasin);
function renderLegacy(ids) {
  const na = legacyArts().length, nm = legacyMvs().length;
  $('#cardLegacy').classList.toggle('hidden', !(na || nm) || !ids.length);
  if (!(na || nm)) return;
  $('#legacyInfo').textContent = `${na} article(s) et ${nm} mouvement(s) datent d'avant les magasins et sont masqués. Choisissez le magasin auquel les rattacher.`;
  const s = $('#legacyMag'), cur = s.value;
  s.innerHTML = ids.map(id => `<option value="${esc(id)}">${esc(magasins[id].nom)}</option>`).join('');
  if (ids.includes(cur)) s.value = cur;
}
$('#btnRattacher').onclick = async () => {
  const mag = $('#legacyMag').value;
  if (!isAdmin() || !mag) return;
  const la = legacyArts(), lm = legacyMvs();
  if (!confirm(`Rattacher ${la.length} article(s) et ${lm.length} mouvement(s) au magasin « ${nomMag(mag)} » ?`)) return;
  const ops = [];
  la.forEach(([oldId, a]) => {
    const nid = idArt(mag, a.code), exist = articles[nid];
    // Si le même code existe déjà dans ce magasin, on additionne les quantités
    if (exist) ops.push(b => b.update(doc(fs, 'articles', nid), { qte: increment(a.qte || 0) }));
    else ops.push(b => b.set(doc(fs, 'articles', nid), { ...a, magasin: mag }));
    ops.push(b => b.delete(doc(fs, 'articles', oldId)));
  });
  lm.forEach(h => {
    const { _id, ...reste } = h;
    ops.push(b => b.set(doc(colMv), { ...reste, magasin: mag }));
    ops.push(b => b.delete(doc(colMv, _id)));
  });
  try { await ecrireLots(ops); toast('Données rattachées'); } catch (e) { erreur(e); }
};

// ---------- Navigation ----------
$$('.tab').forEach(b => b.onclick = () => {
  $$('.tab').forEach(x => x.classList.toggle('actif', x === b));
  $$('.vue').forEach(v => v.classList.toggle('actif', v.id === 'vue-' + b.dataset.vue));
  $('#titre').textContent = {scan:'Scanner',stock:'Stock',histo:'Historique',data:'Données'}[b.dataset.vue];
  if (b.dataset.vue !== 'scan') stopScan();
  render();
});

// ---------- Modes ----------
let mode = 'sortie';
const AIDE = {
  sortie: 'Scannez un article pour retirer du stock (consommation).',
  entree: 'Scannez un article pour ajouter du stock (réception).',
  compte: 'Scannez un article puis saisissez la quantité réellement comptée.',
  transfert: 'Scannez un article du magasin choisi en haut, puis indiquez la quantité et le magasin de destination.'
};
$$('.mode').forEach(b => b.onclick = () => {
  if (b.dataset.mode === 'transfert' && Object.keys(magasins).length < 2) return toast('Il faut au moins deux magasins pour un transfert');
  mode = b.dataset.mode;
  $$('.mode').forEach(x => x.classList.toggle('actif', x === b));
  $('#aideMode').textContent = AIDE[mode];
});
$('#aideMode').textContent = AIDE[mode];

// ---------- Scanner ----------
let scanner = null, scanning = false, lastCode = '', lastTime = 0, torchOn = false, scanPourFiche = false;

async function startScan() {
  if (scanning) return;
  if (!mCur) return toast('Aucun magasin : demandez à l\'administrateur d\'en créer un');
  if (!window.Html5Qrcode) return toast('Bibliothèque de scan non chargée (connexion requise la 1re fois)');
  if (!window.isSecureContext) return toast('La caméra exige HTTPS');
  scanner = scanner || new Html5Qrcode('lecteur', {
    verbose: false,
    useBarCodeDetectorIfSupported: true,
    formatsToSupport: [
      Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39,
      Html5QrcodeSupportedFormats.CODE_93, Html5QrcodeSupportedFormats.ITF,
      Html5QrcodeSupportedFormats.CODABAR, Html5QrcodeSupportedFormats.QR_CODE,
      Html5QrcodeSupportedFormats.DATA_MATRIX
    ]
  });
  try {
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: (w, h) => ({ width: Math.floor(w * 0.85), height: Math.floor(Math.min(h, w) * 0.5) }) },
      onCode, () => {});
    scanning = true;
    $('#lecteurBox').classList.add('on');
    $('#btnScan').textContent = '⏹ Arrêter';
    try {
      const caps = scanner.getRunningTrackCapabilities();
      $('#btnTorch').classList.toggle('hidden', !(caps && caps.torch));
    } catch (e) {}
  } catch (e) {
    toast('Caméra inaccessible : ' + (e.message || e));
  }
}
async function stopScan() {
  if (!scanner || !scanning) return;
  try { await scanner.stop(); } catch (e) {}
  scanning = false; torchOn = false;
  $('#lecteurBox').classList.remove('on');
  $('#btnScan').textContent = '📷 Scanner';
  $('#btnTorch').classList.add('hidden');
}
$('#btnScan').onclick = () => scanning ? stopScan() : startScan();
$('#btnTorch').onclick = async () => {
  try { torchOn = !torchOn; await scanner.applyVideoConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) {}
};
const pause = () => { if (scanning) try { scanner.pause(true); } catch (e) {} };
const reprendre = () => { if (scanning) try { scanner.resume(); } catch (e) {} };

function onCode(code) {
  const now = Date.now();
  if (code === lastCode && now - lastTime < 2500) return;
  lastCode = code; lastTime = now;
  beep();
  traiter(code);
}
$('#formCode').onsubmit = e => {
  e.preventDefault();
  const v = $('#codeManuel').value.trim();
  if (v) { traiter(v); $('#codeManuel').value = ''; }
};

function traiter(code) {
  if (!mCur) return toast('Aucun magasin sélectionné');
  if (scanPourFiche) {
    scanPourFiche = false; stopScan();
    return ouvrirArticle(articles[idArt(editMag, code)] || null, code, editMag);
  }
  const a = articles[idArt(mCur, code)];
  if (!a) { pause(); toast('Code inconnu dans ce magasin : création'); return ouvrirArticle(null, code, mCur); }
  ouvrirQte(a);
}

// ---------- Dialogue quantité ----------
let qArt = null;
function ouvrirQte(a) {
  qArt = a;
  const lib = { sortie: 'Sortie', entree: 'Entrée', compte: 'Comptage', transfert: 'Transfert' }[mode];
  const dests = Object.keys(magasins).filter(id => id !== a.magasin)
    .sort((x, y) => nomMag(x).localeCompare(nomMag(y), 'fr'));
  $('#q_dest').innerHTML = dests.map(id => `<option value="${esc(id)}">${esc(magasins[id].nom)}</option>`).join('');
  $('#q_destBox').classList.toggle('hidden', mode !== 'transfert');
  $('#q_dest').required = mode === 'transfert';
  $('#q_titre').textContent = `${lib} — ${a.nom}`;
  $('#q_info').textContent = `${nomMag(a.magasin)} · Stock actuel : ${fmt(a.qte)} ${a.unite}` + (a.empl ? ` · ${a.empl}` : '');
  $('#q_val').value = mode === 'compte' ? fmt(a.qte) : 1;
  $('#q_note').value = '';
  pause();
  $('#dlgQte').showModal();
  setTimeout(() => { $('#q_val').focus(); $('#q_val').select(); }, 50);
}
$('#q_moins').onclick = () => $('#q_val').value = Math.max(0, fmt(+$('#q_val').value - 1));
$('#q_plus').onclick = () => $('#q_val').value = fmt(+$('#q_val').value + 1);
$('#q_annuler').onclick = () => $('#dlgQte').close();
$('#dlgQte').addEventListener('close', reprendre);
$('#formQte').onsubmit = () => {
  const v = +$('#q_val').value, a = articles[idArt(qArt.magasin, qArt.code)] || qArt, note = $('#q_note').value.trim();
  if (isNaN(v) || v < 0) return;
  if (mode === 'transfert') return faireTransfert(a, v, note);
  let delta, type;
  if (mode === 'sortie') { delta = -v; type = 'sortie'; }
  else if (mode === 'entree') { delta = v; type = 'entrée'; }
  else { delta = fmt(v - a.qte); type = 'comptage'; }
  if (mode === 'sortie' && v > a.qte && !confirm(`Sortie (${v}) supérieure au stock (${fmt(a.qte)}). Continuer ?`)) return;
  const apres = fmt(a.qte + delta);
  const batch = writeBatch(fs);
  // Entrée/sortie : incrément côté serveur, pour que deux utilisateurs simultanés ne s'écrasent pas.
  batch.update(doc(fs, 'articles', idArt(a.magasin, a.code)), { qte: mode === 'compte' ? v : increment(delta) });
  batch.set(doc(colMv), mvDoc(type, a, fmt(delta), apres, note));
  batch.commit().catch(erreur);
  const d = $('#dernier');
  d.classList.remove('hidden');
  d.style.borderLeftColor = a.min > 0 && apres <= a.min ? 'var(--bad)' : 'var(--ok)';
  d.innerHTML = `<b>${esc(a.nom)}</b> <span class="tag">${esc(nomMag(a.magasin))}</span><br>${type} ${delta > 0 ? '+' : ''}${fmt(delta)} → <b>${apres} ${esc(a.unite)}</b>` +
    (a.min > 0 && apres <= a.min ? `<br><span style="color:var(--bad)">⚠ Stock bas (min ${fmt(a.min)})</span>` : '');
  toast('Enregistré');
};

// Transfert : retire du magasin d'origine et ajoute au magasin de destination, dans un seul lot atomique.
function faireTransfert(a, v, note) {
  const dest = $('#q_dest').value;
  if (!dest || dest === a.magasin || !magasins[dest] || v <= 0) return;
  if (v > a.qte && !confirm(`Transfert (${v}) supérieur au stock (${fmt(a.qte)}). Continuer ?`)) return;
  const srcId = idArt(a.magasin, a.code), dstId = idArt(dest, a.code), d = articles[dstId];
  const batch = writeBatch(fs);
  batch.update(doc(fs, 'articles', srcId), { qte: increment(-v) });
  if (d) batch.update(doc(fs, 'articles', dstId), { qte: increment(v) });
  else batch.set(doc(fs, 'articles', dstId),
    { magasin: dest, code: a.code, nom: a.nom, cat: a.cat || '', empl: '', qte: v, min: 0, unite: a.unite || 'unité' });
  const apresSrc = fmt(a.qte - v), apresDst = fmt((d ? d.qte : 0) + v), suite = note ? ' · ' + note : '';
  batch.set(doc(colMv), mvDoc('transfert', a, -v, apresSrc, 'vers ' + nomMag(dest) + suite));
  batch.set(doc(colMv), mvDoc('transfert', { magasin: dest, code: a.code, nom: d ? d.nom : a.nom }, v, apresDst, 'depuis ' + nomMag(a.magasin) + suite));
  batch.commit().catch(erreur);
  const box = $('#dernier');
  box.classList.remove('hidden'); box.style.borderLeftColor = 'var(--bleu)';
  box.innerHTML = `<b>${esc(a.nom)}</b><br>Transfert de ${fmt(v)} ${esc(a.unite)} : ` +
    `<span class="tag">${esc(nomMag(a.magasin))}</span> → <span class="tag">${esc(nomMag(dest))}</span><br>` +
    `Reste : ${apresSrc} · Destination : ${apresDst}` + (d ? '' : '<br><span class="aide">Article créé dans le magasin de destination (minimum à définir).</span>');
  toast('Transfert enregistré');
}

// ---------- Fiche article ----------
let editMag = '', editId = null;
function ouvrirArticle(a, codePre, mag) {
  editMag = a ? a.magasin : (mag || mCur);
  editId = a ? idArt(a.magasin, a.code) : null;
  if (!editMag) return toast('Aucun magasin : demandez à l\'administrateur d\'en créer un');
  $('#dlgTitre').textContent = (a ? 'Modifier article' : 'Nouvel article') + ' — ' + nomMag(editMag);
  $('#a_code').value = a ? a.code : (codePre || '');
  $('#a_nom').value = a ? a.nom : '';
  $('#a_cat').value = a ? a.cat : '';
  $('#a_empl').value = a ? a.empl : '';
  $('#a_qte').value = a ? a.qte : 0;
  $('#a_min').value = a ? a.min : 0;
  $('#a_unite').value = a ? a.unite : 'unité';
  $('#a_suppr').classList.toggle('hidden', !a || !isAdmin());
  $('#dlgArticle').showModal();
}
$('#btnNouveau').onclick = () => ouvrirArticle(null);
$('#a_annuler').onclick = () => $('#dlgArticle').close();
$('#dlgArticle').addEventListener('close', reprendre);
$('#a_suppr').onclick = () => {
  if (!isAdmin()) return;
  if (!confirm(`Supprimer cet article du magasin « ${nomMag(editMag)} » pour tous les utilisateurs ?`)) return;
  const batch = writeBatch(fs);
  batch.delete(doc(fs, 'articles', editId));
  batch.commit().catch(erreur);
  $('#dlgArticle').close();
};
$('#a_scan').onclick = () => {
  if (!window.Html5Qrcode) return toast('Scan indisponible');
  $('#dlgArticle').close();
  document.querySelector('.tab[data-vue=scan]').click();
  scanPourFiche = true;
  toast('Scannez le code à associer');
  startScan();
};
$('#formArticle').onsubmit = () => {
  const code = $('#a_code').value.trim(), nom = $('#a_nom').value.trim();
  if (!code || !nom) return;
  const nouvelId = idArt(editMag, code);
  const ancien = articles[nouvelId];
  const a = {
    magasin: editMag, code, nom, cat: $('#a_cat').value.trim(), empl: $('#a_empl').value.trim(),
    qte: +$('#a_qte').value || 0, min: +$('#a_min').value || 0, unite: $('#a_unite').value.trim() || 'unité'
  };
  const batch = writeBatch(fs);
  if (editId && editId !== nouvelId) batch.delete(doc(fs, 'articles', editId));
  batch.set(doc(fs, 'articles', nouvelId), a);
  if (!ancien && a.qte) batch.set(doc(colMv), mvDoc('création', a, a.qte, a.qte, ''));
  else if (ancien && ancien.qte !== a.qte) batch.set(doc(colMv), mvDoc('ajustement', a, fmt(a.qte - ancien.qte), a.qte, 'modif. fiche'));
  batch.commit().catch(erreur);
  toast('Article enregistré');
};

// ---------- Rendu ----------
function render() {
  // Sélecteur de magasin
  const ids = Object.keys(magasins).sort((a, b) => nomMag(a).localeCompare(nomMag(b), 'fr'));
  const sel = $('#selMagasin');
  sel.innerHTML = ids.length ? ids.map(id => `<option value="${esc(id)}">${esc(magasins[id].nom)}</option>`).join('')
    : '<option value="">Aucun magasin</option>';
  sel.value = mCur;
  renderListeMag();
  renderLegacy(ids);

  const tous = $('#filtreTous').checked;
  const base = tous ? arts() : artsMag();
  const nbBas = artsMag().filter(bas).length;
  const bd = $('#alerteBadge');
  bd.classList.toggle('hidden', !nbBas); bd.textContent = `${nbBas} bas`;

  const cats = [...new Set(base.map(a => a.cat).filter(Boolean))].sort();
  const fc = $('#filtreCat'), cur = fc.value;
  fc.innerHTML = '<option value="">Toutes catégories</option>' + cats.map(c => `<option>${esc(c)}</option>`).join('');
  fc.value = cats.includes(cur) ? cur : '';
  $('#listeCat').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');

  const q = $('#recherche').value.toLowerCase().trim(), cat = fc.value, soloBas = $('#filtreBas').checked;
  const res = base.filter(a => (!cat || a.cat === cat) && (!soloBas || bas(a)) &&
    (!q || [a.nom, a.code, a.empl, a.cat].join(' ').toLowerCase().includes(q)))
    .sort((x, y) => x.nom.localeCompare(y.nom, 'fr') || nomMag(x.magasin).localeCompare(nomMag(y.magasin), 'fr'));
  $('#liste').innerHTML = res.length ? res.map(a => `
    <div class="art ${bas(a) ? 'bas' : ''}" data-id="${esc(idArt(a.magasin, a.code))}">
      <div class="i"><div class="n">${tous ? `<span class="tag">${esc(nomMag(a.magasin))}</span>` : ''}${esc(a.nom)}</div>
      <div class="s">${esc(a.code)}${a.empl ? ' · ' + esc(a.empl) : ''}${a.cat ? ' · ' + esc(a.cat) : ''}</div></div>
      <div class="qte">${fmt(a.qte)}<small>${esc(a.unite)}${a.min ? ' · min ' + fmt(a.min) : ''}</small></div>
    </div>`).join('') :
    `<p class="aide">${mCur || tous ? 'Aucun article. Scannez un code ou appuyez sur ＋.' : 'Aucun magasin. L\'administrateur doit en créer un (onglet Données).'}</p>`;
  $$('#liste .art').forEach(el => el.onclick = () => ouvrirArticle(articles[el.dataset.id]));

  const htous = $('#histoTous').checked;
  $('#histo').innerHTML = histo.filter(h => htous || h.magasin === mCur).slice(0, 300).map(h => {
    const c = h.type === 'sortie' ? 's' : h.type === 'transfert' ? 't' : h.type === 'comptage' || h.type === 'ajustement' ? 'c' : 'e';
    return `<div class="mv"><div><b class="${c}">${esc(h.type)} ${h.delta > 0 ? '+' : ''}${fmt(h.delta)}</b> ${esc(h.nom)}
      <div class="aide">${htous ? `<span class="tag">${esc(nomMag(h.magasin))}</span>` : ''}${new Date(h.t).toLocaleString('fr-CA')} · reste ${fmt(h.apres)}${h.user ? ' · ' + esc(h.user) : ''}${h.note ? ' · ' + esc(h.note) : ''}</div></div></div>`;
  }).join('') || '<p class="aide">Aucun mouvement.</p>';
}
['#recherche', '#filtreCat', '#filtreBas', '#filtreTous', '#histoTous'].forEach(s => $(s).addEventListener('input', render));

// ---------- Import / export ----------
function telecharger(nom, contenu, type) {
  const url = URL.createObjectURL(new Blob([contenu], { type }));
  const a = document.createElement('a'); a.href = url; a.download = nom; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const csvCell = v => /[;"\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
const csv = rows => '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');
const jour = () => new Date().toISOString().slice(0, 10);
$('#btnExpStock').onclick = () => telecharger(`stock-${jour()}.csv`,
  csv([['magasin', 'code', 'nom', 'categorie', 'emplacement', 'quantite', 'minimum', 'unite'],
    ...arts().sort((x, y) => nomMag(x.magasin).localeCompare(nomMag(y.magasin), 'fr') || x.nom.localeCompare(y.nom, 'fr'))
      .map(a => [nomMag(a.magasin), a.code, a.nom, a.cat, a.empl, a.qte, a.min, a.unite])]), 'text/csv');
$('#btnExpHisto').onclick = () => telecharger(`historique-${jour()}.csv`,
  csv([['date', 'magasin', 'type', 'code', 'nom', 'variation', 'apres', 'utilisateur', 'note'],
    ...histo.map(h => [new Date(h.t).toISOString(), nomMag(h.magasin), h.type, h.code, h.nom, h.delta, h.apres, h.user || '', h.note])]), 'text/csv');
$('#btnExpJson').onclick = () => telecharger(`sauvegarde-${jour()}.json`, JSON.stringify({ magasins, articles, histo }), 'application/json');

// Écriture par lots de 400 (limite Firestore : 500)
async function ecrireLots(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(fs);
    ops.slice(i, i + 400).forEach(f => f(batch));
    await batch.commit();
  }
}
$('#btnReset').onclick = async () => {
  if (!isAdmin()) return;
  if (prompt('Cela efface TOUS les magasins, articles et l\'historique pour tous les utilisateurs.\nTapez EFFACER pour confirmer.') !== 'EFFACER') return;
  try {
    const [a, m, g] = await Promise.all([getDocs(colArt), getDocs(colMv), getDocs(colMag)]);
    await ecrireLots([...a.docs, ...m.docs, ...g.docs].map(d => b => b.delete(d.ref)));
    toast('Données effacées');
  } catch (e) { erreur(e); }
};
function parseCsv(txt) {
  txt = txt.replace(/^﻿/, '');
  const l1 = txt.split('\n')[0];
  const sep = (l1.match(/;/g) || []).length >= (l1.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"') { if (txt[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && txt[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
$('#fichierImport').onchange = async e => {
  const f = e.target.files[0]; if (!f || !isAdmin()) return;
  const txt = await f.text();
  try {
    const ops = [];
    const idParNom = {};
    Object.values(magasins).forEach(m => { idParNom[m.nom.toLowerCase()] = m.id; });
    // Trouve le magasin par son nom ; le crée s'il n'existe pas
    const magId = nom => {
      const k = nom.trim().toLowerCase();
      if (!idParNom[k]) {
        const ref = doc(colMag); idParNom[k] = ref.id;
        ops.push(b => b.set(ref, { nom: nom.trim() }));
      }
      return idParNom[k];
    };
    let liste = [];
    if (f.name.endsWith('.json')) {
      const d = JSON.parse(txt);
      if (!d.articles) throw 0;
      Object.values(d.magasins || {}).forEach(m => ops.push(b => b.set(doc(colMag, m.id), { nom: m.nom })));
      liste = Object.values(d.articles).filter(a => a.magasin);
      if (!confirm(`Restaurer ${liste.length} articles (écrase ceux ayant le même code dans le même magasin) ?`)) return;
    } else {
      const rows = parseCsv(txt), h = rows.shift().map(x => x.trim().toLowerCase());
      const idx = n => h.findIndex(x => x.startsWith(n));
      const [im, ic, inom, icat, iem, iq, imin, iu] = ['mag', 'code', 'nom', 'cat', 'empl', 'quant', 'min', 'unit'].map(idx);
      if (ic < 0 || inom < 0) throw 0;
      if (im < 0 && !mCur) throw 0;
      const num = (r, i) => i < 0 ? 0 : parseFloat((r[i] || '0').replace(',', '.')) || 0;
      rows.forEach(r => {
        const code = (r[ic] || '').trim(); if (!code) return;
        const nomM = im >= 0 ? (r[im] || '').trim() : '';
        liste.push({ magasin: nomM ? magId(nomM) : mCur, code, nom: r[inom] || code, cat: icat < 0 ? '' : r[icat] || '',
          empl: iem < 0 ? '' : r[iem] || '', qte: num(r, iq), min: num(r, imin), unite: iu < 0 ? 'unité' : r[iu] || 'unité' });
      });
    }
    liste.forEach(a => ops.push(b => b.set(doc(fs, 'articles', idArt(a.magasin, a.code)), a)));
    await ecrireLots(ops);
    toast(liste.length + ' articles importés');
  } catch (err) { console.error(err); alert('Fichier invalide ou écriture refusée.'); }
  e.target.value = '';
};

// ---------- PWA ----------
if ('serviceWorker' in navigator && location.protocol.startsWith('http'))
  navigator.serviceWorker.register('sw.js').catch(() => {});

render();
