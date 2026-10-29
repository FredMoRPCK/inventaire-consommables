(() => {
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const KEY = 'inv-consommables-v1';

// ---------- Données ----------
let db = { articles: {}, histo: [] };
try { db = JSON.parse(localStorage.getItem(KEY)) || db; } catch (e) {}
const save = () => localStorage.setItem(KEY, JSON.stringify(db));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const bas = a => a.min > 0 && a.qte <= a.min;
const fmt = n => Math.round(n * 1000) / 1000;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 2200);
}
function beep() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    const o = c.createOscillator(); o.frequency.value = 880; o.connect(c.destination);
    o.start(); setTimeout(() => { o.stop(); c.close(); }, 90);
  } catch (e) {}
  if (navigator.vibrate) navigator.vibrate(50);
}
function log(type, a, delta, apres, note) {
  db.histo.unshift({ t: Date.now(), type, code: a.code, nom: a.nom, delta, apres, note: note || '' });
  if (db.histo.length > 5000) db.histo.length = 5000;
}

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
let scanner = null, scanning = false, lastCode = '', lastTime = 0, torchOn = false;

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
  const a = db.articles[code];
  if (!a) {
    if (scanning && scanner.pause) try { scanner.pause(true); } catch (e) {}
    toast('Code inconnu : création');
    return ouvrirArticle(null, code);
  }
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
  if (scanning) try { scanner.pause(true); } catch (e) {}
  $('#dlgQte').showModal();
  setTimeout(() => { $('#q_val').focus(); $('#q_val').select(); }, 50);
}
const reprendre = () => { if (scanning) try { scanner.resume(); } catch (e) {} };
$('#q_moins').onclick = () => $('#q_val').value = Math.max(0, fmt(+$('#q_val').value - 1));
$('#q_plus').onclick = () => $('#q_val').value = fmt(+$('#q_val').value + 1);
$('#q_annuler').onclick = () => $('#dlgQte').close();
$('#dlgQte').addEventListener('close', reprendre);
$('#formQte').onsubmit = () => {
  const v = +$('#q_val').value, a = qArt, note = $('#q_note').value.trim();
  if (isNaN(v) || v < 0) return;
  let delta, type;
  if (mode === 'sortie') { delta = -v; type = 'sortie'; }
  else if (mode === 'entree') { delta = v; type = 'entrée'; }
  else { delta = v - a.qte; type = 'comptage'; }
  if (mode === 'sortie' && v > a.qte && !confirm(`Sortie (${v}) supérieure au stock (${fmt(a.qte)}). Continuer ?`)) return;
  a.qte = fmt(a.qte + delta);
  log(type, a, fmt(delta), a.qte, note);
  save(); render();
  const d = $('#dernier');
  d.classList.remove('hidden');
  d.style.borderLeftColor = bas(a) ? 'var(--bad)' : 'var(--ok)';
  d.innerHTML = `<b>${esc(a.nom)}</b><br>${type} ${delta > 0 ? '+' : ''}${fmt(delta)} → <b>${fmt(a.qte)} ${esc(a.unite)}</b>` +
    (bas(a) ? `<br><span style="color:var(--bad)">⚠ Stock bas (min ${fmt(a.min)})</span>` : '');
  toast('Enregistré');
};

// ---------- Fiche article ----------
let editCode = null, scanPourFiche = false;
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
  if (confirm('Supprimer cet article ?')) { delete db.articles[editCode]; save(); render(); $('#dlgArticle').close(); }
};
$('#a_scan').onclick = async () => {
  // Scan rapide pour remplir le code de la fiche
  if (!window.Html5Qrcode) return toast('Scan indisponible');
  const dlg = $('#dlgArticle'); dlg.close();
  document.querySelector('.tab[data-vue=scan]').click();
  scanPourFiche = true;
  toast('Scannez le code à associer');
  startScan();
};
const _traiter = traiter;
traiter = function (code) {
  if (scanPourFiche) {
    scanPourFiche = false; stopScan();
    ouvrirArticle(db.articles[code] || null, code); return;
  }
  _traiter(code);
};
$('#formArticle').onsubmit = () => {
  const code = $('#a_code').value.trim(), nom = $('#a_nom').value.trim();
  if (!code || !nom) return;
  if (editCode && editCode !== code) delete db.articles[editCode];
  const ancien = db.articles[code];
  const a = {
    code, nom, cat: $('#a_cat').value.trim(), empl: $('#a_empl').value.trim(),
    qte: +$('#a_qte').value || 0, min: +$('#a_min').value || 0, unite: $('#a_unite').value.trim() || 'unité'
  };
  if (!ancien && a.qte) log('création', a, a.qte, a.qte, '');
  else if (ancien && ancien.qte !== a.qte) log('ajustement', a, fmt(a.qte - ancien.qte), a.qte, 'modif. fiche');
  db.articles[code] = a;
  save(); render(); toast('Article enregistré');
};
// éviter fermeture auto du dialog quand formulaire invalide : méthode dialog ferme seulement si valide (required)

// ---------- Rendu ----------
function render() {
  const arts = Object.values(db.articles);
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
  $$('#liste .art').forEach(el => el.onclick = () => ouvrirArticle(db.articles[el.dataset.code]));

  $('#histo').innerHTML = db.histo.slice(0, 300).map(h => {
    const c = h.type === 'sortie' ? 's' : h.type === 'comptage' || h.type === 'ajustement' ? 'c' : 'e';
    return `<div class="mv"><div><b class="${c}">${esc(h.type)} ${h.delta > 0 ? '+' : ''}${fmt(h.delta)}</b> ${esc(h.nom)}
      <div class="aide">${new Date(h.t).toLocaleString('fr-CA')} · reste ${fmt(h.apres)}${h.note ? ' · ' + esc(h.note) : ''}</div></div></div>`;
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
    ...Object.values(db.articles).map(a => [a.code, a.nom, a.cat, a.empl, a.qte, a.min, a.unite])]), 'text/csv');
$('#btnExpHisto').onclick = () => telecharger(`historique-${jour()}.csv`,
  csv([['date', 'type', 'code', 'nom', 'variation', 'apres', 'note'],
    ...db.histo.map(h => [new Date(h.t).toISOString(), h.type, h.code, h.nom, h.delta, h.apres, h.note])]), 'text/csv');
$('#btnExpJson').onclick = () => telecharger(`sauvegarde-${jour()}.json`, JSON.stringify(db), 'application/json');
$('#btnReset').onclick = () => {
  if (confirm('Effacer tous les articles et l\'historique ?') && confirm('Vraiment ? Action irréversible.')) {
    db = { articles: {}, histo: [] }; save(); render(); toast('Données effacées');
  }
};
function parseCsv(txt) {
  txt = txt.replace(/^﻿/, '');
  const sep = (txt.split('\n')[0].match(/;/g) || []).length >= (txt.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
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
    if (f.name.endsWith('.json')) {
      const d = JSON.parse(txt);
      if (!d.articles) throw 0;
      if (!confirm('Remplacer toutes les données par cette sauvegarde ?')) return;
      db = { articles: d.articles, histo: d.histo || [] };
    } else {
      const rows = parseCsv(txt), h = rows.shift().map(x => x.trim().toLowerCase());
      const idx = n => h.findIndex(x => x.startsWith(n));
      const [ic, inom, icat, iem, iq, imin, iu] = ['code', 'nom', 'cat', 'empl', 'quant', 'min', 'unit'].map(idx);
      if (ic < 0 || inom < 0) throw 0;
      let n = 0;
      rows.forEach(r => {
        const code = (r[ic] || '').trim(); if (!code) return;
        db.articles[code] = { code, nom: r[inom] || code, cat: icat < 0 ? '' : r[icat] || '', empl: iem < 0 ? '' : r[iem] || '',
          qte: iq < 0 ? 0 : parseFloat((r[iq] || '0').replace(',', '.')) || 0,
          min: imin < 0 ? 0 : parseFloat((r[imin] || '0').replace(',', '.')) || 0,
          unite: iu < 0 ? 'unité' : r[iu] || 'unité' };
        n++;
      });
      toast(n + ' articles importés');
    }
    save(); render();
  } catch (err) { alert('Fichier invalide.'); }
  e.target.value = '';
};

// ---------- PWA ----------
if ('serviceWorker' in navigator && location.protocol.startsWith('http'))
  navigator.serviceWorker.register('sw.js').catch(() => {});

render();
})();
