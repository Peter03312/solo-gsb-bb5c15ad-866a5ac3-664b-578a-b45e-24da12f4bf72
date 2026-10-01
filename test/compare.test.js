'use strict';

// 两版对照（compare-versions）端到端测试：
// 身份配对（同草稿 id / 恢复后再发布延续身份 / 无法证明的未配对）、
// 人工一对一配对（重复、不存在、冲突拒绝；不按标题猜测）、
// 逐项事件前后值、关系增删改与同端点多条只列增删、只读性、未知版本 404、既有接口兼容。
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
const { SCHEMA, setDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app } = require('../src/server');

const TOKEN = 'test-token';
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM sqlite_sequence;
    UPDATE draft_meta SET revision = 0 WHERE id = 1;
  `);
});

async function call(method, url, { token = TOKEN, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Editor-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function makeEvent(title, description = '') {
  const r = await call('POST', '/api/editor/events', { body: { title, description } });
  assert.strictEqual(r.status, 201);
  return r.json.event.id;
}
async function makeClaim(eventId, payload) {
  const r = await call('POST', `/api/editor/events/${eventId}/claims`, { body: payload });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.claim.id;
}
async function makeRel(a, b, source = '', note = '') {
  const r = await call('POST', '/api/editor/relations', { body: { earlierId: a, laterId: b, source, note } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.relation.id;
}
async function publish(selection, baseVersionNo, extra = {}) {
  const r = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo, ...extra },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json;
}
async function restore(versionNo) {
  const preview = (await call('POST', '/api/editor/restore/preview', { body: { versionNo } })).json;
  const con = await call('POST', '/api/editor/restore/confirm', {
    body: {
      versionNo,
      draftRevision: preview.draftRevision,
      expectedLatestVersionNo: preview.latestVersionNo,
    },
  });
  assert.strictEqual(con.status, 200, JSON.stringify(con.json));
  return con.json;
}
function year(y, source = 's', note = '') { return { precision: 'year', year: y, source, note }; }
function day(y, m, d, source = 's', note = '') { return { precision: 'day', year: y, month: m, day: d, source, note }; }
function sel(state, title, claimIndex = 0) {
  const ev = state.events.find((e) => e.title === title);
  return { eventId: ev.id, claimId: ev.claims[claimIndex].id };
}
async function compare(body, { token = TOKEN } = {}) {
  return call('POST', '/api/editor/compare-versions', { token, body });
}

// ---------- 身份自动配对 ----------

test('同一草稿事件 id 连续发布两版：自动配对并逐项显示前后值', async () => {
  const a = await makeEvent('甲', '旧描述');
  const ca = await makeClaim(a, year(1958, '出处甲'));
  await publish([{ eventId: a, claimId: ca }], 0);

  await call('PUT', `/api/editor/events/${a}`, { body: { title: '甲（改名）', description: '新描述' } });
  await call('PUT', `/api/editor/claims/${ca}`, { body: day(1959, 6, 15, '出处甲2', '考异一条') });
  await publish([{ eventId: a, claimId: ca }], 1);

  const r = await compare({ fromVersionNo: 1, toVersionNo: 2 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.pairing.autoPairCount, 1);
  assert.strictEqual(r.json.pairing.manualPairCount, 0);
  const p = r.json.pairedEvents[0];
  assert.strictEqual(p.pairKind, 'identity');
  assert.strictEqual(p.from.eventId, a);
  assert.strictEqual(p.to.eventId, a); // 同一草稿 id
  for (const f of ['title', 'description', 'precision', 'dateLabel', 'intervalStart', 'intervalEnd', 'source', 'claimNote', 'resolvedDate']) {
    assert.ok(p.changedFields.includes(f), `应包含变更字段 ${f}，实际：${p.changedFields.join(',')}`);
  }
  assert.strictEqual(p.from.title, '甲');
  assert.strictEqual(p.to.title, '甲（改名）');
  assert.strictEqual(p.from.claim.precision, 'year');
  assert.strictEqual(p.to.claim.precision, 'day');
  assert.strictEqual(p.from.claim.source, '出处甲');
  assert.strictEqual(p.to.claim.source, '出处甲2');
  assert.strictEqual(p.from.claim.resolvedDate, '1958-01-01');
  assert.strictEqual(p.to.claim.resolvedDate, '1959-06-15');
});

test('从已发布版恢复草稿后再发布：数据库换了新事件 id，仍按身份自动配对', async () => {
  const a = await makeEvent('甲');
  const b = await makeEvent('乙');
  const ca = await makeClaim(a, day(1958, 3, 1, '出处甲'));
  const cb = await makeClaim(b, day(1958, 3, 2, '出处乙'));
  await makeRel(a, b, '关系出处');
  await publish([{ eventId: a, claimId: ca }, { eventId: b, claimId: cb }], 0);

  const con = await restore(1);
  // 数据库分配了全新草稿 id
  assert.notStrictEqual(con.idMap.events[a], a);
  assert.notStrictEqual(con.idMap.events[b], b);

  const newA = con.idMap.events[a];
  await call('PUT', `/api/editor/events/${newA}`, { body: { title: '甲（改）', description: '' } });
  const s2 = con.state.events.map((e) => ({ eventId: e.id, claimId: e.claims[0].id }));
  await publish(s2, 1, { editor: '恢复后发布' });

  const r = await compare({ fromVersionNo: 1, toVersionNo: 2 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.summary.eventPairs, 2);
  const pairOfA = r.json.pairedEvents.find((p) => p.from.eventId === a);
  assert.strictEqual(pairOfA.to.eventId, con.idMap.events[a]); // 新 id 但身份延续
  assert.strictEqual(pairOfA.identity, `e${a}`);
  assert.deepStrictEqual(pairOfA.changedFields, ['title']);
  assert.strictEqual(r.json.summary.unpairedFromCount, 0);
  assert.strictEqual(r.json.summary.unpairedToCount, 0);
});

test('身份无法证明的事件分别列为未配对，不按相似标题猜测', async () => {
  // v1：事件「同名标题」a，再加一个占位事件 z（保证后续新建 id 不会复用 a 的 id）
  const a = await makeEvent('同名标题');
  const ca = await makeClaim(a, year(1958));
  const z = await makeEvent('占位');
  const cz = await makeClaim(z, year(1950));
  await publish([{ eventId: a, claimId: ca }, { eventId: z, claimId: cz }], 0);

  // 删除 a（历史快照 v1 保留），再新建另一个全新事件 a2，标题相同但身份不同
  await call('DELETE', `/api/editor/events/${a}`);
  const a2 = await makeEvent('同名标题'); // id 与 a 不同（z 占位使序列前进）
  const ca2 = await makeClaim(a2, year(1959));
  await publish([{ eventId: z, claimId: cz }, { eventId: a2, claimId: ca2 }], 1);

  const r = await compare({ fromVersionNo: 1, toVersionNo: 2 });
  assert.strictEqual(r.status, 200);
  // z 身份自动配对；两个同名事件未配对
  assert.strictEqual(r.json.pairing.autoPairCount, 1);
  assert.strictEqual(r.json.unpairedFrom.length, 1);
  assert.strictEqual(r.json.unpairedTo.length, 1);
  assert.strictEqual(r.json.unpairedFrom[0].identity, `e${a}`);
  assert.strictEqual(r.json.unpairedTo[0].identity, `e${a2}`);
  assert.notStrictEqual(a, a2);
  assert.strictEqual(r.json.unpairedFrom[0].title, '同名标题');
  assert.strictEqual(r.json.unpairedTo[0].title, '同名标题'); // 标题相同也不猜
});

test('身份无法自动证明的未配对事件可人工配对（不按标题相似度判断）', async () => {
  // v1：甲（身份 e<a>）。占位事件 z 保证后续新建 id 不复用。
  const a = await makeEvent('甲');
  const ca = await makeClaim(a, year(1958));
  const z = await makeEvent('占位');
  const cz = await makeClaim(z, year(1950));
  await publish([{ eventId: a, claimId: ca }, { eventId: z, claimId: cz }], 0);

  // 删除甲后新建「完全不同的标题」：全新身份，与 v1 的 e<a> 不同
  await call('DELETE', `/api/editor/events/${a}`);
  const b = await makeEvent('完全不同的标题');
  const cb = await makeClaim(b, year(1959));
  await publish([{ eventId: z, claimId: cz }, { eventId: b, claimId: cb }], 1);

  const r0 = await compare({ fromVersionNo: 1, toVersionNo: 2 });
  assert.strictEqual(r0.json.pairing.autoPairCount, 1); // z 自动配对
  assert.strictEqual(r0.json.unpairedFrom.length, 1);
  assert.strictEqual(r0.json.unpairedTo.length, 1);

  // 人工一对一配对：两端均未配对，即使标题完全不同也接受（不按标题相似度判断）
  const r = await compare({ fromVersionNo: 1, toVersionNo: 2, manualPairs: [{ fromEventId: a, toEventId: b }] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.pairing.manualPairCount, 1);
  assert.strictEqual(r.json.pairing.autoPairCount, 1); // z 仍为身份自动配对
  const mp = r.json.pairedEvents.find((p) => p.pairKind === 'manual');
  assert.ok(mp);
  assert.strictEqual(mp.from.title, '甲');
  assert.strictEqual(mp.to.title, '完全不同的标题');
  assert.strictEqual(r.json.summary.unpairedFromCount, 0);
});

test('人工配对占用已自动配对的端点（与确定配对冲突）→ 400 conflicts_with_identity_pairing', async () => {
  // a 两版自动配对；b 两版自动配对。尝试把已配对的 a 配到已配对的 b：与确定配对冲突
  const a = await makeEvent('甲');
  const b = await makeEvent('乙');
  const ca = await makeClaim(a, year(1958));
  const cb = await makeClaim(b, year(1959));
  await publish([{ eventId: a, claimId: ca }, { eventId: b, claimId: cb }], 0);
  await publish([{ eventId: a, claimId: ca }, { eventId: b, claimId: cb }], 1);

  const r = await compare({ fromVersionNo: 1, toVersionNo: 2, manualPairs: [{ fromEventId: a, toEventId: b }] });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.invalidPairs[0].reason, 'conflicts_with_identity_pairing');
});

// ---------- 人工配对拒绝情形 ----------

test('人工配对：跨版不存在的事件 → 400 PAIR_INVALID 逐项 reason', async () => {
  const a = await makeEvent('甲');
  const ca = await makeClaim(a, year(1958));
  await publish([{ eventId: a, claimId: ca }], 0);
  const b = await makeEvent('乙');
  const cb = await makeClaim(b, year(1959));
  await publish([{ eventId: a, claimId: ca }, { eventId: b, claimId: cb }], 1);

  const r = await compare({ fromVersionNo: 1, toVersionNo: 2, manualPairs: [{ fromEventId: 999, toEventId: b }] });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.code, 'PAIR_INVALID');
  assert.strictEqual(r.json.invalidPairs[0].reason, 'from_event_not_found');

  const r2 = await compare({ fromVersionNo: 1, toVersionNo: 2, manualPairs: [{ fromEventId: a, toEventId: 888 }] });
  assert.strictEqual(r2.status, 400);
  assert.strictEqual(r2.json.invalidPairs[0].reason, 'to_event_not_found');

  // 格式非法
  const r3 = await compare({ fromVersionNo: 1, toVersionNo: 2, manualPairs: [{ fromEventId: 'x', toEventId: 1 }] });
  assert.strictEqual(r3.status, 400);
  assert.strictEqual(r3.json.code, 'PAIR_INVALID');
  assert.strictEqual(r3.json.invalidPairs[0].reason, 'invalid_pair_format');
});

test('人工配对：重复（同对 / from 重复 / to 重复）→ 400', async () => {
  // v1 有 a,b（外加占位 z，保证删除 a,b 后自增序列不复用其 id）
  const a = await makeEvent('甲');
  const b = await makeEvent('乙');
  const ca = await makeClaim(a, year(1958));
  const cb = await makeClaim(b, year(1959));
  const z = await makeEvent('占位');
  const cz = await makeClaim(z, year(1950));
  await publish([{ eventId: a, claimId: ca }, { eventId: b, claimId: cb }, { eventId: z, claimId: cz }], 0);

  // 删除 a,b，再新建 c,d（身份 e<c>/e<d> 与 v1 的 e<a>/e<b> 不同；z 两版自动配对）
  await call('DELETE', `/api/editor/events/${a}`);
  await call('DELETE', `/api/editor/events/${b}`);
  const c = await makeEvent('丙');
  const d = await makeEvent('丁');
  const cc = await makeClaim(c, year(1960));
  const cd = await makeClaim(d, year(1961));
  await publish([{ eventId: z, claimId: cz }, { eventId: c, claimId: cc }, { eventId: d, claimId: cd }], 1);

  const r = await compare({
    fromVersionNo: 1,
    toVersionNo: 2,
    manualPairs: [
      { fromEventId: a, toEventId: c },
      { fromEventId: a, toEventId: d }, // from 重复
    ],
  });
  assert.strictEqual(r.status, 400);
  assert.ok(r.json.invalidPairs.some((p) => p.reason === 'duplicate_from_event'));

  const r2 = await compare({
    fromVersionNo: 1,
    toVersionNo: 2,
    manualPairs: [
      { fromEventId: a, toEventId: c },
      { fromEventId: b, toEventId: c }, // to 重复
    ],
  });
  assert.strictEqual(r2.status, 400);
  assert.ok(r2.json.invalidPairs.some((p) => p.reason === 'duplicate_to_event'));

  const r3 = await compare({
    fromVersionNo: 1,
    toVersionNo: 2,
    manualPairs: [
      { fromEventId: a, toEventId: c },
      { fromEventId: a, toEventId: c }, // 同对重复
    ],
  });
  assert.strictEqual(r3.status, 400);
  assert.ok(r3.json.invalidPairs.some((p) => p.reason === 'duplicate_pair'));
});

test('人工配对：与已有确定（身份）配对冲突 → 400；与自动一致的人工项合法', async () => {
  const a = await makeEvent('甲');
  const b = await makeEvent('乙');
  const ca = await makeClaim(a, year(1958));
  const cb = await makeClaim(b, year(1959));
  await publish([{ eventId: a, claimId: ca }, { eventId: b, claimId: cb }], 0);
  // v2：a,b 身份自动配对；再加全新事件 c（未配对）
  const c = await makeEvent('丙');
  const cc = await makeClaim(c, year(1960));
  await publish([{ eventId: a, claimId: ca }, { eventId: b, claimId: cb }, { eventId: c, claimId: cc }], 1);

  // a 已自动配对到 a：把 a 人工配到未配对的 c → 冲突
  const r = await compare({ fromVersionNo: 1, toVersionNo: 2, manualPairs: [{ fromEventId: a, toEventId: c }] });
  assert.strictEqual(r.status, 400);
  assert.ok(r.json.invalidPairs.some((p) => p.reason === 'conflicts_with_identity_pairing'));

  // 与自动一致的人工配对：冗余但合法
  const r2 = await compare({ fromVersionNo: 1, toVersionNo: 2, manualPairs: [{ fromEventId: a, toEventId: a }] });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.json.pairing.manualPairCount, 0); // 不重复计数
  assert.strictEqual(r2.json.pairing.autoPairCount, 2);
});

// ---------- 关系对照 ----------

test('关系：新增 / 移除 / 出处备注修改 / 未变 分类正确', async () => {
  const a = await makeEvent('甲');
  const b = await makeEvent('乙');
  const c = await makeEvent('丙');
  const ca = await makeClaim(a, day(1958, 1, 1));
  const cb = await makeClaim(b, day(1958, 1, 2));
  const cc = await makeClaim(c, day(1958, 1, 3));
  // v1：a->b（出处旧）、b->c
  await makeRel(a, b, '旧出处', '旧备注');
  await makeRel(b, c, 'bc出处');
  await publish(
    [
      { eventId: a, claimId: ca },
      { eventId: b, claimId: cb },
      { eventId: c, claimId: cc },
    ],
    0
  );

  // 草稿：改 a->b 出处；删 b->c；加 a->c
  const st = await call('GET', '/api/editor/state');
  const relAB = st.json.relations.find((r) => r.earlierId === a && r.laterId === b);
  const relBC = st.json.relations.find((r) => r.earlierId === b && r.laterId === c);
  await call('DELETE', `/api/editor/relations/${relBC.id}`);
  // 关系无 PUT：删旧建新改出处
  await call('DELETE', `/api/editor/relations/${relAB.id}`);
  await makeRel(a, b, '新出处', '新备注');
  await makeRel(a, c, 'ac出处');
  await publish(
    [
      { eventId: a, claimId: ca },
      { eventId: b, claimId: cb },
      { eventId: c, claimId: cc },
    ],
    1
  );

  const r = await compare({ fromVersionNo: 1, toVersionNo: 2 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const R = r.json.relations;
  assert.strictEqual(R.added.length, 1);
  assert.strictEqual(R.added[0].earlierEventId, a);
  assert.strictEqual(R.added[0].laterEventId, c);
  assert.strictEqual(R.removed.length, 1);
  assert.strictEqual(R.removed[0].earlierEventId, b);
  assert.strictEqual(R.removed[0].laterEventId, c);
  assert.strictEqual(R.changed.length, 1);
  assert.strictEqual(R.changed[0].from.relationId, relAB.id);
  assert.deepStrictEqual(R.changed[0].fields, ['source', 'note']);
  assert.strictEqual(R.changed[0].from.source, '旧出处');
  assert.strictEqual(R.changed[0].to.source, '新出处');
  assert.strictEqual(R.unchanged.length, 0);
});

test('同端点多条关系无法唯一对应：只列增删，不推断修改', async () => {
  const a = await makeEvent('甲');
  const b = await makeEvent('乙');
  const ca = await makeClaim(a, day(1958, 1, 1));
  const cb = await makeClaim(b, day(1958, 1, 2));
  // v1：a->b 两条（出处 x、y）
  await makeRel(a, b, 'x');
  await makeRel(a, b, 'y');
  await publish([{ eventId: a, claimId: ca }, { eventId: b, claimId: cb }], 0);

  // v2：a->b 两条（出处 x、z）——同端点多条，x 一致，y/z 不应被判为“修改”
  const st = await call('GET', '/api/editor/state');
  for (const r of st.json.relations) await call('DELETE', `/api/editor/relations/${r.id}`);
  await makeRel(a, b, 'x');
  await makeRel(a, b, 'z');
  await publish([{ eventId: a, claimId: ca }, { eventId: b, claimId: cb }], 1);

  const r = await compare({ fromVersionNo: 1, toVersionNo: 2 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const R = r.json.relations;
  assert.strictEqual(R.changed.length, 0, '同端点多条不得推断修改');
  assert.strictEqual(R.removed.length, 1);
  assert.strictEqual(R.removed[0].source, 'y');
  assert.strictEqual(R.added.length, 1);
  assert.strictEqual(R.added[0].source, 'z');
  assert.strictEqual(R.unchanged.length, 1);
  assert.strictEqual(R.unchanged[0].from.source, 'x');
});

test('任一端点未配对的关系进 unpaired 组，不参与增删改比较', async () => {
  const a = await makeEvent('甲');
  const b = await makeEvent('乙');
  const ca = await makeClaim(a, day(1958, 1, 1));
  const cb = await makeClaim(b, day(1958, 1, 2));
  await makeRel(a, b, 'v1关系');
  await publish([{ eventId: a, claimId: ca }, { eventId: b, claimId: cb }], 0);

  // v2：a 身份延续，b 被删除，新增 c；建 a->c
  const con = await restore(1);
  const newA = con.state.events.find((e) => e.title === '甲').id;
  const newB = con.state.events.find((e) => e.title === '乙').id;
  // 删除恢复出的乙
  await call('DELETE', `/api/editor/events/${newB}`);
  const newC = await makeEvent('丙');
  const cClaim = await makeClaim(newC, day(1958, 1, 3));
  await makeRel(newA, newC, 'v2关系');
  const st2 = await call('GET', '/api/editor/state');
  const s2 = [
    { eventId: newA, claimId: st2.json.events.find((e) => e.id === newA).claims[0].id },
    { eventId: newC, claimId: cClaim },
  ];
  await publish(s2, 1);

  const r = await compare({ fromVersionNo: 1, toVersionNo: 2 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const R = r.json.relations;
  // v1 的 a->b 因 b 未配对；v2 的 a->c 因 c 未配对
  assert.strictEqual(R.added.length, 0);
  assert.strictEqual(R.removed.length, 0);
  assert.strictEqual(R.changed.length, 0);
  assert.strictEqual(R.unpaired.length, 2);
  assert.deepStrictEqual(new Set(R.unpaired.map((u) => u.side)), new Set(['from', 'to']));

  // 人工配对 b↔c 后：两条关系的配对后端点相同（a→b == a→c），视为同一关系；
  // 出处不同（v1关系→v2关系），归入“修改”而非增删
  const r2 = await compare({
    fromVersionNo: 1,
    toVersionNo: 2,
    manualPairs: [{ fromEventId: b, toEventId: newC }],
  });
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.json));
  assert.strictEqual(r2.json.relations.unpaired.length, 0);
  assert.strictEqual(r2.json.relations.added.length, 0);
  assert.strictEqual(r2.json.relations.removed.length, 0);
  assert.strictEqual(r2.json.relations.changed.length, 1);
  assert.deepStrictEqual(r2.json.relations.changed[0].fields, ['source']);
  assert.strictEqual(r2.json.relations.changed[0].from.source, 'v1关系');
  assert.strictEqual(r2.json.relations.changed[0].to.source, 'v2关系');
});

// ---------- 版本与只读语义 ----------

test('未知版本明确 404 VERSION_NOT_FOUND（from/to 分别检查）', async () => {
  const a = await makeEvent('甲');
  const ca = await makeClaim(a, year(1958));
  await publish([{ eventId: a, claimId: ca }], 0);

  const r1 = await compare({ fromVersionNo: 99, toVersionNo: 1 });
  assert.strictEqual(r1.status, 404);
  assert.strictEqual(r1.json.code, 'VERSION_NOT_FOUND');
  const r2 = await compare({ fromVersionNo: 1, toVersionNo: 99 });
  assert.strictEqual(r2.status, 404);
  assert.strictEqual(r2.json.code, 'VERSION_NOT_FOUND');
});

test('非法版本号参数 → 400；manualPairs 非数组 → 400；接口需口令', async () => {
  const r1 = await compare({ fromVersionNo: -1, toVersionNo: 1 });
  assert.strictEqual(r1.status, 400);
  const r2 = await compare({ fromVersionNo: 1, toVersionNo: 'x' });
  assert.strictEqual(r2.status, 400);
  const r3 = await compare({ fromVersionNo: 1, toVersionNo: 1, manualPairs: {} });
  assert.strictEqual(r3.status, 400);
  const r4 = await compare({ fromVersionNo: 1, toVersionNo: 1 }, { token: null });
  assert.strictEqual(r4.status, 401);
});

test('同版自比：全部配对、无变化', async () => {
  const a = await makeEvent('甲');
  const b = await makeEvent('乙');
  const ca = await makeClaim(a, day(1958, 1, 1));
  const cb = await makeClaim(b, day(1958, 1, 2));
  await makeRel(a, b);
  await publish([{ eventId: a, claimId: ca }, { eventId: b, claimId: cb }], 0);

  const r = await compare({ fromVersionNo: 1, toVersionNo: 1 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.summary.eventPairs, 2);
  assert.strictEqual(r.json.summary.pairedChangedEvents, 0);
  assert.strictEqual(r.json.relations.unchanged.length, 1);
  assert.strictEqual(r.json.relations.added.length + r.json.relations.removed.length, 0);
});

test('对照只读：不推进草稿修订号、不改任何快照/草稿', async () => {
  const a = await makeEvent('甲');
  const ca = await makeClaim(a, year(1958));
  await publish([{ eventId: a, claimId: ca }], 0);
  const a2 = await makeEvent('乙');
  const ca2 = await makeClaim(a2, year(1960));
  await publish([{ eventId: a, claimId: ca }, { eventId: a2, claimId: ca2 }], 1);

  const before = (await call('GET', '/api/editor/state')).json;
  await compare({ fromVersionNo: 1, toVersionNo: 2 });
  await compare({ fromVersionNo: 1, toVersionNo: 2, manualPairs: [{ fromEventId: a, toEventId: a }] });
  const after = await call('GET', '/api/editor/state');
  assert.strictEqual(after.json.draftRevision, before.draftRevision);
  assert.deepStrictEqual(
    after.json.events.map((e) => [e.id, e.title]),
    before.events.map((e) => [e.id, e.title])
  );

  // 历史快照内容不变
  const v1 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v1.json.version.eventCount, 1);
  const v2 = await call('GET', '/api/public/versions/2', { token: null });
  assert.strictEqual(v2.json.version.eventCount, 2);
});

test('既有版本查询响应保持兼容：公开版本 JSON 不暴露 identity 字段', async () => {
  const a = await makeEvent('甲');
  const b = await makeEvent('乙');
  const ca = await makeClaim(a, year(1958, '出处甲'));
  const cb = await makeClaim(b, year(1959, '出处乙'));
  await makeRel(a, b, '关系出处');
  await publish([{ eventId: a, claimId: ca }, { eventId: b, claimId: cb }], 0);

  const v = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v.status, 200);
  assert.ok(!('identity' in v.json.version.events[0]));
  assert.deepStrictEqual(Object.keys(v.json.version.events[0]).sort(), [
    'claimId', 'claimNote', 'dateLabel', 'description', 'eventId',
    'intervalEnd', 'intervalStart', 'precision', 'resolvedDate', 'source', 'title',
  ]);
  assert.deepStrictEqual(Object.keys(v.json.version.relations[0]).sort(), [
    'earlierEventId', 'laterEventId', 'note', 'relationId', 'source',
  ]);
});
