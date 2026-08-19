/* MailZen — interface web (sans dépendance externe) */
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const state = { accounts: [], folders: [], account: null, folder: null, message: null, jobs: [], chat: [], plan: null };

/* ---------- utilitaires ---------- */
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (res.status === 401) { showLogin(); throw new Error('Authentification requise'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => d ? new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtSize = (b) => b > 1048576 ? `${(b / 1048576).toFixed(1)} Mo` : `${Math.round((b || 0) / 1024)} Ko`;

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${isError ? ' err' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), 5000);
}
function modal(html) {
  $('#modal-content').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

const guard = (fn) => async (...args) => { try { await fn(...args); } catch (err) { toast(err.message, true); } };
const accountById = (id) => state.accounts.find((a) => a.id === Number(id));
const folderOptions = (accountId, selected) => state.folders.filter((f) => f.account_id === Number(accountId))
  .map((f) => `<option value="${esc(f.path)}"${f.path === selected ? ' selected' : ''}>${esc(f.path)}</option>`).join('');
const accountOptions = (selected) => state.accounts
  .map((a) => `<option value="${a.id}"${Number(selected) === a.id ? ' selected' : ''}>${esc(a.email)}</option>`).join('');

async function loadData() {
  state.accounts = await api('/accounts');
  state.folders = await api('/folders');
  if (!state.account && state.accounts.length) state.account = state.accounts[0].id;
}

/* ---------- routage ---------- */
const routes = {};
function router() {
  const route = (location.hash.replace('#/', '') || 'mail').split('?')[0];
  document.querySelectorAll('.sidebar a').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
  (routes[route] || routes.mail)();
}
window.addEventListener('hashchange', router);

/* ---------- Page Messages ---------- */
routes.mail = guard(async () => {
  await loadData();
  if (!state.accounts.length) {
    view.innerHTML = `<div class="card"><h1>Aucune boîte mail connectée</h1>
      <p class="muted">Commencez par ajouter un compte IMAP/SMTP.</p>
      <button class="primary" onclick="location.hash='#/accounts'">Connecter une boîte mail</button></div>`;
    return;
  }
  view.innerHTML = `<div class="mail">
    <div class="pane" id="folder-pane"></div>
    <div class="pane" id="list-pane"></div>
    <div class="pane" id="read-pane"><div class="reader muted">Sélectionnez un message.</div></div>
  </div>`;
  renderFolders();
  await renderMessages();
});

function renderFolders() {
  const pane = $('#folder-pane');
  if (!pane) return;
  pane.innerHTML = state.accounts.map((acc) => {
    const folders = state.folders.filter((f) => f.account_id === acc.id);
    return `<div class="acc-head"><span class="dot" style="background:${esc(acc.color)}"></span>
        <span style="flex:1">${esc(acc.email)}</span>
        <button class="small" data-sync="${acc.id}" title="Synchroniser">⟳</button></div>
      ${folders.map((f) => `<div class="folder-item${state.account === acc.id && state.folder === f.path ? ' active' : ''}"
        data-acc="${acc.id}" data-folder="${esc(f.path)}">
        <span>${esc(f.path)}</span>
        <span class="muted">${f.unseen ? `<b class="ok">${f.unseen}</b>/` : ''}${f.total || 0}</span></div>`).join('')
      || '<div class="folder-item muted">Aucun dossier — lancez une synchronisation.</div>'}`;
  }).join('');
  pane.querySelectorAll('[data-folder]').forEach((el) => el.addEventListener('click', guard(async () => {
    state.account = Number(el.dataset.acc); state.folder = el.dataset.folder; state.message = null;
    renderFolders(); await renderMessages();
  })));
  pane.querySelectorAll('[data-sync]').forEach((el) => el.addEventListener('click', guard(async (e) => {
    e.stopPropagation();
    await api(`/accounts/${el.dataset.sync}/sync`, { method: 'POST' });
    toast('Synchronisation lancée — suivez-la dans « Traitements ».');
  })));
}

async function renderMessages(query = '') {
  const pane = $('#list-pane');
  if (!pane) return;
  if (!state.folder) { pane.innerHTML = '<div class="reader muted">Choisissez un dossier.</div>'; return; }
  const { messages, total } = await api(`/messages?accountId=${state.account}&folder=${encodeURIComponent(state.folder)}&q=${encodeURIComponent(query)}`);
  pane.innerHTML = `<div class="pane-head row">
      <input id="search" placeholder="Rechercher…" value="${esc(query)}" style="flex:1">
      <button class="small" id="move-selected">Déplacer la sélection</button>
    </div>
    <div class="pane-head muted" style="border:0;position:static">${total} message(s) dans ${esc(state.folder)}</div>
    ${messages.map((m) => `<div class="msg-item${m.seen ? '' : ' unread'}${state.message === m.id ? ' active' : ''}" data-id="${m.id}">
      <div class="row" style="gap:6px"><input type="checkbox" class="pick" data-uid="${m.uid}" onclick="event.stopPropagation()">
        <span class="subject" style="flex:1">${esc(m.subject)}</span>${m.has_attachments ? '📎' : ''}${m.flagged ? '⭐' : ''}</div>
      <div class="meta"><span>${esc(m.from_name || m.from_addr)}</span><span>${fmtDate(m.date)}</span></div>
      <div class="snippet">${esc(m.snippet || '')}</div></div>`).join('') || '<div class="reader muted">Aucun message.</div>'}`;
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') renderMessages(e.target.value); });
  pane.querySelectorAll('.msg-item').forEach((el) => el.addEventListener('click', guard(() => openMessage(Number(el.dataset.id)))));
  $('#move-selected').addEventListener('click', () => {
    const uids = Array.from(pane.querySelectorAll('.pick:checked')).map((c) => Number(c.dataset.uid));
    if (!uids.length) return toast('Sélectionnez au moins un message.', true);
    transferModal({ srcAccountId: state.account, srcPath: state.folder, uids });
  });
}

const openMessage = guard(async (id) => {
  state.message = id;
  const msg = await api(`/messages/${id}`);
  const pane = $('#read-pane');
  pane.innerHTML = `<div class="reader">
    <div class="row" style="justify-content:space-between">
      <h2 style="margin:0">${esc(msg.subject)}</h2>
      <div class="row">
        <button class="small" id="flag">${msg.flagged ? 'Retirer le suivi' : '⭐ Suivre'}</button>
        <button class="small" id="unread">${msg.seen ? 'Marquer non lu' : 'Marquer lu'}</button>
        <button class="small" id="move">Déplacer</button>
        <button class="small primary" id="reply">Répondre</button>
      </div>
    </div>
    <p class="muted">De ${esc(msg.from_name)} &lt;${esc(msg.from_addr)}&gt; · à ${esc(msg.to_addr)}<br>
      ${fmtDate(msg.date)} · ${fmtSize(msg.size)} <span class="tag">UID ${msg.uid}</span></p>
    ${msg.body_html
      ? `<iframe sandbox="allow-same-origin" id="body-frame"></iframe>`
      : `<pre>${esc(msg.body_text || '(message vide)')}</pre>`}</div>`;
  if (msg.body_html) {
    const frame = $('#body-frame');
    frame.srcdoc = `<base target="_blank"><style>body{font-family:sans-serif;padding:8px;color:#111}img{max-width:100%}</style>${msg.body_html}`;
  }
  $('#flag').addEventListener('click', guard(async () => {
    await api(`/messages/${id}/flags`, { method: 'POST', body: msg.flagged ? { remove: ['\\Flagged'] } : { add: ['\\Flagged'] } });
    openMessage(id); renderMessages();
  }));
  $('#unread').addEventListener('click', guard(async () => {
    await api(`/messages/${id}/flags`, { method: 'POST', body: msg.seen ? { remove: ['\\Seen'] } : { add: ['\\Seen'] } });
    openMessage(id); renderMessages();
  }));
  $('#move').addEventListener('click', () => transferModal({ srcAccountId: msg.account_id, srcPath: state.folder, uids: [msg.uid] }));
  $('#reply').addEventListener('click', () => composeModal({
    accountId: msg.account_id, to: msg.from_addr, subject: `Re: ${msg.subject}`,
    inReplyTo: msg.message_id, quote: msg.body_text
  }));
  if (!msg.seen) api(`/messages/${id}/flags`, { method: 'POST', body: { add: ['\\Seen'] } }).then(() => renderMessages()).catch(() => {});
});

function composeModal({ accountId, to = '', subject = '', inReplyTo = null, quote = '' }) {
  modal(`<h2>Nouveau message</h2>
    <div class="field"><label>Compte expéditeur</label><select id="c-acc">${accountOptions(accountId)}</select></div>
    <div class="field"><label>Destinataire</label><input id="c-to" value="${esc(to)}"></div>
    <div class="field"><label>Copie</label><input id="c-cc"></div>
    <div class="field"><label>Objet</label><input id="c-subject" value="${esc(subject)}"></div>
    <div class="field"><label>Message</label><textarea id="c-text" rows="10">${esc(quote ? `\n\n---\n${quote.slice(0, 2000)}` : '')}</textarea></div>
    <div class="row"><button class="primary" id="c-send">Envoyer</button><button onclick="closeModal()">Annuler</button></div>`);
  $('#c-send').addEventListener('click', guard(async () => {
    await api('/send', { method: 'POST', body: {
      accountId: $('#c-acc').value, to: $('#c-to').value, cc: $('#c-cc').value,
      subject: $('#c-subject').value, text: $('#c-text').value, inReplyTo } });
    closeModal(); toast('Message envoyé.');
  }));
}

/* ---------- Transfert (messages ou dossiers) ---------- */
function transferModal({ srcAccountId, srcPath, uids = null, includeChildren = false }) {
  const dstAccount = state.accounts.find((a) => a.id !== Number(srcAccountId))?.id || srcAccountId;
  modal(`<h2>${uids ? `Déplacer ${uids.length} message(s)` : `Déplacer le dossier ${esc(srcPath)}`}</h2>
    <p class="muted">Chaque message est d'abord copié à destination, vérifié, puis seulement supprimé de la source. En cas de doute, rien n'est supprimé.</p>
    <div class="field"><label>Boîte source</label><select id="t-src-acc" disabled>${accountOptions(srcAccountId)}</select></div>
    <div class="field"><label>Dossier source</label><select id="t-src">${folderOptions(srcAccountId, srcPath)}</select></div>
    <div class="field"><label>Boîte de destination</label><select id="t-dst-acc">${accountOptions(dstAccount)}</select></div>
    <div class="field"><label>Dossier de destination (existant ou nouveau)</label>
      <input id="t-dst" list="dstlist" placeholder="Ex. Archives/2024"><datalist id="dstlist"></datalist></div>
    <div class="field"><label>Mode</label><select id="t-mode">
      <option value="move">Déplacer (copie vérifiée puis suppression de la source)</option>
      <option value="copy">Copier uniquement (rien n'est supprimé)</option></select></div>
    ${uids ? '' : `<div class="row"><label><input type="checkbox" id="t-children"${includeChildren ? ' checked' : ''}> inclure les sous-dossiers</label>
      <label><input type="checkbox" id="t-delsrc"> supprimer le dossier source une fois vidé</label></div>`}
    <div class="row" style="margin-top:12px"><button class="primary" id="t-go">Lancer le traitement</button><button onclick="closeModal()">Annuler</button></div>`);
  const refreshDst = () => { $('#dstlist').innerHTML = folderOptions($('#t-dst-acc').value); };
  $('#t-dst-acc').addEventListener('change', refreshDst);
  refreshDst();
  $('#t-go').addEventListener('click', guard(async () => {
    const job = await api('/transfer', { method: 'POST', body: {
      srcAccountId: Number(srcAccountId), srcPath: $('#t-src').value,
      dstAccountId: Number($('#t-dst-acc').value), dstPath: $('#t-dst').value.trim(),
      mode: $('#t-mode').value, uids,
      includeChildren: $('#t-children')?.checked || false,
      deleteSourceFolder: $('#t-delsrc')?.checked || false } });
    closeModal();
    toast(`Traitement #${job.id} lancé.`);
    location.hash = '#/jobs';
  }));
}

/* ---------- Page Dossiers ---------- */
routes.folders = guard(async () => {
  await loadData();
  view.innerHTML = `<div class="page-head"><div><h1>Dossiers</h1>
      <p class="muted">Créez, renommez, supprimez des dossiers et déplacez-les d'une boîte à l'autre.</p></div>
    <button class="primary" id="new-folder">+ Nouveau dossier</button></div>
    ${state.accounts.map((acc) => `<div class="card" style="margin-bottom:14px">
      <h2><span class="dot" style="background:${esc(acc.color)}"></span> ${esc(acc.email)}</h2>
      <table><thead><tr><th>Dossier</th><th class="col-fit">Messages</th><th class="col-fit">Non lus</th><th class="col-fit">Dernière synchro</th><th class="col-fit"></th></tr></thead><tbody>
      ${state.folders.filter((f) => f.account_id === acc.id).map((f) => `<tr>
        <td>${esc(f.path)}</td><td class="col-fit">${f.total || 0}</td><td class="col-fit">${f.unseen || 0}</td><td class="muted col-fit">${fmtDate(f.synced_at)}</td>
        <td class="row col-fit" style="justify-content:flex-end">
          <button class="small" data-move="${acc.id}|${esc(f.path)}">Déplacer</button>
          <button class="small" data-rename="${acc.id}|${esc(f.path)}">Renommer</button>
          <button class="small danger" data-del="${acc.id}|${esc(f.path)}">Supprimer</button></td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">Aucun dossier synchronisé.</td></tr>'}
      </tbody></table></div>`).join('') || '<div class="card muted">Connectez d\'abord une boîte mail.</div>'}`;

  $('#new-folder')?.addEventListener('click', () => {
    modal(`<h2>Nouveau dossier</h2>
      <div class="field"><label>Boîte mail</label><select id="f-acc">${accountOptions(state.account)}</select></div>
      <div class="field"><label>Chemin complet (ex. Archives/2024)</label><input id="f-path"></div>
      <div class="row"><button class="primary" id="f-go">Créer</button><button onclick="closeModal()">Annuler</button></div>`);
    $('#f-go').addEventListener('click', guard(async () => {
      await api('/folders', { method: 'POST', body: { accountId: Number($('#f-acc').value), path: $('#f-path').value.trim() } });
      closeModal(); toast('Dossier créé.'); routes.folders();
    }));
  });
  view.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => {
    const [acc, p] = b.dataset.move.split('|');
    transferModal({ srcAccountId: Number(acc), srcPath: p, uids: null, includeChildren: true });
  }));
  view.querySelectorAll('[data-rename]').forEach((b) => b.addEventListener('click', guard(async () => {
    const [acc, p] = b.dataset.rename.split('|');
    const newPath = prompt('Nouveau chemin du dossier :', p);
    if (!newPath || newPath === p) return;
    await api('/folders', { method: 'PATCH', body: { accountId: Number(acc), path: p, newPath } });
    toast('Dossier renommé.'); routes.folders();
  })));
  view.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', guard(async () => {
    const [acc, p] = b.dataset.del.split('|');
    if (!confirm(`Supprimer définitivement le dossier « ${p} » ?`)) return;
    try {
      await api('/folders', { method: 'DELETE', body: { accountId: Number(acc), path: p } });
    } catch (err) {
      if (!confirm(`${err.message}\n\nSupprimer quand même (les messages seront perdus) ?`)) return;
      await api('/folders', { method: 'DELETE', body: { accountId: Number(acc), path: p, force: true } });
    }
    toast('Dossier supprimé.'); routes.folders();
  })));
});

/* ---------- Page Traitements ---------- */
const JOB_LABEL = { en_attente: 'en attente', en_cours: 'en cours', termine: 'terminé', echec: 'échec', annule: 'annulé', termine_avec_erreurs: 'terminé avec erreurs' };

routes.jobs = guard(async () => {
  state.jobs = await api('/jobs');
  view.innerHTML = `<div class="page-head"><div><h1>Traitements en cours</h1>
    <p class="muted">Synchronisations, déplacements, sauvegardes et rangements — avec journal détaillé.</p></div>
    <button id="refresh-jobs">Actualiser</button></div>
    <div class="card"><table><thead><tr><th class="col-fit">#</th><th>Traitement</th><th>Étape</th><th>Avancement</th><th class="col-fit">État</th><th class="col-fit"></th></tr></thead>
    <tbody id="jobs-body">${state.jobs.map(jobRow).join('') || '<tr><td colspan="6" class="muted">Aucun traitement pour le moment.</td></tr>'}</tbody></table></div>
    <div id="job-detail"></div>`;
  $('#refresh-jobs').addEventListener('click', routes.jobs);
  bindJobRows();
});

function jobRow(job) {
  const pct = job.total ? Math.round((job.done / job.total) * 100) : (job.status === 'termine' ? 100 : 0);
  return `<tr data-job="${job.id}"><td class="col-fit">${job.id}</td><td>${esc(job.label)}</td>
    <td class="muted">${esc(job.phase || '—')}</td>
    <td><div class="bar"><div style="width:${pct}%"></div></div><span class="muted">${job.done}/${job.total || '?'}${job.failed ? ` · <span class="error">${job.failed} échec(s)</span>` : ''}</span></td>
    <td class="col-fit"><span class="status ${job.status}">${JOB_LABEL[job.status] || job.status}</span></td>
    <td class="row col-fit" style="justify-content:flex-end"><button class="small" data-detail="${job.id}">Détail</button>
      ${['en_cours', 'en_attente'].includes(job.status) ? `<button class="small danger" data-cancel="${job.id}">Arrêter</button>` : ''}</td></tr>`;
}

function bindJobRows() {
  view.querySelectorAll('[data-detail]').forEach((b) => b.addEventListener('click', guard(async () => {
    const job = await api(`/jobs/${b.dataset.detail}`);
    $('#job-detail').innerHTML = `<div class="card" style="margin-top:14px"><h2>Traitement #${job.id} — ${esc(job.label)}</h2>
      ${job.error ? `<p class="error">${esc(job.error)}</p>` : ''}
      <h2 style="margin-top:12px">Journal</h2>
      <pre class="muted" style="max-height:220px;overflow:auto">${job.logs.map((l) => `[${l.created_at}] ${l.level === 'error' ? '❌' : l.level === 'warn' ? '⚠️' : '•'} ${esc(l.message)}`).join('\n') || 'Aucun message.'}</pre>
      <h2 style="margin-top:12px">Éléments (${job.items.length})</h2>
      <table><thead><tr><th>Élément</th><th class="col-fit">UID source</th><th class="col-fit">UID destination</th><th class="col-fit">État</th><th>Détail</th></tr></thead><tbody>
      ${job.items.slice(-200).map((i) => `<tr><td>${esc(i.ref)}</td><td class="col-fit">${i.src_uid ?? '—'}</td><td class="col-fit">${i.dst_uid ?? '—'}</td>
        <td class="col-fit"><span class="status ${i.status === 'echec' ? 'echec' : 'termine'}">${esc(i.status)}</span></td>
        <td class="muted">${esc(i.detail || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Aucun élément.</td></tr>'}
      </tbody></table></div>`;
  })));
  view.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', guard(async () => {
    await api(`/jobs/${b.dataset.cancel}/cancel`, { method: 'POST' });
    toast('Arrêt demandé — le traitement s\'interrompt proprement.');
  })));
}

/* ---------- Page Assistant (Ollama) ---------- */
routes.chat = guard(async () => {
  await loadData();
  state.chat = await api('/chat/history');
  view.innerHTML = `<div class="chat">
    <div class="page-head"><div><h1>Assistant de rangement</h1>
      <p class="muted">Tapez « @ » pour cibler un dossier, Entrée valide la première suggestion. Aucun changement n'est appliqué sans votre accord.</p></div>
      <div class="row"><select id="chat-acc">${accountOptions(state.account)}</select><button id="chat-clear">Effacer</button></div></div>
    <div class="chat-log" id="chat-log">${state.chat.map((m) => bubble(m.role, m.content)).join('')}</div>
    <div class="chat-input">
      <div class="autocomplete hidden" id="ac"></div>
      <textarea id="chat-text" placeholder="Ex. : est-ce que tu peux ranger le dossier @INBOX ?"></textarea>
      <div class="row" style="margin-top:8px"><button class="primary" id="chat-send">Envoyer</button>
        <span class="muted" id="chat-hint"></span></div>
    </div>
    <div id="plan-zone"></div></div>`;
  $('#chat-acc').addEventListener('change', (e) => { state.account = Number(e.target.value); });
  $('#chat-clear').addEventListener('click', guard(async () => { await api('/chat/history', { method: 'DELETE' }); routes.chat(); }));
  $('#chat-send').addEventListener('click', sendChat);
  setupAutocomplete();
  $('#chat-log').scrollTop = 1e6;
});

const bubble = (role, content) => `<div class="bubble ${role === 'user' ? 'user' : 'assistant'}">${esc(content)}</div>`;

function setupAutocomplete() {
  const ta = $('#chat-text');
  const ac = $('#ac');
  let items = [];
  let sel = 0;
  const close = () => { ac.classList.add('hidden'); items = []; };
  const currentToken = () => {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = upto.match(/@([^\s@]*)$/);
    return m ? m[1] : null;
  };
  const refresh = () => {
    const token = currentToken();
    if (token === null) return close();
    items = state.folders.filter((f) => f.account_id === Number($('#chat-acc').value))
      .filter((f) => f.path.toLowerCase().includes(token.toLowerCase())).slice(0, 8);
    if (!items.length) return close();
    sel = 0;
    ac.innerHTML = items.map((f, i) => `<div class="${i === sel ? 'sel' : ''}" data-i="${i}">${esc(f.path)} <span class="muted">(${f.total || 0})</span></div>`).join('');
    ac.classList.remove('hidden');
    ac.querySelectorAll('div[data-i]').forEach((d) => d.addEventListener('mousedown', (e) => { e.preventDefault(); pick(Number(d.dataset.i)); }));
  };
  const pick = (i) => {
    const folder = items[i];
    if (!folder) return;
    const upto = ta.value.slice(0, ta.selectionStart).replace(/@([^\s@]*)$/, `@${folder.path} `);
    ta.value = upto + ta.value.slice(ta.selectionStart);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = upto.length;
    close();
  };
  ta.addEventListener('input', refresh);
  ta.addEventListener('keydown', (e) => {
    if (!ac.classList.contains('hidden') && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        ac.querySelectorAll('div[data-i]').forEach((d, i) => d.classList.toggle('sel', i === sel));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pick(sel); }
      if (e.key === 'Escape') return close();
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
}

const sendChat = guard(async () => {
  const ta = $('#chat-text');
  const message = ta.value.trim();
  if (!message) return;
  const accountId = Number($('#chat-acc').value);
  const mention = message.match(/@([^\s]+)/);
  const folderPath = mention ? mention[1] : null;
  $('#chat-log').insertAdjacentHTML('beforeend', bubble('user', message));
  ta.value = '';
  $('#chat-hint').textContent = 'L\'assistant réfléchit…';
  $('#chat-log').scrollTop = 1e6;
  try {
    const res = await api('/chat', { method: 'POST', body: { message, accountId, folderPath } });
    $('#chat-log').insertAdjacentHTML('beforeend', bubble('assistant', res.reponse));
    $('#chat-log').scrollTop = 1e6;
    renderPlan(res.plan, res.preview);
  } finally {
    $('#chat-hint').textContent = '';
  }
});

function renderPlan(plan, preview) {
  const zone = $('#plan-zone');
  if (!plan) { zone.innerHTML = ''; return; }
  state.plan = plan;
  zone.innerHTML = `<div class="card plan" style="margin-top:12px">
    <h2>Proposition : ${esc(plan.titre || 'rangement')}</h2>
    ${(preview || plan.actions).map((a) => `<div class="plan-action">
      <b>${a.type === 'create_folder' ? 'Créer le dossier' : 'Déplacer des messages'}</b> —
      ${a.type === 'create_folder' ? esc(a.path) : `${esc(a.from)} → ${esc(a.to)} <span class="tag">${a.count ?? '?'} message(s)</span>`}
      <div class="muted">${esc(a.raison || '')}</div></div>`).join('')}
    <div class="row" style="margin-top:12px"><button class="primary" id="plan-accept">J'accepte, applique le rangement</button>
      <button id="plan-reject">Refuser</button></div></div>`;
  $('#plan-accept').addEventListener('click', guard(async () => {
    const job = await api('/chat/plan/execute', { method: 'POST', body: { plan } });
    zone.innerHTML = `<div class="card ok" style="margin-top:12px">Rangement lancé (traitement #${job.id}).</div>`;
    toast('Rangement lancé.');
  }));
  $('#plan-reject').addEventListener('click', () => { zone.innerHTML = ''; state.plan = null; });
}

/* ---------- Page Sauvegardes ---------- */
routes.backups = guard(async () => {
  await loadData();
  const backups = await api('/backups');
  view.innerHTML = `<div class="page-head"><div><h1>Sauvegardes et restauration</h1>
      <p class="muted">Chaque sauvegarde contient les messages bruts (.eml). Une restauration réinjecte les messages manquants sans créer de doublon.</p></div>
    <button class="primary" id="new-backup">+ Nouvelle sauvegarde</button></div>
    <div class="card"><table><thead><tr><th class="col-fit">#</th><th>Boîte</th><th>Périmètre</th><th class="col-fit">Messages</th><th class="col-fit">Taille</th><th class="col-fit">Date</th><th class="col-fit">État</th><th class="col-fit"></th></tr></thead><tbody>
    ${backups.map((b) => `<tr><td class="col-fit">${b.id}</td><td>${esc(b.account_label)}</td><td>${esc(b.scope)}</td>
      <td class="col-fit">${b.message_count}</td><td class="col-fit">${fmtSize(b.bytes)}</td><td class="muted col-fit">${fmtDate(b.created_at)}</td>
      <td class="col-fit"><span class="status ${esc(b.status)}">${esc(b.status)}</span></td>
      <td class="row col-fit" style="justify-content:flex-end">
        <button class="small primary" data-restore="${b.id}">Restaurer</button>
        <button class="small danger" data-delbk="${b.id}">Supprimer</button></td></tr>`).join('')
    || '<tr><td colspan="8" class="muted">Aucune sauvegarde.</td></tr>'}</tbody></table></div>`;

  $('#new-backup').addEventListener('click', () => {
    modal(`<h2>Nouvelle sauvegarde</h2>
      <div class="field"><label>Boîte mail</label><select id="b-acc">${accountOptions(state.account)}</select></div>
      <div class="field"><label>Périmètre</label><select id="b-folder"><option value="">Compte complet</option>${folderOptions(state.account)}</select></div>
      <div class="field"><label>Libellé</label><input id="b-label" placeholder="Ex. avant grand rangement"></div>
      <div class="row"><button class="primary" id="b-go">Lancer la sauvegarde</button><button onclick="closeModal()">Annuler</button></div>`);
    $('#b-acc').addEventListener('change', (e) => { $('#b-folder').innerHTML = `<option value="">Compte complet</option>${folderOptions(e.target.value)}`; });
    $('#b-go').addEventListener('click', guard(async () => {
      const job = await api('/backups', { method: 'POST', body: { accountId: Number($('#b-acc').value), folderPath: $('#b-folder').value || null, label: $('#b-label').value } });
      closeModal(); toast(`Sauvegarde lancée (traitement #${job.id}).`); location.hash = '#/jobs';
    }));
  });

  view.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.restore;
    modal(`<h2>Restaurer la sauvegarde #${id}</h2>
      <p class="muted">Les messages déjà présents ne sont pas dupliqués. Rien n'est supprimé sur la boîte de destination.</p>
      <div class="field"><label>Boîte de destination</label><select id="r-acc">${accountOptions(state.account)}</select></div>
      <div class="field"><label>Mode</label><select id="r-mode">
        <option value="original">Remettre dans les dossiers d'origine (rollback)</option>
        <option value="new_folder">Isoler dans un nouveau dossier « Restauration-… »</option></select></div>
      <div class="row"><button class="primary" id="r-go">Restaurer</button><button onclick="closeModal()">Annuler</button></div>`);
    $('#r-go').addEventListener('click', guard(async () => {
      const job = await api(`/backups/${id}/restore`, { method: 'POST', body: { targetAccountId: Number($('#r-acc').value), mode: $('#r-mode').value } });
      closeModal(); toast(`Restauration lancée (traitement #${job.id}).`); location.hash = '#/jobs';
    }));
  }));
  view.querySelectorAll('[data-delbk]').forEach((b) => b.addEventListener('click', guard(async () => {
    if (!confirm('Supprimer définitivement cette sauvegarde ?')) return;
    await api(`/backups/${b.dataset.delbk}`, { method: 'DELETE' });
    toast('Sauvegarde supprimée.'); routes.backups();
  })));
});

/* ---------- Page Comptes ---------- */
routes.accounts = guard(async () => {
  await loadData();
  view.innerHTML = `<div class="page-head"><div><h1>Boîtes mail connectées</h1>
      <p class="muted">Les mots de passe sont chiffrés (AES-256-GCM) avant d'être enregistrés.</p></div>
    <div class="row"><button class="small" id="sync-all">⟳ Resynchroniser tout</button>
    <button class="primary" id="add-acc">+ Connecter une boîte</button></div></div>
    <div class="grid cols-2">${state.accounts.map((a) => `<div class="card">
      <div class="row" style="justify-content:space-between">
        <h2><span class="dot" style="background:${esc(a.color)}"></span> ${esc(a.name)}</h2>
        <span class="status ${a.status === 'connecté' ? 'termine' : 'echec'}">${esc(a.status)}</span></div>
      <p class="muted">${esc(a.email)}<br>IMAP ${esc(a.imap_host)}:${a.imap_port}${a.imap_secure ? ' (TLS)' : ''}<br>
        SMTP ${esc(a.smtp_host || '—')}:${a.smtp_port || ''}${a.smtp_secure ? ' (TLS)' : ''}</p>
      <p class="muted">${a.folders || 0} dossier(s) · ${a.total || 0} message(s) · dernière synchro ${fmtDate(a.last_sync_at)}</p>
      ${a.last_error ? `<p class="error">${esc(a.last_error)}</p>` : ''}
      <div class="row"><button class="small" data-test="${a.id}">Tester</button>
        <button class="small" data-sync2="${a.id}">Synchroniser</button>
        <button class="small" data-edit="${a.id}">Modifier</button>
        <button class="small danger" data-delacc="${a.id}">Retirer</button></div></div>`).join('')
    || '<div class="card muted">Aucune boîte connectée pour le moment.</div>'}</div>`;

  $('#add-acc').addEventListener('click', () => accountModal(null));
  $('#sync-all').addEventListener('click', guard(async () => {
    await api('/accounts/sync-all', { method: 'POST' });
    toast('Synchronisation de toutes les boîtes lancée.'); location.hash = '#/jobs';
  }));
  view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => accountModal(accountById(b.dataset.edit))));
  view.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', guard(async () => {
    b.textContent = 'Test…';
    const r = await api(`/accounts/${b.dataset.test}/test`, { method: 'POST' });
    b.textContent = 'Tester';
    modal(`<h2>Test de connexion</h2><p>IMAP : ${esc(r.imap)}</p><p>SMTP : ${esc(r.smtp)}</p>
      <button class="primary" onclick="closeModal()">Fermer</button>`);
  })));
  view.querySelectorAll('[data-sync2]').forEach((b) => b.addEventListener('click', guard(async () => {
    await api(`/accounts/${b.dataset.sync2}/sync`, { method: 'POST' });
    toast('Synchronisation lancée.'); location.hash = '#/jobs';
  })));
  view.querySelectorAll('[data-delacc]').forEach((b) => b.addEventListener('click', guard(async () => {
    if (!confirm('Retirer cette boîte de MailZen ? (aucun mail n\'est supprimé sur le serveur)')) return;
    await api(`/accounts/${b.dataset.delacc}`, { method: 'DELETE' });
    toast('Boîte retirée.'); routes.accounts();
  })));
});

function accountModal(acc) {
  const v = (k, d = '') => esc(acc?.[k] ?? d);
  modal(`<h2>${acc ? 'Modifier la boîte' : 'Connecter une boîte mail'}</h2>
    <div class="field"><label>Adresse e-mail</label><input id="a-email" value="${v('email')}"></div>
    <div class="field"><label>Mot de passe${acc ? ' (laisser vide pour conserver)' : ''}</label><input id="a-ipw" type="password"></div>
    <div class="grid cols-2">
      <div class="field"><label>Serveur IMAP</label><input id="a-ih" value="${v('imap_host')}" placeholder="imap.exemple.com"></div>
      <div class="field"><label>Serveur SMTP</label><input id="a-sh" value="${v('smtp_host')}" placeholder="smtp.exemple.com"></div>
    </div>
    <div class="row" style="margin:4px 0 12px">
      <button type="button" class="small" id="a-detect">🔍 Détecter et vérifier automatiquement</button>
      <span id="a-detect-status" class="muted"></span>
    </div>
    <details id="a-advanced">
      <summary class="muted">Options avancées</summary>
      <div class="grid cols-2" style="margin-top:8px">
        <div class="field"><label>Nom affiché</label><input id="a-name" value="${v('name')}"></div>
        <div class="field"><label>Couleur</label><input id="a-color" type="color" value="${v('color', '#6c8cff')}"></div>
        <div class="field"><label>Port IMAP</label><input id="a-ip" type="number" value="${v('imap_port', 993)}"></div>
        <div class="field"><label>Port SMTP</label><input id="a-sp" type="number" value="${v('smtp_port', 587)}"></div>
        <div class="field"><label>Identifiant IMAP</label><input id="a-iu" value="${v('imap_user')}"></div>
        <div class="field"><label>Identifiant SMTP</label><input id="a-su" value="${v('smtp_user')}"></div>
      </div>
      <div class="row">
        <label><input type="checkbox" id="a-is" ${acc ? (acc.imap_secure ? 'checked' : '') : 'checked'}> IMAP en TLS (993)</label>
        <label><input type="checkbox" id="a-ss" ${acc?.smtp_secure ? 'checked' : ''}> SMTP en TLS direct (465)</label>
        <label><input type="checkbox" id="a-cert" ${acc?.allow_invalid_cert ? 'checked' : ''}> accepter un certificat auto-signé</label>
      </div>
    </details>
    <div class="row" style="margin-top:12px"><button class="primary" id="a-go">${acc ? 'Enregistrer' : 'Connecter et synchroniser'}</button>
      <button onclick="closeModal()">Annuler</button></div>`);
  $('#a-email').addEventListener('blur', () => { if (!$('#a-iu').value) $('#a-iu').value = $('#a-email').value; });
  $('#a-detect').addEventListener('click', guard(async () => {
    const email = $('#a-email').value.trim();
    const pass = $('#a-ipw').value;
    const status = $('#a-detect-status');
    if (!email) return toast('Renseignez d\'abord l\'adresse e-mail.', true);
    if (!pass) return toast('Renseignez le mot de passe IMAP pour vérifier la connexion.', true);
    const btn = $('#a-detect');
    btn.disabled = true; status.textContent = 'Détection en cours…';
    try {
      const r = await api('/accounts/detect', { method: 'POST', body: {
        email, imap_pass: pass, imap_user: $('#a-iu').value || email,
        smtp_pass: pass, smtp_user: $('#a-su').value || email
      } });
      if (r.found) {
        $('#a-ih').value = r.imap_host; $('#a-ip').value = r.imap_port; $('#a-is').checked = r.imap_secure;
        $('#a-sh').value = r.smtp_host; $('#a-sp').value = r.smtp_port; $('#a-ss').checked = r.smtp_secure;
        if (!$('#a-iu').value) $('#a-iu').value = email;
        if (!$('#a-su').value) $('#a-su').value = email;
        status.textContent = r.smtp_ok === false ? `IMAP vérifié, SMTP en échec (${r.smtp_error})` : 'Connexion vérifiée avec succès.';
        toast(r.smtp_ok === false ? `Paramètres IMAP détectés, mais le test SMTP a échoué : ${r.smtp_error}` : 'Paramètres détectés et connexion vérifiée !', r.smtp_ok === false);
      } else {
        status.textContent = 'Détection impossible, saisie manuelle requise.';
        toast('Détection automatique impossible pour ce fournisseur. Merci de saisir les paramètres manuellement.', true);
      }
    } catch (err) {
      status.textContent = '';
      toast(`Détection impossible : ${err.message}`, true);
    } finally {
      btn.disabled = false;
    }
  }));
  $('#a-go').addEventListener('click', guard(async () => {
    const body = {
      name: $('#a-name').value || $('#a-email').value, email: $('#a-email').value, color: $('#a-color').value,
      imap_host: $('#a-ih').value, imap_port: Number($('#a-ip').value), imap_secure: $('#a-is').checked,
      imap_user: $('#a-iu').value || $('#a-email').value, imap_pass: $('#a-ipw').value,
      smtp_host: $('#a-sh').value, smtp_port: Number($('#a-sp').value), smtp_secure: $('#a-ss').checked,
      smtp_user: $('#a-su').value, smtp_pass: $('#a-ipw').value, allow_invalid_cert: $('#a-cert').checked
    };
    const res = acc ? await api(`/accounts/${acc.id}`, { method: 'PUT', body }) : await api('/accounts', { method: 'POST', body });
    closeModal();
    toast(res.warning || 'Boîte enregistrée.', !!res.warning);
    routes.accounts();
  }));
}

/* ---------- Temps réel + démarrage ---------- */
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('job', (e) => {
    const job = JSON.parse(e.data);
    const active = ['en_cours', 'en_attente'].includes(job.status);
    const badge = $('#jobs-badge');
    state.jobs = [job, ...state.jobs.filter((j) => j.id !== job.id)];
    const running = state.jobs.filter((j) => ['en_cours', 'en_attente'].includes(j.status)).length;
    badge.textContent = running;
    badge.classList.toggle('hidden', running === 0);
    if (location.hash.startsWith('#/jobs')) {
      const row = document.querySelector(`tr[data-job="${job.id}"]`);
      if (row) row.outerHTML = jobRow(job); else $('#jobs-body')?.insertAdjacentHTML('afterbegin', jobRow(job));
      bindJobRows();
    }
    if (!active && job.status === 'termine' && location.hash.startsWith('#/mail')) loadData().then(renderFolders);
  });
  es.onerror = () => {};
}

async function refreshOllama() {
  try {
    const s = await api('/ollama');
    $('#ollama-status').innerHTML = s.online
      ? `<span class="ok">● Ollama connecté</span><br>${esc(s.model)}${s.modelInstalled ? '' : ' <span class="warn">(modèle absent)</span>'}`
      : `<span class="error">● Ollama injoignable</span><br>${esc(s.url)}`;
  } catch { /* non authentifié */ }
}

function showLogin() {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
}

async function start() {
  const session = await fetch('/api/session').then((r) => r.json());
  if (session.required && !session.authenticated) return showLogin();
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await refreshOllama();
  connectEvents();
  router();
  const jobs = await api('/jobs').catch(() => []);
  state.jobs = jobs;
  const running = jobs.filter((j) => ['en_cours', 'en_attente'].includes(j.status)).length;
  if (running) { $('#jobs-badge').textContent = running; $('#jobs-badge').classList.remove('hidden'); }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('#login-password').value })
  });
  if (res.ok) { $('#login-error').textContent = ''; start(); }
  else $('#login-error').textContent = 'Mot de passe incorrect.';
});

window.closeModal = closeModal;
start();
