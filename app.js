import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, setDoc,
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
const idDe = code => encodeURIComponent(code);

let articles = {};   // code -> article
let histo = [];      // mouvements récents
let user = null;
let unsubs = [];

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const bas = a => a.min > 0 && a.qte <= a.min;
const fmt = n => Math.round(n * 1000) / 1000;
const erreur = e => { console.error(e); toast('Erreur : ' + (e.code || e.message || e)); };

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
  ({ t: Date.now(), type, code: a.code, nom: a.nom, delta, apres, note: note || '', user: user ? user.email : '' });

// ---------- Connexion ----------
onAuthStateChanged(auth, u => {
  user = u;
  unsubs.forEach(f => f()); unsubs = [];
  $('#login').classList.toggle('hidden', !!u);
  if (!u) { articles = {}; histo = []; stopScan(); render(); return; }
  $('#userInfo').textContent = 'Connecté : ' + u.email;
  unsubs.push(onSnapshot(colArt, { includeMetadataChanges: true }, snap => {
    articles = {};
    snap.forEach(d => { const a = d.data(); articles[a.code] = a; });
    $('#syncInfo').textContent = snap.metadata.fromCache
      ? '⚠ Hors-ligne ou en attente de synchronisation' : '✓ Synchronisé';
    render();
  }, erreur));
  unsubs.push(onSnapshot(query(colMv, orderBy('t', 'desc'), limit(300)), snap => {
    histo = snap.docs.map(d => d.data()); render();
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
  compte: 'Scannez un article puis saisissez la quantité réellement comptée.'
};
$$('.mode').forEach(b => b.onclick = () => {
  mode = b.dataset.mode;
  $$('.mode').forEach(x => x.classList.toggle('actif', x === b));
  $('#aideMode').textContent = AIDE[mode];
});
$('#aideMode').textContent = AIDE[mode];

// ---------- Scanner ----------
let scanner = null, scanning = false, lastCode = '', lastTime = 0, torchOn = false, scanPourFiche = false;

async function startScan() {
  if (scanning) return;
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
  if (scanPourFiche) {
    scanPourFiche = false; stopScan();
    return ouvrirArticle(articles[code] || null, code);
  }
  const a = articles[code];
  if (!a) { pause(); toast('Code inconnu : création'); return ouvrirArticle(null, code); }
  ouvrirQte(a);
}

// ---------- Dialogue quantité ----------
let qArt = null;
function ouvrirQte(a) {
  qArt = a;
  const lib = { sortie: 'Sortie', entree: 'Entrée', compte: 'Comptage' }[mode];
  $('#q_titre').textContent = `${lib} — ${a.nom}`;
  $('#q_info').textContent = `Stock actuel : ${fmt(a.qte)} ${a.unite}` + (a.empl ? ` · ${a.empl}` : '');
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
  const v = +$('#q_val').value, a = articles[qArt.code] || qArt, note = $('#q_note').value.trim();
  if (isNaN(v) || v < 0) return;
  let delta, type;
  if (mode === 'sortie') { delta = -v; type = 'sortie'; }
  else if (mode === 'entree') { delta = v; type = 'entrée'; }
  else { delta = fmt(v - a.qte); type = 'comptage'; }
  if (mode === 'sortie' && v > a.qte && !confirm(`Sortie (${v}) supérieure au stock (${fmt(a.qte)}). Continuer ?`)) return;
  const apres = fmt(a.qte + delta);
  const batch = writeBatch(fs);
  // Entrée/sortie : incrément côté serveur, pour que deux utilisateurs simultanés ne s'écrasent pas.
  batch.update(doc(fs, 'articles', idDe(a.code)), { qte: mode === 'compte' ? v : increment(delta) });
  batch.set(doc(colMv), mvDoc(type, a, fmt(delta), apres, note));
  batch.commit().catch(erreur);
  const d = $('#dernier');
  d.classList.remove('hidden');
  d.style.borderLeftColor = a.min > 0 && apres <= a.min ? 'var(--bad)' : 'var(--ok)';
  d.innerHTML = `<b>${esc(a.nom)}</b><br>${type} ${delta > 0 ? '+' : ''}${fmt(delta)} → <b>${apres} ${esc(a.unite)}</b>` +
    (a.min > 0 && apres <= a.min ? `<br><span style="color:var(--bad)">⚠ Stock bas (min ${fmt(a.min)})</span>` : '');
  toast('Enregistré');
};

// ---------- Fiche article ----------
let editCode = null;
function ouvrirArticle(a, codePre) {
  editCode = a ? a.code : null;
  $('#dlgTitre').textContent = a ? 'Modifier article' : 'Nouvel article';
  $('#a_code').value = a ? a.code : (codePre || '');
  $('#a_nom').value = a ? a.nom : '';
  $('#a_cat').value = a ? a.cat : '';
  $('#a_empl').value = a ? a.empl : '';
  $('#a_qte').value = a ? a.qte : 0;
  $('#a_min').value = a ? a.min : 0;
  $('#a_unite').value = a ? a.unite : 'unité';
  $('#a_suppr').classList.toggle('hidden', !a);
  $('#dlgArticle').showModal();
}
$('#btnNouveau').onclick = () => ouvrirArticle(null);
$('#a_annuler').onclick = () => $('#dlgArticle').close();
$('#dlgArticle').addEventListener('close', reprendre);
$('#a_suppr').onclick = () => {
  if (!confirm('Supprimer cet article pour tous les utilisateurs ?')) return;
  const batch = writeBatch(fs);
  batch.delete(doc(fs, 'articles', idDe(editCode)));
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
  const ancien = articles[code];
  const a = {
    code, nom, cat: $('#a_cat').value.trim(), empl: $('#a_empl').value.trim(),
    qte: +$('#a_qte').value || 0, min: +$('#a_min').value || 0, unite: $('#a_unite').value.trim() || 'unité'
  };
  const batch = writeBatch(fs);
  if (editCode && editCode !== code) batch.delete(doc(fs, 'articles', idDe(editCode)));
  batch.set(doc(fs, 'articles', idDe(code)), a);
  if (!ancien && a.qte) batch.set(doc(colMv), mvDoc('création', a, a.qte, a.qte, ''));
  else if (ancien && ancien.qte !== a.qte) batch.set(doc(colMv), mvDoc('ajustement', a, fmt(a.qte - ancien.qte), a.qte, 'modif. fiche'));
  batch.commit().catch(erreur);
  toast('Article enregistré');
};

// ---------- Rendu ----------
function render() {
  const arts = Object.values(articles);
  const nbBas = arts.filter(bas).length;
  const bd = $('#alerteBadge');
  bd.classList.toggle('hidden', !nbBas); bd.textContent = `${nbBas} stock bas`;

  const cats = [...new Set(arts.map(a => a.cat).filter(Boolean))].sort();
  const fc = $('#filtreCat'), cur = fc.value;
  fc.innerHTML = '<option value="">Toutes catégories</option>' + cats.map(c => `<option>${esc(c)}</option>`).join('');
  fc.value = cats.includes(cur) ? cur : '';
  $('#listeCat').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');

  const q = $('#recherche').value.toLowerCase().trim(), cat = fc.value, soloBas = $('#filtreBas').checked;
  const res = arts.filter(a => (!cat || a.cat === cat) && (!soloBas || bas(a)) &&
    (!q || [a.nom, a.code, a.empl, a.cat].join(' ').toLowerCase().includes(q)))
    .sort((x, y) => x.nom.localeCompare(y.nom, 'fr'));
  $('#liste').innerHTML = res.length ? res.map(a => `
    <div class="art ${bas(a) ? 'bas' : ''}" data-code="${esc(a.code)}">
      <div class="i"><div class="n">${esc(a.nom)}</div>
      <div class="s">${esc(a.code)}${a.empl ? ' · ' + esc(a.empl) : ''}${a.cat ? ' · ' + esc(a.cat) : ''}</div></div>
      <div class="qte">${fmt(a.qte)}<small>${esc(a.unite)}${a.min ? ' · min ' + fmt(a.min) : ''}</small></div>
    </div>`).join('') :
    '<p class="aide">Aucun article. Scannez un code ou appuyez sur ＋.</p>';
  $$('#liste .art').forEach(el => el.onclick = () => ouvrirArticle(articles[el.dataset.code]));

  $('#histo').innerHTML = histo.map(h => {
    const c = h.type === 'sortie' ? 's' : h.type === 'comptage' || h.type === 'ajustement' ? 'c' : 'e';
    return `<div class="mv"><div><b class="${c}">${esc(h.type)} ${h.delta > 0 ? '+' : ''}${fmt(h.delta)}</b> ${esc(h.nom)}
      <div class="aide">${new Date(h.t).toLocaleString('fr-CA')} · reste ${fmt(h.apres)}${h.user ? ' · ' + esc(h.user) : ''}${h.note ? ' · ' + esc(h.note) : ''}</div></div></div>`;
  }).join('') || '<p class="aide">Aucun mouvement.</p>';
}
['#recherche', '#filtreCat', '#filtreBas'].forEach(s => $(s).addEventListener('input', render));

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
  csv([['code', 'nom', 'categorie', 'emplacement', 'quantite', 'minimum', 'unite'],
    ...Object.values(articles).map(a => [a.code, a.nom, a.cat, a.empl, a.qte, a.min, a.unite])]), 'text/csv');
$('#btnExpHisto').onclick = () => telecharger(`historique-${jour()}.csv`,
  csv([['date', 'type', 'code', 'nom', 'variation', 'apres', 'utilisateur', 'note'],
    ...histo.map(h => [new Date(h.t).toISOString(), h.type, h.code, h.nom, h.delta, h.apres, h.user || '', h.note])]), 'text/csv');
$('#btnExpJson').onclick = () => telecharger(`sauvegarde-${jour()}.json`, JSON.stringify({ articles, histo }), 'application/json');

// Écriture par lots de 400 (limite Firestore : 500)
async function ecrireLots(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(fs);
    ops.slice(i, i + 400).forEach(f => f(batch));
    await batch.commit();
  }
}
$('#btnReset').onclick = async () => {
  if (prompt('Cela efface TOUS les articles et l\'historique pour tous les utilisateurs.\nTapez EFFACER pour confirmer.') !== 'EFFACER') return;
  try {
    const [a, m] = await Promise.all([getDocs(colArt), getDocs(colMv)]);
    await ecrireLots([...a.docs, ...m.docs].map(d => b => b.delete(d.ref)));
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
  const f = e.target.files[0]; if (!f) return;
  const txt = await f.text();
  try {
    let liste = [];
    if (f.name.endsWith('.json')) {
      const d = JSON.parse(txt);
      if (!d.articles) throw 0;
      liste = Object.values(d.articles);
      if (!confirm(`Restaurer ${liste.length} articles (écrase ceux ayant le même code) ?`)) return;
    } else {
      const rows = parseCsv(txt), h = rows.shift().map(x => x.trim().toLowerCase());
      const idx = n => h.findIndex(x => x.startsWith(n));
      const [ic, inom, icat, iem, iq, imin, iu] = ['code', 'nom', 'cat', 'empl', 'quant', 'min', 'unit'].map(idx);
      if (ic < 0 || inom < 0) throw 0;
      const num = (r, i) => i < 0 ? 0 : parseFloat((r[i] || '0').replace(',', '.')) || 0;
      rows.forEach(r => {
        const code = (r[ic] || '').trim(); if (!code) return;
        liste.push({ code, nom: r[inom] || code, cat: icat < 0 ? '' : r[icat] || '', empl: iem < 0 ? '' : r[iem] || '',
          qte: num(r, iq), min: num(r, imin), unite: iu < 0 ? 'unité' : r[iu] || 'unité' });
      });
    }
    await ecrireLots(liste.map(a => b => b.set(doc(fs, 'articles', idDe(a.code)), a)));
    toast(liste.length + ' articles importés');
  } catch (err) { alert('Fichier invalide ou écriture refusée.'); }
  e.target.value = '';
};

// ---------- PWA ----------
if ('serviceWorker' in navigator && location.protocol.startsWith('http'))
  navigator.serviceWorker.register('sw.js').catch(() => {});

render();
