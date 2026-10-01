'use strict';

// 编辑台：草稿 CRUD + 逐事件选定主张 + 发布乐观并发控制
const $ = (sel) => document.querySelector(sel);

const PREC_LABEL = { year: '精确到年', month: '精确到月', day: '精确到日' };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const store = {
  get token() { return localStorage.getItem('editorToken') || ''; },
  set token(v) { localStorage.setItem('editorToken', v); },
  get editor() { return localStorage.getItem('editorName') || ''; },
  set editor(v) { localStorage.setItem('editorName', v); },
  get selections() {
    try { return JSON.parse(localStorage.getItem('selections') || '{}'); }
    catch { return {}; }
  },
  setSelection(eventId, claimId) {
    const m = this.selections;
    m[eventId] = claimId;
    localStorage.setItem('selections', JSON.stringify(m));
  },
  clearSelections() { localStorage.removeItem('selections'); },
};

let state = { events: [], relations: [], currentVersionNo: 0 };
let baseVersionNo = 0; // 发起修改时所基于的版本号
let conflictData = null;
// 最近一次预检结果：时间无解时据此查看改选建议（须带回当时的草稿修订号）
let lastValidate = null;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Editor-Token': store.token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 无响应体 */ }
  if (res.status === 401) {
    showGlobal('warn', data?.message || '请先在右上角输入正确的编辑者口令。');
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const err = new Error(data?.message || `请求失败（${res.status}）`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function showGlobal(kind, html) {
  $('#globalMsg').innerHTML = `<div class="alert ${kind}">${html}</div>`;
}

function showPublishResult(kind, html) {
  $('#publishResult').innerHTML = `<div class="alert ${kind}">${html}</div>`;
}

// ---------- 渲染 ----------
function render() {
  $('#versionTag').textContent =
    (state.currentVersionNo === 0 ? '尚无已发布版本（草稿未公开）' : `当前已发布：第 ${state.currentVersionNo} 版`)
    + (state.draftRevision != null ? ` · 草稿修订 #${state.draftRevision}` : '');

  const sel = store.selections;
  $('#eventList').innerHTML = state.events.map((ev) => {
    const claims = ev.claims.map((c) => {
      const checked = sel[ev.id] === c.id ? 'checked' : '';
      return `
        <div class="claim ${checked ? 'selected' : ''}" data-claim="${c.id}">
          <div class="row">
            <div style="flex:0 0 auto;padding-top:2px">
              <input type="radio" name="sel-${ev.id}" data-select-claim="${c.id}" ${checked} style="width:auto" />
            </div>
            <div style="flex:1">
              <strong>${esc(c.dateLabel)}</strong>
              <span class="badge prec">${PREC_LABEL[c.precision]}</span>
              <span class="badge">区间 ${c.intervalStart} ~ ${c.intervalEnd}</span>
              <div class="source"><b>出处：</b>${esc(c.source || '（未注明）')}</div>
              ${c.note ? `<div class="muted">${esc(c.note)}</div>` : ''}
            </div>
            <div style="flex:0 0 auto">
              <button class="danger" data-del-claim="${c.id}" type="button">删除主张</button>
            </div>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="card event-card" id="event-card-${ev.id}" data-event="${ev.id}">
        <div class="row">
          <div class="field">
            <label>事件标题</label>
            <input type="text" value="${esc(ev.title)}" data-edit-title="${ev.id}" />
          </div>
          <div style="flex:0 0 auto">
            <button class="secondary" data-save-event="${ev.id}" type="button">保存</button>
            <button class="danger" data-del-event="${ev.id}" type="button">删除事件</button>
          </div>
        </div>
        <label style="margin-top:6px">描述</label>
        <textarea data-edit-desc="${ev.id}">${esc(ev.description)}</textarea>

        <h3 style="margin-top:10px">时间主张${ev.claims.length === 0 ? '（尚无主张，无法发布）' : `（${ev.claims.length} 条，发布时单选）`}</h3>
        ${claims || '<p class="muted">暂无主张</p>'}

        <div class="claim" style="border-style:dashed">
          <h3>新增主张</h3>
          <div class="row">
            <div class="field" style="max-width:130px">
              <label>精度</label>
              <select data-new-precision="${ev.id}">
                <option value="day">精确到日</option>
                <option value="month">精确到月</option>
                <option value="year">精确到年</option>
              </select>
            </div>
            <div class="field" style="max-width:110px"><label>年</label><input type="number" min="1" max="9999" data-new-year="${ev.id}" placeholder="1958" /></div>
            <div class="field js-month" style="max-width:100px"><label>月</label><input type="number" min="1" max="12" data-new-month="${ev.id}" placeholder="3" /></div>
            <div class="field js-day" style="max-width:100px"><label>日</label><input type="number" min="1" max="31" data-new-day="${ev.id}" placeholder="12" /></div>
          </div>
          <label style="margin-top:6px">出处（受访人 / 档案 / 页码）</label>
          <input type="text" data-new-source="${ev.id}" placeholder="如：李宝山口述，2021-07-05 访谈" />
          <label style="margin-top:6px">考异备注（可选，记录矛盾说法）</label>
          <textarea data-new-note="${ev.id}"></textarea>
          <div style="margin-top:8px"><button data-add-claim="${ev.id}" type="button">添加主张</button></div>
        </div>
      </div>`;
  }).join('') || '<p class="muted">草稿中还没有事件。</p>';

  // 精度联动
  document.querySelectorAll('select[data-new-precision]').forEach((selEl) => {
    const card = selEl.closest('.event-card');
    const apply = () => {
      const p = selEl.value;
      card.querySelector('.js-month').style.display = p === 'year' ? 'none' : '';
      card.querySelector('.js-day').style.display = p === 'day' ? '' : 'none';
    };
    selEl.addEventListener('change', apply);
    apply();
  });

  renderRelations();
}

function titleOf(id) {
  const ev = state.events.find((e) => e.id === id);
  return ev ? ev.title : `#${id}`;
}

function renderRelations() {
  const opts = state.events.map((e) => `<option value="${e.id}">${esc(e.title)}</option>`).join('');
  $('#relEarlier').innerHTML = opts;
  $('#relLater').innerHTML = opts;

  $('#relList').innerHTML = state.relations.length
    ? state.relations.map((r) => `
        <div class="rel-line" id="rel-line-${r.id}">
          <strong>${esc(titleOf(r.earlierId))}</strong>
          <span class="badge">先于</span>
          <strong>${esc(titleOf(r.laterId))}</strong>
          <button class="danger" data-del-rel="${r.id}" type="button" style="float:right">删除</button>
          ${r.source ? `<div class="source"><b>出处：</b>${esc(r.source)}</div>` : ''}
          ${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}
        </div>`).join('')
    : '<p class="muted">尚无先后关系。</p>';
}

async function loadState() {
  state = await api('GET', '/api/editor/state');
  baseVersionNo = state.currentVersionNo;
  // 清掉已失效的选择
  const valid = new Map();
  state.events.forEach((e) => e.claims.forEach((c) => valid.set(c.id, e.id)));
  const m = store.selections;
  let changed = false;
  for (const [eid, cid] of Object.entries(m)) {
    if (valid.get(cid) !== Number(eid)) { delete m[eid]; changed = true; }
  }
  if (changed) localStorage.setItem('selections', JSON.stringify(m));
  render();
  loadVersions();
}

async function loadVersions() {
  const data = await api('GET', '/api/editor/versions');
  $('#versionList').innerHTML = data.versions.length
    ? data.versions.map((v) => `
        <div class="rel-line">
          <strong>第 ${v.versionNo} 版</strong>
          <span class="muted">${v.publishedAt.replace('T', ' ').slice(0, 16)} UTC · ${esc(v.editor || '匿名')}${v.parentNo ? ` · 基于第 ${v.parentNo} 版` : ''}</span>
          ${v.note ? `<div>${esc(v.note)}</div>` : ''}
          <div>
            <a href="/api/public/versions/${v.versionNo}" target="_blank">查看该版快照 JSON</a>
            · <button class="secondary" type="button" data-restore-preview="${v.versionNo}"
                     style="padding:1px 10px;font-size:12px">预览并恢复为此版</button>
          </div>
        </div>`).join('')
    : '尚无版本。';
  renderCompareSelects(data.versions);
}

// ---------- 两版对照 ----------
let manualPairs = []; // 本次对照人工配对 [{fromEventId,toEventId}]（仅前端状态，不写服务器）
let lastCompareData = null; // 最近一次成功对照（出错时回退渲染，保留配对控件）

function renderCompareSelects(versions) {
  const opts = versions.length
    ? versions.map((v) => `<option value="${v.versionNo}">第 ${v.versionNo} 版 · ${esc(v.editor || '匿名')}</option>`).join('')
    : '<option value="">（尚无已发布版本）</option>';
  $('#cmpFrom').innerHTML = opts;
  $('#cmpTo').innerHTML = opts;
  // 默认取相邻两版：前版为倒数第二版、后版为最新版
  if (versions.length >= 2) {
    $('#cmpFrom').value = String(versions[1].versionNo);
    $('#cmpTo').value = String(versions[0].versionNo);
  }
}

const PREC_CODE_LABEL = { year: '精确到年', month: '精确到月', day: '精确到日' };
const DIFF_FIELD_LABEL = {
  title: '标题',
  description: '描述',
  precision: '主张日期精度',
  dateLabel: '主张日期',
  intervalStart: '区间起点',
  intervalEnd: '区间终点',
  source: '出处',
  claimNote: '考异备注',
  resolvedDate: '求解日期',
};
const REL_FIELD_LABEL = { source: '出处', note: '备注' };

function sameVal(a, b) { return a === b; }
function valCell(v, changed) {
  const text = v === '' || v === null || v === undefined ? '（空）' : v;
  return changed ? `<td class="diff-changed">${esc(text)}</td>` : `<td>${esc(text)}</td>`;
}

// 逐项事件前后值表（标题、描述、主张日期精度、区间、出处、考异、求解日期）
function eventFieldTable(fromView, toView, changedFields) {
  const ch = new Set(changedFields);
  const claimRow = (label, key, from, to) =>
    `<tr><td class="diff-label">${label}</td>${valCell(from, ch.has(key))}${valCell(to, ch.has(key))}</tr>`;
  return `
    <table class="cmp-table">
      <thead><tr><th style="width:120px">字段</th><th>前版 #${fromView.versionNo}</th><th>后版 #${toView.versionNo}</th></tr></thead>
      <tbody>
        ${claimRow('标题', 'title', fromView.title, toView.title)}
        ${claimRow('描述', 'description', fromView.description, toView.description)}
        ${claimRow('主张日期精度', 'precision', PREC_CODE_LABEL[fromView.claim.precision] || fromView.claim.precision, PREC_CODE_LABEL[toView.claim.precision] || toView.claim.precision)}
        ${claimRow('主张日期', 'dateLabel', fromView.claim.dateLabel, toView.claim.dateLabel)}
        ${claimRow('区间起点', 'intervalStart', fromView.claim.intervalStart, toView.claim.intervalStart)}
        ${claimRow('区间终点', 'intervalEnd', fromView.claim.intervalEnd, toView.claim.intervalEnd)}
        ${claimRow('出处', 'source', fromView.claim.source, toView.claim.source)}
        ${claimRow('考异备注', 'claimNote', fromView.claim.claimNote, toView.claim.claimNote)}
        ${claimRow('求解日期', 'resolvedDate', fromView.claim.resolvedDate, toView.claim.resolvedDate)}
      </tbody>
    </table>`;
}

function eventSummaryCard(view, sideTag) {
  return `
    <div class="cmp-event">
      <div><b>${esc(view.title)}</b>
        <span class="badge">${sideTag} #${view.versionNo} 事件 ${view.eventId}</span>
        <span class="badge">身份 ${esc(view.identity)}</span>
      </div>
      <div class="muted">${esc(view.claim.dateLabel)} · ${PREC_CODE_LABEL[view.claim.precision] || view.claim.precision}
        · 区间 ${view.claim.intervalStart} ~ ${view.claim.intervalEnd} · 求解日期 ${view.claim.resolvedDate}</div>
      ${view.claim.source ? `<div class="source"><b>出处：</b>${esc(view.claim.source)}</div>` : ''}
      ${view.claim.claimNote ? `<div class="muted">${esc(view.claim.claimNote)}</div>` : ''}
      ${view.description ? `<div class="muted">${esc(view.description)}</div>` : ''}
    </div>`;
}

function relLineHtml(r, tag) {
  return `
    <div class="rel-line">
      <strong>${esc(r.earlierTitle)}</strong> <span class="badge">先于</span> <strong>${esc(r.laterTitle)}</strong>
      <span class="muted">（${tag}：关系 ${r.relationId}）</span>
      <div class="source"><b>出处：</b>${esc(r.source || '（空）')}</div>
      <div class="muted"><b>备注：</b>${esc(r.note || '（空）')}</div>
    </div>`;
}

function relChangeHtml(item) {
  const ch = new Set(item.fields);
  return `
    <div class="rel-line">
      <strong>${esc(item.from.earlierTitle)}</strong> <span class="badge">先于</span> <strong>${esc(item.from.laterTitle)}</strong>
      <table class="cmp-table" style="margin-top:4px">
        <thead><tr><th style="width:80px">字段</th><th>前版（关系 ${item.from.relationId}）</th><th>后版（关系 ${item.to.relationId}）</th></tr></thead>
        <tbody>
          <tr><td class="diff-label">出处</td>${valCell(item.from.source, ch.has('source'))}${valCell(item.to.source, ch.has('source'))}</tr>
          <tr><td class="diff-label">备注</td>${valCell(item.from.note, ch.has('note'))}${valCell(item.to.note, ch.has('note'))}</tr>
        </tbody>
      </table>
    </div>`;
}

function renderCompare(d) {
  const { summary, pairing } = d;

  // ---- 配对事件 ----
  const pairedHtml = d.pairedEvents.length
    ? d.pairedEvents.map((p) => {
        const changed = p.changedFields.length
          ? `变更字段：${p.changedFields.map((f) => `<span class="badge diff-tag">${esc(DIFF_FIELD_LABEL[f] || f)}</span>`).join(' ')}`
          : '<span class="badge" style="border-color:#bcd8c2;color:var(--ok)">逐项无变化</span>';
        const kindTag = p.pairKind === 'manual'
          ? '<span class="badge" style="background:var(--warn-bg)">人工配对</span>'
          : '<span class="badge">身份自动配对</span>';
        return `
          <div class="card cmp-pair ${p.changedFields.length ? 'has-diff' : ''}">
            <div class="row" style="align-items:flex-start">
              <div style="flex:1">${eventSummaryCard(p.from, '前版')}</div>
              <div style="flex:1">${eventSummaryCard(p.to, '后版')}</div>
            </div>
            <div style="margin:6px 0">${kindTag} ${changed}</div>
            ${p.changedFields.length ? eventFieldTable(p.from, p.to, p.changedFields) : ''}
          </div>`;
      }).join('')
    : '<p class="muted">没有任何已配对事件。</p>';

  // ---- 人工配对区 ----
  const unpairedFromOpts = d.unpairedFrom.map((e) => `<option value="${e.eventId}">#${e.eventId} ${esc(e.title)}</option>`).join('');
  const unpairedToOpts = d.unpairedTo.map((e) => `<option value="${e.eventId}">#${e.eventId} ${esc(e.title)}</option>`).join('');
  const manualRows = pairing.pairs.filter((p) => p.kind === 'manual').map((p) =>
    `<li>前版事件 ${p.fromEventId} ↔ 后版事件 ${p.toEventId}</li>`).join('');
  const manualSection = `
    <div class="card" style="background:#fff">
      <h3>人工一对一配对（仅本次对照）</h3>
      <p class="muted">下列事件身份无法证明，未自动配对。选择两端事件后点「加入配对」；
        重复、跨版不存在或与已有确定（身份）配对冲突的配对会被整体拒绝；系统不按标题相似度猜测。</p>
      <div class="row">
        <div class="field"><label>前版未配对事件</label><select id="mpFrom"><option value="">— 选择 —</option>${unpairedFromOpts}</select></div>
        <div style="padding-bottom:6px">↔</div>
        <div class="field"><label>后版未配对事件</label><select id="mpTo"><option value="">— 选择 —</option>${unpairedToOpts}</select></div>
        <div style="flex:0 0 auto"><button class="secondary" id="btnAddManualPair" type="button">加入配对</button></div>
      </div>
      <div class="muted" id="manualPairState">
        已指定人工配对：${manualRows ? `<ul class="error-list" style="cursor:default;text-decoration:none">${manualRows}</ul>` : '（无）'}
      </div>
    </div>`;

  // ---- 未配对事件 ----
  const unpairedHtml = `
    <div class="grid2" style="gap:10px">
      <div>
        <h3>前版未配对事件（${d.unpairedFrom.length}）</h3>
        ${d.unpairedFrom.length ? d.unpairedFrom.map((e) => eventSummaryCard(e, '前版')).join('') : '<p class="muted">无</p>'}
      </div>
      <div>
        <h3>后版未配对事件（${d.unpairedTo.length}）</h3>
        ${d.unpairedTo.length ? d.unpairedTo.map((e) => eventSummaryCard(e, '后版')).join('') : '<p class="muted">无</p>'}
      </div>
    </div>`;

  // ---- 关系 ----
  const R = d.relations;
  const relationsHtml = `
    <div class="card" style="background:#fff">
      <h3>新增的「先于」关系（${R.added.length}）</h3>
      ${R.added.length ? R.added.map((r) => relLineHtml(r, '后版新增')).join('') : '<p class="muted">无</p>'}
      <h3>移除的「先于」关系（${R.removed.length}）</h3>
      ${R.removed.length ? R.removed.map((r) => relLineHtml(r, '前版移除')).join('') : '<p class="muted">无</p>'}
      <h3>修改的关系（两端唯一对应，出处/备注变化；${R.changed.length}）</h3>
      ${R.changed.length ? R.changed.map(relChangeHtml).join('') : '<p class="muted">无</p>'}
      <h3>同端点多条、无法唯一对应的关系</h3>
      ${(R.added.length || R.removed.length)
        ? `<p class="muted">上方「新增 / 移除」中可能包含同端点多条的关系：同端点存在多条、无法唯一对应时，它们作为整组列增删，未推断逐条修改。</p>`
        : '<p class="muted">无（所有同端点关系均可唯一对应）</p>'}
      <h3>端点未配对、无法对照的关系（${R.unpaired.length}）</h3>
      ${R.unpaired.length ? R.unpaired.map((u) =>
        `<div class="rel-line">${relLineHtml(u.relation, u.side === 'from' ? '仅前版' : '仅后版')}
          <div class="muted">端点事件 ${u.unpairedEventId} 在另一版中未配对，故该关系无法逐端比较。</div></div>`).join('')
        : '<p class="muted">无</p>'}
      <h3>未变化的关系（${R.unchanged.length}）</h3>
      <details><summary class="muted">展开查看</summary>
        ${R.unchanged.length ? R.unchanged.map((u) => relLineHtml(u.from, '两版一致')).join('') : '<p class="muted">无</p>'}
      </details>
    </div>`;

  const fv = d.fromVersion;
  const tv = d.toVersion;
  $('#compareBody').innerHTML = `
    <p>对照 <b>前版 #${d.fromVersion.versionNo}</b> → <b>后版 #${d.toVersion.versionNo}</b>
       （只读：不改草稿，也不改任何历史快照）。</p>
    <div class="card" style="background:#faf6ee">
      <b>统计：</b>
      配对事件 ${summary.eventPairs}（身份自动 ${pairing.autoPairCount}、人工 ${pairing.manualPairCount}），
      其中逐项有变化 ${summary.pairedChangedEvents}；
      前版未配对 ${summary.unpairedFromCount}、后版未配对 ${summary.unpairedToCount}；
      关系新增 ${summary.addedRelations}、移除 ${summary.removedRelations}、
      修改 ${summary.changedRelations}、未变 ${summary.unchangedRelations}、端点未配对 ${summary.unpairedRelations}。
    </div>
    ${manualSection}
    <div class="card" style="background:#fff"><h3>配对事件：逐项前后值（${d.pairedEvents.length}）</h3>${pairedHtml}</div>
    <div class="card" style="background:#fff"><h3>未配对事件（分别列出，不按标题猜测）</h3>${unpairedHtml}</div>
    ${relationsHtml}
    <div id="compareMsg"></div>`;

  document.getElementById('btnAddManualPair')?.addEventListener('click', addManualPairFromDialog);
}

async function addManualPairFromDialog() {
  const f = Number($('#mpFrom').value);
  const t = Number($('#mpTo').value);
  if (!f || !t) {
    showCompareError('请分别选择前版与后版的一个未配对事件。');
    return;
  }
  // 前端只拦截“同一端被本会话已指定的人工配对占用”；与自动配对的冲突由服务器判定
  if (manualPairs.some((p) => p.fromEventId === f && p.toEventId === t)) {
    showCompareError('该人工配对已指定过（请勿重复添加同一对）。');
    return;
  }
  if (manualPairs.some((p) => p.fromEventId === f)) {
    showCompareError(`前版事件 #${f} 已与后版事件 #${manualPairs.find((p) => p.fromEventId === f).toEventId} 配对，必须一对一。`);
    return;
  }
  if (manualPairs.some((p) => p.toEventId === t)) {
    showCompareError(`后版事件 #${t} 已与前版事件 #${manualPairs.find((p) => p.toEventId === t).fromEventId} 配对，必须一对一。`);
    return;
  }
  manualPairs.push({ fromEventId: f, toEventId: t });
  const ok = await runCompare(true);
  if (!ok) manualPairs.pop(); // 服务器拒绝（冲突/不存在）时不留存该配对
}

function showCompareError(html) {
  // 错误显示在对照内容顶部；同时清掉底部 #compareMsg 的旧信息
  const box = document.getElementById('compareMsg');
  if (box) box.innerHTML = '';
  const body = $('#compareBody');
  const banner = document.createElement('div');
  banner.className = 'alert error';
  banner.innerHTML = html;
  body.insertBefore(banner, body.firstChild);
}

async function runCompare(keepManual) {
  const fromVersionNo = Number($('#cmpFrom').value);
  const toVersionNo = Number($('#cmpTo').value);
  if (!fromVersionNo || !toVersionNo) {
    showGlobal('error', '需要至少两个已发布版本才能对照。');
    return false;
  }
  if (!keepManual) manualPairs = [];
  if (!lastCompareData || !keepManual) {
    $('#compareBody').innerHTML = '正在对照两个已发布版本…';
  }
  $('#compareDialog').showModal();
  try {
    const data = await api('POST', '/api/editor/compare-versions', {
      fromVersionNo,
      toVersionNo,
      manualPairs,
    });
    lastCompareData = data;
    renderCompare(data);
    return true;
  } catch (e) {
    if (e.message === 'unauthorized') { $('#compareDialog').close(); return false; }
    const invalid = e.body?.invalidPairs;
    const detail = invalid
      ? `<ul class="error-list">${invalid.map((p) =>
          `<li>第 ${p.index + 1} 项（前版 ${esc(p.fromEventId)} ↔ 后版 ${esc(p.toEventId)}）：${esc(pairReasonText(p.reason))}</li>`).join('')}</ul>`
      : '';
    // 出错时保留上一次成功对照（配对控件仍在），仅在顶部显示错误
    if (lastCompareData) {
      renderCompare(lastCompareData);
      showCompareError(`${esc(e.body?.message || e.message)}${detail}`);
    } else {
      $('#compareBody').innerHTML = `<div class="alert error">${esc(e.body?.message || e.message)}</div>${detail}`;
    }
    return false;
  }
}

function pairReasonText(reason) {
  return ({
    invalid_pair_format: '格式非法（需正整数事件 id）',
    from_event_not_found: '前版事件不存在',
    to_event_not_found: '后版事件不存在',
    duplicate_pair: '同一对配对重复出现',
    duplicate_from_event: '前版事件被多次配对（必须一对一）',
    duplicate_to_event: '后版事件被多次配对（必须一对一）',
    conflicts_with_identity_pairing: '与已有确定的身份配对冲突',
  })[reason] || reason;
}

// ---------- 发布 ----------
function gatherSelection() {
  const m = store.selections;
  return state.events.map((e) => ({ eventId: e.id, claimId: Number(m[e.id]) }));
}

function clientCheck() {
  const missing = state.events.filter((e) => !store.selections[e.id]);
  if (state.events.length === 0) return '草稿中没有事件，无法发布。';
  if (missing.length) return `还有 ${missing.length} 个事件未选定主张：${missing.map((e) => `「${e.title}」`).join('、')}`;
  return null;
}

async function doValidate() {
  const err = clientCheck();
  if (err) { showPublishResult('error', esc(err)); return; }
  try {
    const data = await api('POST', '/api/editor/validate', { selection: gatherSelection() });
    lastValidate = data;
    if (!data.ok) {
      renderSolverErrors(data.errors, { suggestRevision: data.draftRevision });
    } else {
      showPublishResult('ok', `
        <b>校验通过，可以发布。</b>系统确定的具体日期：
        <ol style="margin:6px 0">
          ${data.preview.map((p) => `<li>${esc(p.resolvedDate)} — ${esc(p.title)}（主张区间 ${p.intervalStart} ~ ${p.intervalEnd}）</li>`).join('')}
        </ol>`);
    }
  } catch (e) {
    showPublishResult('error', esc(e.message));
  }
}

function renderSolverErrors(errors, { suggestRevision = null } = {}) {
  const typeName = { missing: '缺少主张', cycle: '关系成环', temporal: '时间无解', 'bad_selection': '主张选择无效', broken_relation: '关系失效' };
  const hasTemporal = errors.some((er) => er.type === 'temporal');
  const items = errors.map((er, i) => {
    const targets = [...new Set(er.eventIds.map((id) => `#event-card-${id}`))].join(',');
    return `<li data-targets="${targets}" title="点击定位事件">
      <b>[${typeName[er.type] || er.type}]</b> ${esc(er.message)}
      ${er.detail ? `<div class="muted">涉事关系：${esc(er.detail)}</div>` : ''}
      ${er.relationIds && er.relationIds.length ? `<div class="muted">涉事关系 id：${er.relationIds.join(', ')}</div>` : ''}
    </li>`;
  }).join('');
  const suggestBar = hasTemporal && suggestRevision !== null
    ? `<div style="margin-top:8px">
         <button class="secondary" type="button" id="btnSuggest" data-revision="${esc(suggestRevision)}">
           查看改选建议（只在各事件现有主张中改选，只读不改草稿）
         </button>
       </div>`
    : '';
  showPublishResult('error', `
    <b>无法发布，上一已发布版本保持不变。</b>
    <ul class="error-list">${items}</ul>
    ${suggestBar}`);
  document.querySelectorAll('#publishResult .error-list li').forEach((li) => {
    li.addEventListener('click', () => {
      const targets = (li.dataset.targets || '').split(',').filter(Boolean);
      const first = targets[0] && document.querySelector(targets[0]);
      if (first) {
        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targets.forEach((t) => document.querySelector(t)?.classList.add('has-error', 'highlight-flash'));
        setTimeout(() => targets.forEach((t) => document.querySelector(t)?.classList.remove('highlight-flash')), 1800);
      }
    });
  });
}

// ---------- 时间无解时的改选建议（从预检结果查看；只读） ----------
let lastSuggestion = null;

async function openSuggestion(revision) {
  const err = clientCheck();
  if (err) { showGlobal('error', esc(err)); return; }
  $('#suggestBody').innerHTML = '正在各事件现有主张中搜索改选事件数最少的可行组合…';
  $('#suggestDialog').showModal();
  lastSuggestion = null;
  $('#suggestApply').disabled = true;
  try {
    const data = await api('POST', '/api/editor/suggest-reselection', {
      selection: gatherSelection(),
      draftRevision: Number(revision),
    });
    lastSuggestion = data;
    renderSuggestion(data);
  } catch (e) {
    if (e.message === 'unauthorized') { $('#suggestDialog').close(); return; }
    $('#suggestBody').innerHTML = `<div class="alert error">${esc(e.body?.message || e.message)}</div>`;
  }
}

function renderSuggestion(s) {
  const rows = s.selection.map((row) => {
    const changed = s.changes.some((c) => c.eventId === row.eventId);
    return `<tr class="${changed ? 'suggest-change' : ''}">
      <td>${esc(row.title)}<div class="muted">事件 #${row.eventId} · 主张 #${row.claimId}</div></td>
      <td>${esc(row.dateLabel)}<div class="muted">区间 ${row.intervalStart} ~ ${row.intervalEnd}</div></td>
      <td>${esc(row.resolvedDate)}</td>
      <td>${changed ? '<span class="badge" style="background:#fdebd0">建议改选</span>' : '保持原选择'}</td>
    </tr>`;
  }).join('');
  const changeList = s.changes.length
    ? s.changes.map((c) => `
        <li><b>${esc(c.title)}</b>（事件 #${c.eventId}）：
          主张 #${c.fromClaimId}「${esc(c.from.dateLabel)}」
          → 主张 #${c.toClaimId}「${esc(c.to.dateLabel)}」
          <div class="muted">出处：${esc(c.to.source || '（未注明）')}；区间 ${c.to.intervalStart} ~ ${c.to.intervalEnd}</div>
        </li>`).join('')
    : '<li class="muted">无需改选：当前逐事件选择已可行（可直接重新预检 / 发布）。</li>';

  $('#suggestBody').innerHTML = `
    <p>在<b>不改变任何「先于」关系与主张日期区间</b>、只在各事件现有主张中改选的前提下，
       找到改选事件数最少的可行组合：<b>需改选 ${s.changedEventCount} 个事件</b>
       （平手时按事件 ID 排序后的主张 ID 序列取最小）。草稿修订号 #${s.draftRevision}。</p>
    <div class="card" style="background:#fff">
      <h3>逐项变更</h3>
      <ul class="error-list" style="cursor:default;text-decoration:none">${changeList}</ul>
    </div>
    <div class="card" style="background:#fff">
      <h3>建议组合与求解日期</h3>
      <table class="suggest-table">
        <thead><tr><th>事件</th><th>建议主张</th><th>求解日期</th><th>变更</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="muted">${esc(s.note || '建议只读，不会修改草稿或已发布版本。')}
       点击「应用到本机选择」只会更新本浏览器的单选，不写服务器；应用后请重新预检确认。</p>
    <div id="suggestMsg"></div>`;
  $('#suggestApply').disabled = s.changes.length === 0;
}

function applySuggestion() {
  if (!lastSuggestion) return;
  // 只读建议：只更新本浏览器 localStorage 中的逐事件单选，不调用任何写接口
  const m = store.selections;
  for (const row of lastSuggestion.selection) m[row.eventId] = row.claimId;
  localStorage.setItem('selections', JSON.stringify(m));
  $('#suggestDialog').close();
  render();
  showGlobal('ok',
    `已把改选建议应用到<b>本浏览器</b>的逐事件选择（${lastSuggestion.changedEventCount} 个事件改选，未写服务器）。` +
    '请点击「校验能否发布」复核后再发布。');
}

async function doPublish() {
  const err = clientCheck();
  if (err) { showPublishResult('error', esc(err)); return; }
  const btn = $('#btnPublish');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/editor/publish', {
      selection: gatherSelection(),
      baseVersionNo,
      editor: store.editor || '匿名编辑',
      note: $('#publishNote').value,
    });
    showPublishResult('ok', `已发布 <b>第 ${data.versionNo} 版</b>（不可变快照）。访客年表已更新。<a href="/" target="_blank">打开访客年表</a>`);
    $('#publishNote').value = '';
    await loadState();
  } catch (e) {
    if (e.status === 422 && e.body?.errors) {
      renderSolverErrors(e.body.errors);
    } else if (e.status === 409) {
      conflictData = e.body;
      showConflictDialog(e.body);
      showPublishResult('error', esc(e.message));
    } else {
      showPublishResult('error', esc(e.message));
    }
  } finally {
    btn.disabled = false;
  }
}

function showConflictDialog(body) {
  const cur = body.currentVersion;
  const list = (evs) => (evs || []).map((e) => `<li>${esc(e.title)}</li>`).join('');
  $('#conflictBody').innerHTML = `
    <p>你发起修改时基于的是<b>第 ${body.baseVersionNo} 版</b>，但另一位编辑者已经在此期间发布了
       <b>第 ${body.currentVersionNo} 版</b>，系统<b>没有</b>覆盖对方的版本。</p>
    ${cur ? `
      <div class="card" style="background:#fff">
        <h3>第 ${cur.versionNo} 版概况</h3>
        <p class="muted">发布于 ${cur.publishedAt.replace('T', ' ').slice(0, 16)} UTC · 编辑者：${esc(cur.editor || '匿名')}${cur.note ? ' · 说明：' + esc(cur.note) : ''}</p>
        <p>事件 ${cur.eventCount} 个，先后关系 ${cur.relationCount} 条。</p>
      </div>` : ''}
    <p class="muted">点击下方按钮后，草稿区将刷新为最新状态，<b>请逐条重新确认每个事件的主张选择</b>，再重新发布；若不重新确认，你的提交不会被接受。</p>`;
  $('#conflictDialog').showModal();
}

// ---------- 从历史版本恢复草稿 ----------
let restorePreview = null; // 最近一次预览结果（确认时回传其中的修订号/版本号）

async function openRestorePreview(versionNo) {
  $('#restoreBody').innerHTML = '加载预览…';
  $('#restoreDialog').showModal();
  try {
    restorePreview = await api('POST', '/api/editor/restore/preview', { versionNo });
    renderRestorePreview(restorePreview);
  } catch (e) {
    if (e.message !== 'unauthorized') {
      $('#restoreBody').innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    } else {
      $('#restoreDialog').close();
    }
  }
}

function renderRestorePreview(p) {
  const snapTitle = new Map(p.snapshot.events.map((e) => [e.eventId, e.title]));
  const snapEvents = p.snapshot.events.map((e) => `
      <li><strong>${esc(e.title)}</strong>
        <span class="badge prec">${PREC_LABEL[e.precision] || e.precision}</span>
        <span class="muted">${esc(e.dateLabel)} · 求解日期 ${esc(e.resolvedDate)}</span>
        <div class="source"><b>当版被选主张出处：</b>${esc(e.source || '（未注明）')}${e.claimNote ? '；' + esc(e.claimNote) : ''}</div>
      </li>`).join('');
  const snapRels = p.snapshot.relations.length
    ? p.snapshot.relations.map((r) => `
        <li>${esc(snapTitle.get(r.earlierEventId) || '#' + r.earlierEventId)}
          <span class="badge">先于</span>
          ${esc(snapTitle.get(r.laterEventId) || '#' + r.laterEventId)}
          ${r.source ? `<span class="muted">（出处：${esc(r.source)}）</span>` : ''}
        </li>`).join('')
    : '<li class="muted">该版未记录「先于」关系。</li>';

  const curTitle = new Map(state.events.map((e) => [e.id, e.title]));
  const curEvents = p.currentDraft.events.length
    ? p.currentDraft.events.map((e) => `
        <li>${esc(e.title)}<span class="muted">（${e.claimCount} 条主张）</span></li>`).join('')
    : '<li class="muted">（草稿当前没有事件）</li>';
  const curRels = p.currentDraft.relations.length
    ? p.currentDraft.relations
        .map((r) => `<li>${esc(curTitle.get(r.earlierId) || '#' + r.earlierId)} 先于 ${esc(curTitle.get(r.laterId) || '#' + r.laterId)}</li>`)
        .join('')
    : '<li class="muted">（草稿当前没有关系）</li>';

  const curNote = state.currentVersionNo === 0
    ? '草稿尚未发布过版本'
    : `草稿对应最新已发布：第 ${state.currentVersionNo} 版`;

  $('#restoreBody').innerHTML = `
    <p>将把<b>整个草稿</b>替换为<b>第 ${p.versionNo} 版</b>的快照内容：
       ${p.snapshot.events.length} 个事件、${p.snapshot.relations.length} 条「先于」关系；
       每个事件只带回该版<b>被选定的那一条主张</b>（其余主张不会恢复，恢复后可继续补录）。</p>
    <div class="card" style="background:#fff">
      <h3>第 ${p.versionNo} 版将恢复的内容</h3>
      <ul class="error-list" style="cursor:default;text-decoration:none">${snapEvents}</ul>
      <h3>「先于」关系</h3>
      <ul class="error-list" style="cursor:default;text-decoration:none">${snapRels}</ul>
    </div>
    <div class="card" style="background:#fff">
      <h3>当前草稿中将被替换的内容</h3>
      <p class="muted">${curNote}；草稿修订号 #${p.draftRevision}。以下内容会被整体覆盖（历史已发布版本与访客年表不变）：</p>
      <div class="grid2" style="gap:10px">
        <div><b>事件（${p.currentDraft.events.length}）</b><ul class="error-list" style="cursor:default;text-decoration:none">${curEvents}</ul></div>
        <div><b>关系（${p.currentDraft.relations.length}）</b><ul class="error-list" style="cursor:default;text-decoration:none">${curRels}</ul></div>
      </div>
    </div>
    <p class="muted">确认后系统会原子替换草稿；若确认前草稿被他人改动或有新版本发布，将返回冲突且<b>不改任何数据</b>，届时请重新预览。
       恢复不会改变历史快照，也不会自动发布；恢复后请逐条校验再发布。</p>
    <div id="restoreMsg"></div>`;
}

async function doRestoreConfirm() {
  if (!restorePreview) return;
  const btn = $('#restoreConfirm');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/editor/restore/confirm', {
      versionNo: restorePreview.versionNo,
      draftRevision: restorePreview.draftRevision,
      expectedLatestVersionNo: restorePreview.latestVersionNo,
    });
    // 快照每事件只恢复了一条主张，直接预选该主张，供编辑台继续校验发布
    const m = {};
    for (const ev of data.state.events) {
      if (ev.claims[0]) m[ev.id] = ev.claims[0].id;
    }
    localStorage.setItem('selections', JSON.stringify(m));
    $('#restoreDialog').close();
    await loadState();
    showGlobal('warn',
      `已用第 ${data.restoredFromVersionNo} 版快照原子替换草稿（修订号 #${data.state.draftRevision}）。` +
      `历史版本与访客年表未变；各事件的当版主张已预选，请<b>逐条校验后再发布</b>。`);
  } catch (e) {
    if (e.message !== 'unauthorized') {
      const box = $('#restoreMsg');
      if (box) box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    }
  } finally {
    btn.disabled = false;
  }
}

// ---------- 事件委托：增删改 ----------
async function onClick(e) {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;

  if (t.id === 'tokenSave') {
    store.token = $('#tokenInput').value.trim();
    showGlobal('ok', '口令已保存到本浏览器。');
    await loadState();
    return;
  }
  if (t.id === 'btnValidate') return doValidate();
  if (t.id === 'btnPublish') return doPublish();

  if (t.id === 'btnSuggest') return openSuggestion(t.dataset.revision);
  if (t.id === 'suggestCancel') { $('#suggestDialog').close(); return; }
  if (t.id === 'suggestApply') { applySuggestion(); return; }

  if (t.id === 'conflictCancel') { $('#conflictDialog').close(); return; }
  if (t.id === 'conflictReload') {
    $('#conflictDialog').close();
    await loadState();
    showGlobal('warn', `已刷新到第 ${baseVersionNo} 版后的最新草稿。请重新确认各事件的主张选择，再点击发布。`);
    return;
  }

  if (t.id === 'restoreCancel') { $('#restoreDialog').close(); return; }
  if (t.id === 'restoreConfirm') { await doRestoreConfirm(); return; }
  const restorePreviewNo = t.dataset && t.dataset.restorePreview;
  if (restorePreviewNo !== undefined) { await openRestorePreview(Number(restorePreviewNo)); return; }

  if (t.id === 'btnCompare') { await runCompare(false); return; }
  if (t.id === 'compareCancel') { $('#compareDialog').close(); return; }
  if (t.id === 'compareClearManual') { manualPairs = []; await runCompare(true); return; }

  const addEvent = t.dataset && t.dataset.addEvent !== undefined;
  if (t.id === 'btnAddEvent') {
    const title = $('#newEventTitle').value.trim();
    if (!title) { showGlobal('error', '事件标题不能为空。'); return; }
    await api('POST', '/api/editor/events', { title, description: $('#newEventDesc').value });
    $('#newEventTitle').value = ''; $('#newEventDesc').value = '';
    await loadState();
    return;
  }

  const saveEvent = t.dataset && t.dataset.saveEvent;
  if (saveEvent) {
    const id = Number(saveEvent);
    const title = document.querySelector(`[data-edit-title="${id}"]`).value.trim();
    const description = document.querySelector(`[data-edit-desc="${id}"]`).value;
    if (!title) { showGlobal('error', '事件标题不能为空。'); return; }
    await api('PUT', `/api/editor/events/${id}`, { title, description });
    await loadState();
    return;
  }

  const delEvent = t.dataset && t.dataset.delEvent;
  if (delEvent) {
    if (!confirm(`删除事件「${titleOf(Number(delEvent))}」将同时删除其全部主张与相关先后关系，确定？`)) return;
    await api('DELETE', `/api/editor/events/${delEvent}`);
    await loadState();
    return;
  }

  const addClaim = t.dataset && t.dataset.addClaim;
  if (addClaim) {
    const id = Number(addClaim);
    const precision = document.querySelector(`[data-new-precision="${id}"]`).value;
    const year = Number(document.querySelector(`[data-new-year="${id}"]`).value);
    const monthEl = document.querySelector(`[data-new-month="${id}"]`);
    const dayEl = document.querySelector(`[data-new-day="${id}"]`);
    const payload = {
      precision,
      year,
      month: precision === 'year' ? undefined : Number(monthEl.value),
      day: precision === 'day' ? Number(dayEl.value) : undefined,
      source: document.querySelector(`[data-new-source="${id}"]`).value,
      note: document.querySelector(`[data-new-note="${id}"]`).value,
    };
    try {
      const data = await api('POST', `/api/editor/events/${id}/claims`, payload);
      store.setSelection(id, data.claim.id); // 新增主张默认选中，可改
      await loadState();
    } catch (err) { showGlobal('error', esc(err.message)); }
    return;
  }

  const delClaim = t.dataset && t.dataset.delClaim;
  if (delClaim) {
    if (!confirm('删除这条时间主张？')) return;
    await api('DELETE', `/api/editor/claims/${delClaim}`);
    await loadState();
    return;
  }

  if (t.id === 'btnAddRel') {
    const earlierId = Number($('#relEarlier').value);
    const laterId = Number($('#relLater').value);
    if (earlierId === laterId) { showGlobal('error', '一个事件不能先于自身。'); return; }
    try {
      await api('POST', '/api/editor/relations', {
        earlierId, laterId, source: $('#relSource').value,
      });
      $('#relSource').value = '';
      await loadState();
    } catch (err) { showGlobal('error', esc(err.message)); }
    return;
  }

  const delRel = t.dataset && t.dataset.delRel;
  if (delRel) {
    await api('DELETE', `/api/editor/relations/${delRel}`);
    await loadState();
  }
}

function onChange(e) {
  const claimId = e.target.dataset && e.target.dataset.selectClaim;
  if (claimId !== undefined) {
    const card = e.target.closest('.event-card');
    store.setSelection(Number(card.dataset.event), Number(claimId));
    render();
  }
}

// ---------- 启动 ----------
document.addEventListener('click', (e) => {
  onClick(e).catch((err) => {
    if (err.message !== 'unauthorized') showGlobal('error', esc(err.message));
  });
});
document.addEventListener('change', onChange);

$('#tokenInput').value = store.token;
$('#editorName').value = store.editor;
$('#editorName').addEventListener('input', (e) => { store.editor = e.target.value; });

(async function init() {
  if (!store.token) {
    showGlobal('warn', '请先在右上角输入编辑者口令（默认 <code>editor</code>，可用环境变量 EDITOR_TOKEN 修改），然后点“保存口令”。');
    return;
  }
  try {
    await loadState();
  } catch (err) {
    if (err.message !== 'unauthorized') showGlobal('error', esc(err.message));
  }
})();
