'use strict';

const express = require('express');
const db = require('./db');
const { replay } = require('./replay');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const BACKSTAGE = '后台';

/* ---------- 读取全量状态（含重放结果） ---------- */

function readData() {
  const locations = db
    .prepare('SELECT name, unlimited FROM locations ORDER BY unlimited DESC, rowid')
    .all()
    .map((l) => ({ name: l.name, unlimited: !!l.unlimited }));

  const props = db.prepare('SELECT name, location FROM props ORDER BY rowid').all();

  const trStmt = db.prepare(
    'SELECT prop, from_loc, to_loc FROM transfers WHERE cue_number = ? ORDER BY id'
  );
  const cues = db
    .prepare('SELECT number, note FROM cues ORDER BY number')
    .all()
    .map((c) => ({
      number: c.number,
      note: c.note,
      transfers: trStmt.all(c.number).map((t) => ({ prop: t.prop, from: t.from_loc, to: t.to_loc })),
    }));

  return { locations, props, cues };
}

function loadState() {
  const { locations, props, cues } = readData();
  return { locations, props, cues, replay: replay(locations, props, cues) };
}

function ok(res) {
  res.json(loadState());
}

function bad(res, msg, code = 400) {
  res.status(code).json({ error: msg });
}

/* ---------- 查询 ---------- */

app.get('/api/state', (req, res) => ok(res));

/* ---------- 区位 ---------- */

app.post('/api/locations', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return bad(res, '区位名称不能为空');
  if (db.prepare('SELECT 1 FROM locations WHERE name = ?').get(name))
    return bad(res, `区位「${name}」已存在`, 409);
  db.prepare('INSERT INTO locations (name, unlimited) VALUES (?, 0)').run(name);
  ok(res);
});

app.delete('/api/locations/:name', (req, res) => {
  const name = req.params.name;
  if (name === BACKSTAGE) return bad(res, '「后台」是固有区位，不能删除');
  if (!db.prepare('SELECT 1 FROM locations WHERE name = ?').get(name))
    return bad(res, `区位「${name}」不存在`, 404);
  if (db.prepare('SELECT 1 FROM props WHERE location = ?').get(name))
    return bad(res, `区位「${name}」仍放有道具，无法删除`, 409);
  if (
    db.prepare('SELECT 1 FROM transfers WHERE from_loc = ? OR to_loc = ?').get(name, name)
  )
    return bad(res, `区位「${name}」仍被提示中的转移引用，无法删除`, 409);
  db.prepare('DELETE FROM locations WHERE name = ?').run(name);
  ok(res);
});

/* ---------- 道具 ---------- */

function checkInitialCapacity(location, excludeProp) {
  const loc = db.prepare('SELECT unlimited FROM locations WHERE name = ?').get(location);
  if (!loc) return `区位「${location}」不存在`;
  if (loc.unlimited) return null;
  const row = excludeProp
    ? db.prepare('SELECT name FROM props WHERE location = ? AND name != ?').get(location, excludeProp)
    : db.prepare('SELECT name FROM props WHERE location = ?').get(location);
  if (row) return `区位「${location}」初始只能放置一件道具（已放置「${row.name}」）`;
  return null;
}

app.post('/api/props', (req, res) => {
  const name = String(req.body.name || '').trim();
  const location = String(req.body.location || '').trim();
  if (!name) return bad(res, '道具名称不能为空');
  if (!location) return bad(res, '请选择初始区位');
  if (db.prepare('SELECT 1 FROM props WHERE name = ?').get(name))
    return bad(res, `道具「${name}」已存在`, 409);
  const capErr = checkInitialCapacity(location, null);
  if (capErr) return bad(res, capErr, 409);
  db.prepare('INSERT INTO props (name, location) VALUES (?, ?)').run(name, location);
  ok(res);
});

app.put('/api/props/:name', (req, res) => {
  const name = req.params.name;
  const location = String(req.body.location || '').trim();
  if (!db.prepare('SELECT 1 FROM props WHERE name = ?').get(name))
    return bad(res, `道具「${name}」不存在`, 404);
  const capErr = checkInitialCapacity(location, name);
  if (capErr) return bad(res, capErr, 409);
  db.prepare('UPDATE props SET location = ? WHERE name = ?').run(location, name);
  ok(res);
});

app.delete('/api/props/:name', (req, res) => {
  const name = req.params.name;
  if (!db.prepare('SELECT 1 FROM props WHERE name = ?').get(name))
    return bad(res, `道具「${name}」不存在`, 404);
  // 引用该道具的转移保留，重放时会明确提示「道具不存在」，便于舞台监督核对
  db.prepare('DELETE FROM props WHERE name = ?').run(name);
  ok(res);
});

/* ---------- 提示（一组同时发生的转移） ---------- */

function validateCuePayload(body) {
  const number = Number(body.number);
  if (!Number.isInteger(number) || number <= 0)
    return { err: '提示号必须是正整数' };
  const note = String(body.note || '').trim();
  const transfers = Array.isArray(body.transfers) ? body.transfers : [];
  if (transfers.length === 0) return { err: '每组提示至少需要一条转移' };

  const seenProps = new Set();
  for (const t of transfers) {
    const prop = String(t.prop || '').trim();
    const from = String(t.from || '').trim();
    const to = String(t.to || '').trim();
    if (!prop || !from || !to) return { err: '每条转移都要选择道具、来源区位和目标区位' };
    if (from === to) return { err: `道具「${prop}」的来源与目标区位相同，不是有效转移` };
    if (seenProps.has(prop)) return { err: `道具「${prop}」在同组中最多只能转移一次` };
    seenProps.add(prop);
    if (!db.prepare('SELECT 1 FROM props WHERE name = ?').get(prop))
      return { err: `道具「${prop}」不存在` };
    if (!db.prepare('SELECT 1 FROM locations WHERE name = ?').get(from))
      return { err: `来源区位「${from}」不存在` };
    if (!db.prepare('SELECT 1 FROM locations WHERE name = ?').get(to))
      return { err: `目标区位「${to}」不存在` };
  }
  return { number, note, transfers: transfers.map((t) => ({
    prop: String(t.prop).trim(), from: String(t.from).trim(), to: String(t.to).trim(),
  })) };
}

app.post('/api/cues', (req, res) => {
  const v = validateCuePayload(req.body);
  if (v.err) return bad(res, v.err);
  if (db.prepare('SELECT 1 FROM cues WHERE number = ?').get(v.number))
    return bad(res, `提示号 ${v.number} 已存在，提示号必须唯一`, 409);

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO cues (number, note) VALUES (?, ?)').run(v.number, v.note);
    const ins = db.prepare(
      'INSERT INTO transfers (cue_number, prop, from_loc, to_loc) VALUES (?, ?, ?, ?)'
    );
    for (const t of v.transfers) ins.run(v.number, t.prop, t.from, t.to);
  });
  tx();
  ok(res);
});

app.put('/api/cues/:number', (req, res) => {
  const number = Number(req.params.number);
  if (!db.prepare('SELECT 1 FROM cues WHERE number = ?').get(number))
    return bad(res, `提示号 ${number} 不存在`, 404);
  const v = validateCuePayload({ ...req.body, number });
  if (v.err) return bad(res, v.err);

  const tx = db.transaction(() => {
    db.prepare('UPDATE cues SET note = ? WHERE number = ?').run(v.note, number);
    db.prepare('DELETE FROM transfers WHERE cue_number = ?').run(number);
    const ins = db.prepare(
      'INSERT INTO transfers (cue_number, prop, from_loc, to_loc) VALUES (?, ?, ?, ?)'
    );
    for (const t of v.transfers) ins.run(number, t.prop, t.from, t.to);
  });
  tx();
  ok(res);
});

app.delete('/api/cues/:number', (req, res) => {
  const number = Number(req.params.number);
  if (!db.prepare('SELECT 1 FROM cues WHERE number = ?').get(number))
    return bad(res, `提示号 ${number} 不存在`, 404);
  db.prepare('DELETE FROM cues WHERE number = ?').run(number); // 转移级联删除
  ok(res);
});

/* ---------- 试排预览（仅内存重放，不写库） ---------- */

app.post('/api/cues/preview', (req, res) => {
  // 与保存一致的字段校验，草稿不合法时返回具体错误
  const v = validateCuePayload(req.body);
  if (v.err) return bad(res, v.err);

  const { locations, props, cues } = readData();

  // 内存中的假设序列：同号替换，否则按提示号插入，全程不写库
  const draft = { number: v.number, note: v.note, transfers: v.transfers };
  const hypothetical = cues.filter((c) => c.number !== v.number);
  hypothetical.push(draft);
  hypothetical.sort((a, b) => a.number - b.number);

  const before = replay(locations, props, cues);
  const after = replay(locations, props, hypothetical);

  // 对比两条序列的重放结果，找出生效状态（或冲突原因）发生变化的提示
  const beforeByNum = new Map(before.results.map((r) => [r.number, r]));
  const afterByNum = new Map(after.results.map((r) => [r.number, r]));
  const numbers = [...new Set([...beforeByNum.keys(), ...afterByNum.keys()])].sort((a, b) => a - b);

  const cueChanges = [];
  for (const n of numbers) {
    const b = beforeByNum.get(n) || null;
    const a = afterByNum.get(n) || null;
    const same = b && a && b.ok === a.ok && JSON.stringify(b.errors) === JSON.stringify(a.errors);
    if (same) continue;
    cueChanges.push({
      number: n,
      note: (a || b).note,
      isDraft: n === v.number,
      before: b ? { ok: b.ok, errors: b.errors } : null,
      after: a ? { ok: a.ok, errors: a.errors } : null,
    });
  }

  // 对比最终区位，列出发生变化的道具
  const propChanges = [];
  for (const p of props) {
    const bLoc = before.finalState[p.name];
    const aLoc = after.finalState[p.name];
    if (bLoc !== aLoc) propChanges.push({ prop: p.name, before: bLoc, after: aLoc });
  }

  res.json({ draft: { number: v.number, note: v.note }, cueChanges, propChanges });
});

/* ---------- 启动 ---------- */

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`舞台换景排练系统已启动: http://localhost:${PORT}`);
});
