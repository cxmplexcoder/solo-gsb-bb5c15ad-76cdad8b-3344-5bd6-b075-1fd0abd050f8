'use strict';

/* 全局状态：最近一次从服务器获取的全量数据（含重放结果） */
let state = null;
let editingCue = null; // 正在编辑的提示号，null 表示新增模式
let previewToken = 0;  // 表单一旦改动即递增，用于丢弃过期的预览响应

/* ---------- 工具 ---------- */

const $ = (sel) => document.querySelector(sel);

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    toast(data.error || '操作失败');
    throw new Error(data.error || '操作失败');
  }
  if (method !== 'GET') clearPreview(); // 现行序列已变化，旧预览失效
  state = data; // 所有变更接口都返回最新全量状态
  render();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function locationOptions(selected) {
  return state.locations
    .map((l) => {
      const label = l.unlimited ? `${l.name}（不限）` : `${l.name}（限一件）`;
      return `<option value="${esc(l.name)}" ${l.name === selected ? 'selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
}

function propOptions(selected) {
  return state.props
    .map((p) => `<option value="${esc(p.name)}" ${p.name === selected ? 'selected' : ''}>${esc(p.name)}</option>`)
    .join('');
}

/* ---------- 渲染 ---------- */

function renderLocations() {
  const ul = $('#location-list');
  ul.innerHTML = state.locations
    .map((l) => `
      <li class="${l.unlimited ? 'backstage' : ''}">
        <strong>${esc(l.name)}</strong>
        <span class="cap">${l.unlimited ? '容量不限' : '限一件'}</span>
        ${l.unlimited ? '' : `<button class="link" data-del-loc="${esc(l.name)}" title="删除区位">✕</button>`}
      </li>`)
    .join('');
  $('#prop-location').innerHTML = locationOptions();
}

function renderProps() {
  const tbody = $('#prop-rows');
  tbody.innerHTML = state.props
    .map((p) => `
      <tr>
        <td>${esc(p.name)}</td>
        <td><select data-prop-loc="${esc(p.name)}">${locationOptions(p.location)}</select></td>
        <td><button class="link" data-del-prop="${esc(p.name)}">删除</button></td>
      </tr>`)
    .join('');
}

function renderCueForm() {
  $('#cue-number').disabled = editingCue !== null;
  $('#cue-submit').textContent = editingCue !== null ? `保存修改（提示号 ${editingCue}）` : '保存提示';
  $('#cue-cancel').classList.toggle('hidden', editingCue === null);
}

/* ---------- 试排预览（不写库） ---------- */

function clearPreview() {
  previewToken += 1; // 使尚未返回的预览响应失效
  const box = $('#cue-preview');
  box.classList.add('hidden');
  box.innerHTML = '';
}

function collectCueForm() {
  return {
    number: editingCue !== null ? editingCue : Number($('#cue-number').value),
    note: $('#cue-note').value.trim(),
    transfers: [...$('#transfer-rows').querySelectorAll('tr')].map((tr) => ({
      prop: tr.querySelector('.t-prop').value,
      from: tr.querySelector('.t-from').value,
      to: tr.querySelector('.t-to').value,
    })),
  };
}

function previewStatus(s) {
  if (!s) return '<span class="badge none">（此前不存在）</span>';
  const badge = s.ok
    ? '<span class="badge ok">✓ 整组生效</span>'
    : '<span class="badge fail">✗ 整组未生效</span>';
  const errs = s.ok || !s.errors.length
    ? ''
    : `<ul class="cue-errors">${s.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
  return badge + errs;
}

function renderPreview(data) {
  const box = $('#cue-preview');
  const cueRows = data.cueChanges.length
    ? data.cueChanges
        .map((c) => `
          <div class="preview-cue">
            <div class="cue-head">
              <span class="num">提示 ${c.number}${c.isDraft ? '（本次草稿）' : ''}</span>
              <span class="note">${esc(c.note || '')}</span>
            </div>
            <div class="preview-diff">
              <div class="preview-col"><div class="preview-label">现行序列</div>${previewStatus(c.before)}</div>
              <div class="preview-arrow">→</div>
              <div class="preview-col"><div class="preview-label">试排后</div>${previewStatus(c.after)}</div>
            </div>
          </div>`)
        .join('')
    : '<p class="hint">没有提示的生效状态发生变化。</p>';
  const propRows = data.propChanges.length
    ? data.propChanges
        .map((p) => `<div>「${esc(p.prop)}」 ${esc(p.before)} <span class="arrow">→</span> ${esc(p.after)}</div>`)
        .join('')
    : '<p class="hint">没有道具的最终区位发生变化。</p>';
  box.innerHTML = `
    <div class="preview-head">试排预览（仅内存重放，不写库）—— 草稿：提示 ${data.draft.number}</div>
    <h3>生效状态变化的提示</h3>
    ${cueRows}
    <h3>最终区位变化的道具</h3>
    <div class="preview-props">${propRows}</div>`;
  box.classList.remove('hidden');
}

function addTransferRow(t) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><select class="t-prop">${propOptions(t && t.prop)}</select></td>
    <td><select class="t-from">${locationOptions(t && t.from)}</select></td>
    <td><select class="t-to">${locationOptions(t && t.to)}</select></td>
    <td><button type="button" class="link t-remove">移除</button></td>`;
  tr.querySelector('.t-remove').onclick = () => {
    tr.remove();
    if (!$('#transfer-rows').children.length) addTransferRow();
    clearPreview();
  };
  $('#transfer-rows').appendChild(tr);
}

function resetCueForm() {
  editingCue = null;
  $('#cue-number').value = '';
  $('#cue-note').value = '';
  $('#transfer-rows').innerHTML = '';
  addTransferRow();
  renderCueForm();
  clearPreview();
}

function renderCues() {
  const box = $('#cue-list');
  if (!state.cues.length) {
    box.innerHTML = '<p class="hint">还没有提示，请在上方录入。</p>';
    return;
  }
  const resultByNumber = new Map(state.replay.results.map((r) => [r.number, r]));
  box.innerHTML = state.cues
    .map((c) => {
      const r = resultByNumber.get(c.number);
      const badge = r && r.ok
        ? '<span class="badge ok">✓ 已生效</span>'
        : '<span class="badge fail">✗ 整组未生效</span>';
      const transfers = c.transfers
        .map((t) => `<div>「${esc(t.prop)}」 ${esc(t.from)} <span class="arrow">→</span> ${esc(t.to)}</div>`)
        .join('');
      const errors = r && !r.ok
        ? `<ul class="cue-errors">${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
        : '';
      return `
        <div class="cue-item ${r && r.ok ? 'ok' : 'fail'}">
          <div class="cue-head">
            <span class="num">提示 ${c.number}</span>
            <span class="note">${esc(c.note || '')}</span>
            ${badge}
          </div>
          <div class="cue-transfers">${transfers}</div>
          ${errors}
          <div class="cue-actions">
            <button class="small ghost" data-edit-cue="${c.number}">编辑</button>
            <button class="small danger" data-del-cue="${c.number}">删除</button>
          </div>
        </div>`;
    })
    .join('');
}

function renderReplay() {
  const box = $('#replay-results');
  if (!state.replay.results.length) {
    box.innerHTML = '<p class="hint">暂无提示可重放。</p>';
  } else {
    box.innerHTML = state.replay.results
      .map((r) => `
        <div class="cue-item ${r.ok ? 'ok' : 'fail'}">
          <div class="cue-head">
            <span class="num">提示 ${r.number}</span>
            <span class="note">${esc(r.note || '')}</span>
            ${r.ok ? '<span class="badge ok">✓ 整组生效</span>' : '<span class="badge fail">✗ 整组未生效</span>'}
          </div>
          ${r.ok ? '' : `<ul class="cue-errors">${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`}
        </div>`)
      .join('');
  }

  $('#final-board').innerHTML = Object.entries(state.replay.finalLocations)
    .map(([loc, props]) => `
      <div class="loc ${loc === '后台' ? 'backstage' : ''}">
        <div class="loc-name">${esc(loc)}</div>
        ${props.length ? props.map((p) => `<span class="chip">${esc(p)}</span>`).join('') : '<span class="empty">（空）</span>'}
      </div>`)
    .join('');
}

function render() {
  renderLocations();
  renderProps();
  renderCueForm();
  renderCues();
  renderReplay();
}

/* ---------- 事件 ---------- */

$('#location-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#location-name').value.trim();
  if (!name) return;
  api('/api/locations', 'POST', { name }).then(() => { $('#location-name').value = ''; }).catch(() => {});
});

$('#location-list').addEventListener('click', (e) => {
  const name = e.target.dataset.delLoc;
  if (!name) return;
  if (confirm(`删除区位「${name}」？`)) api(`/api/locations/${encodeURIComponent(name)}`, 'DELETE').catch(() => {});
});

$('#prop-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#prop-name').value.trim();
  const location = $('#prop-location').value;
  if (!name) return;
  api('/api/props', 'POST', { name, location }).then(() => { $('#prop-name').value = ''; }).catch(() => {});
});

$('#prop-rows').addEventListener('change', (e) => {
  const name = e.target.dataset.propLoc;
  if (!name) return;
  api(`/api/props/${encodeURIComponent(name)}`, 'PUT', { location: e.target.value }).catch(() => {});
});

$('#prop-rows').addEventListener('click', (e) => {
  const name = e.target.dataset.delProp;
  if (!name) return;
  if (confirm(`删除道具「${name}」？引用它的提示在重放时会报错。`))
    api(`/api/props/${encodeURIComponent(name)}`, 'DELETE').catch(() => {});
});

$('#add-transfer').addEventListener('click', () => { addTransferRow(); clearPreview(); });

$('#cue-cancel').addEventListener('click', resetCueForm);

// 表单内容一旦改动，旧的试排预览即失效
$('#cue-form').addEventListener('input', clearPreview);
$('#cue-form').addEventListener('change', clearPreview);

$('#cue-preview-btn').addEventListener('click', async () => {
  const token = ++previewToken;
  const box = $('#cue-preview');
  try {
    const res = await fetch('/api/cues/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectCueForm()),
    });
    const data = await res.json();
    if (token !== previewToken) return; // 等待期间表单又改过，丢弃这次旧预览
    if (!res.ok) {
      box.innerHTML = `<div class="preview-head fail">草稿不合法：${esc(data.error || '校验失败')}</div>`;
      box.classList.remove('hidden');
      return;
    }
    renderPreview(data);
  } catch (e) {
    if (token !== previewToken) return;
    box.innerHTML = '<div class="preview-head fail">无法连接服务器，试排预览失败</div>';
    box.classList.remove('hidden');
  }
});

$('#cue-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const { number, note, transfers } = collectCueForm();
  const req = editingCue !== null
    ? api(`/api/cues/${editingCue}`, 'PUT', { note, transfers })
    : api('/api/cues', 'POST', { number, note, transfers });
  req.then(resetCueForm).catch(() => {});
});

$('#cue-list').addEventListener('click', (e) => {
  const editNum = e.target.dataset.editCue;
  const delNum = e.target.dataset.delCue;
  if (editNum) {
    const cue = state.cues.find((c) => c.number === Number(editNum));
    if (!cue) return;
    editingCue = cue.number;
    $('#cue-number').value = cue.number;
    $('#cue-note').value = cue.note || '';
    $('#transfer-rows').innerHTML = '';
    cue.transfers.forEach((t) => addTransferRow(t));
    renderCueForm();
    clearPreview();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else if (delNum) {
    if (confirm(`删除提示 ${delNum}？删除后将按提示号重放全部剩余提示。`))
      api(`/api/cues/${delNum}`, 'DELETE').catch(() => {});
  }
});

/* ---------- 启动 ---------- */

api('/api/state').then(resetCueForm).catch(() => toast('无法连接服务器'));
