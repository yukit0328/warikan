// 経費精算（keihi.html）の動作テスト。お試しモード（#trial）で画面を開き、データを入れて確かめる。
// 使い方: npm i playwright && npx playwright install chromium && node tests/run.js
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'keihi.html'), 'utf8');
// テスト用に、中の関数を window.__t から呼べるようにしたページを作る
const HOOK = `window.__t={applyConsultAnswers, applyPostAnswers, applyAiResults, ex:()=>expenses, ev:()=>evidence, st:()=>statements, notices, goTab, setListKind, openEdit, store:()=>store, todoSay, waitingFor, suggestOf, stDecide, linkedIds, dayContext, openNotes, renderClose, closeBlockers, exportable, tabTrail:()=>tabTrail};\n`;
const i = SRC.lastIndexOf('</script>');
const PAGE = SRC.slice(0, i) + HOOK + SRC.slice(i);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const ok = (v, m) => { if (!v) throw new Error(m); };

async function open(b, data) {
  const ctx = await b.newContext({ viewport: { width: 400, height: 860 } });
  const p = await ctx.newPage(); p.errs = []; p.dialogs = [];
  p.on('pageerror', e => p.errs.push(e.message));
  p.on('dialog', d => { p.dialogs.push(d.message()); d.accept(); });
  await ctx.route('https://example.test/**', r => r.fulfill({ contentType: 'text/html', body: PAGE }));
  await ctx.route(/cdnjs|gstatic|googleapis/, r => r.abort());
  await p.goto('https://example.test/keihi.html#trial');
  await p.evaluate(d => localStorage.setItem('keihi-trial', JSON.stringify(d)), data);
  await p.reload(); await p.waitForTimeout(700);
  return p;
}
const ex = (p, id) => p.evaluate(id => __t.ex().find(e => e.id === id), id);

test('科目が空・レシートなしでも申請でき、承認で科目が入る', async b => {
  const p = await open(b, { expenses: { a: { date: '2026-11-01', amount: 3300, vendor: 'TRIBE', status: 'draft', fromStatement: 's1', payMethod: '個人カード' } } });
  await p.evaluate(() => __t.openEdit('a')); await p.waitForTimeout(200);
  await p.click('#eSaveDone'); await p.waitForTimeout(600);
  let a = await ex(p, 'a'); eq([a.status, a.rcLater], ['applied', true], '申請');
  await p.evaluate(() => __t.applyConsultAnswers([{ id: 'x', by: 'ベテランくん', text: 'ok', expenseId: 'a', verdict: 'approve', cat: '会議費' }])); await p.waitForTimeout(500);
  a = await ex(p, 'a'); eq([a.status, a.category], ['done', '会議費'], '承認');
  return p;
});

test('あとで撮ったレシートが待っている経費にひも付き、確認待ちになる', async b => {
  const p = await open(b, { expenses: { a: { date: '2026-11-01', amount: 3300, vendor: 'TRIBE', status: 'done', rcLater: true, category: '会議費', payMethod: '個人カード' }, r: { date: '2026-11-02', amount: 0, status: 'reading' } },
    evidence: { v: { expenseId: 'r', kind: 'photo', fileId: 'F', name: 'r.jpg' } } });
  await p.evaluate(() => __t.applyAiResults([{ id: 'ai', expenseId: 'r', amount: 3300, date: '2026-11-02', vendor: 'TRIBE' }])); await p.waitForTimeout(800);
  const a = await ex(p, 'a'), r = await ex(p, 'r');
  eq([a.rcLater, a.linkCheck, r.deleted, r.linkedTo], [undefined, true, true, 'a'], 'ひも付け');
  return p;
});

test('まとめて申請は続けて押しても1回だけ', async b => {
  const p = await open(b, { expenses: { a: { date: '2026-11-01', amount: 100, vendor: 'x', status: 'draft', payMethod: '個人カード' } } });
  await p.evaluate(() => { __t.goTab('list'); __t.setListKind('biz'); }); await p.waitForTimeout(200);
  await p.evaluate(() => { const b = document.getElementById('fBulk'); b.click(); b.click(); }); await p.waitForTimeout(800);
  const raw = await p.evaluate(() => JSON.parse(localStorage.getItem('keihi-trial')));
  eq(Object.values(raw.consult).filter(c => c.by === 'Yuki').length, 1, '申請の数');
  return p;
});

test('ひとことメモが明細に合い、目的に入る', async b => {
  const p = await open(b, { statements: { s1: { source: '個人カード', date: '2026-11-08', amount: 380, desc: 'LUUP', decision: '' }, s2: { source: '個人カード', date: '2026-11-12', amount: 380, desc: 'LUUP', decision: '' } } });
  await p.evaluate(() => __t.openNotes()); await p.fill('#nDate', '2026-11-08'); await p.fill('#nText', '今日のluupは事業用'); await p.click('#nSave'); await p.waitForTimeout(400);
  const d = await p.evaluate(() => __t.st().map(x => __t.suggestOf(x, __t.linkedIds()).d));
  eq(d, ['biz', ''], '提案');
  await p.evaluate(async () => __t.stDecide(__t.st()[0], 'biz', '')); await p.waitForTimeout(400);
  eq((await ex(p, 'st-s1')).purpose, '今日のluupは事業用', '目的');
  return p;
});

test('月締め：やり残しがあると締められず、締めた月だけCSVに出て、直せない', async b => {
  const p = await open(b, { expenses: {
    a: { date: '2026-10-05', amount: 1000, vendor: 'A', status: 'done', category: '会議費', payMethod: '個人カード', noReceipt: true, noReceiptWhy: 'x' },
    b: { date: '2026-10-06', amount: 2000, vendor: 'B', status: 'done', category: '会議費', payMethod: '個人カード', rcLater: true } } });
  await p.evaluate(() => { __t.goTab('export'); }); await p.fill('#cMonth', '2026-10'); await p.evaluate(() => __t.renderClose());
  ok(await p.$('#cClose') === null, 'レシート待ちがあるのに締めボタンが出た');
  eq(await p.evaluate(() => __t.exportable('', '', false).length), 0, '締める前のCSV');
  // レシート待ちを片付ける（領収書なしにする）
  await p.evaluate(async () => { const s = __t.store(); const e = __t.ex().find(x => x.id === 'b'); const { id, ...r } = e; await s.setExpense('b', { ...r, rcLater: false, noReceipt: true, noReceiptWhy: 'y' }); }); await p.waitForTimeout(300);
  await p.evaluate(() => __t.renderClose()); await p.click('#cClose'); await p.waitForTimeout(400);
  eq(await p.evaluate(() => __t.exportable('', '', false).length), 2, '締めた後のCSV');
  await p.evaluate(() => __t.openEdit('a')); await p.waitForTimeout(200); await p.fill('#eAmount', '1200'); await p.click('#eSaveDraft'); await p.waitForTimeout(400);
  eq((await ex(p, 'a')).amount, 1000, '締めた月は直せない');
  return p;
});

test('お知らせから検索に移ったら、戻るでお知らせに戻る', async b => {
  const p = await open(b, { expenses: { a: { date: '2026-11-01', amount: 100, vendor: 'x', status: 'done', rcLater: true, category: '会議費', payMethod: '個人カード' } } });
  await p.click('#tabs button[data-t="bell"]'); await p.waitForTimeout(200);
  await p.click('#t-bell .todo[data-act="flag:later"]'); await p.waitForTimeout(200);
  ok(!(await p.$eval('#t-list', el => el.classList.contains('hidden'))), '検索に移っていない');
  await p.goBack(); await p.waitForTimeout(400);
  ok(!(await p.$eval('#t-bell', el => el.classList.contains('hidden'))), 'お知らせに戻っていない');
  await p.goBack(); await p.waitForTimeout(400);
  ok(!(await p.$eval('#t-home', el => el.classList.contains('hidden'))), 'その次はホーム');
  return p;
});

test('相談タブ：開いたあと「未読の答えがある」に切り替えても未読が残る', async b => {
  const now = Date.now();
  const p = await open(b, { expenses: { a: { date: '2026-11-01', amount: 100, vendor: 'x', status: 'draft' } },
    consult: { c1: { expenseId: 'a', by: 'Yuki', text: 'q', at: now - 2000 }, c2: { expenseId: 'a', by: 'ベテランくん', text: 'ans', at: now - 1000 } } });
  await p.click('#tabs button[data-t="consult"]'); await p.waitForTimeout(200);
  ok(await p.$('#cList .dmrow.unread'), '開いた直後に未読の印がない');
  await p.selectOption('#cShow', 'unread'); await p.waitForTimeout(200);
  eq(await p.$$eval('#cList .dmrow', l => l.length), 1, '未読の絞り込み');
  return p;
});

test('家計簿：取り込んだ明細が未仕分けなら知らせ、仕分けを開ける', async b => {
  const p = await open(b, { statements: { s1: { source: 'JCB', date: '2026-11-03', amount: 500, desc: 'セブンイレブン', decision: '' }, s2: { source: 'JCB', date: '2026-11-04', amount: 900, desc: 'ドラッグストア', decision: 'private', household: '日用品' } } });
  await p.evaluate(() => { __t.goTab('list'); __t.setListKind('kakei'); }); await p.waitForTimeout(200);
  ok(await p.$('#fToSort'), '未仕分けの知らせがない');
  eq(await p.$$eval('#list .exp', l => l.length), 1, '私用に決めた行は出る');
  ok(await p.$eval('#fPay', s => [...s.options].some(o => o.value === 'JCB')), '支払方法にJCBがない');
  await p.click('#fToSort'); await p.waitForTimeout(200);
  ok(await p.$eval('#t-sort', el => !el.classList.contains('hidden')), '仕分けが開かない');
  return p;
});

test('検索：未仕分けの明細だけ・ぜんぶにも出る', async b => {
  const p = await open(b, { expenses: { a: { date: '2026-11-01', amount: 100, vendor: 'x', status: 'draft' } }, statements: { s1: { source: 'JCB', date: '2026-11-03', amount: 500, desc: 'セブンイレブン', decision: '' }, s2: { source: 'JCB', date: '2026-11-04', amount: 900, desc: 'ドラッグストア', decision: 'private' } } });
  await p.evaluate(() => { __t.goTab('list'); __t.setListKind('todo'); }); await p.waitForTimeout(200);
  eq(await p.$$eval('#list .exp', l => l.map(x => x.dataset.id)), ['s1'], '未仕分け');
  await p.evaluate(() => __t.setListKind('all')); await p.waitForTimeout(200);
  eq(await p.$$eval('#list .exp', l => l.map(x => x.dataset.id).sort()), ['a', 's1', 's2'], 'ぜんぶ');
  await p.evaluate(() => __t.setListKind('todo')); await p.click('#list .exp'); await p.waitForTimeout(200);
  eq(await p.$$eval('#mList .st', l => l.map(x => x.dataset.id)), ['s1'], '押すとその1行だけ');
  ok(await p.$('#mOneOff'), 'ほかも見るボタン');
  await p.click('#mOneOff'); await p.waitForTimeout(200);
  ok((await p.$$('#mList .st')).length >= 1, 'ほかの明細');
  return p;
});

test('検索：期間の「から」だけ入れるとその日だけ。条件はたためる', async b => {
  const p = await open(b, { expenses: { a: { date: '2026-09-04', amount: 100, vendor: 'x', status: 'draft' }, c: { date: '2026-09-05', amount: 200, vendor: 'y', status: 'draft' } } });
  await p.evaluate(() => { __t.goTab('list'); __t.setListKind('biz'); }); await p.waitForTimeout(200);
  await p.fill('#fFrom', '2026-09-04'); await p.dispatchEvent('#fFrom', 'change'); await p.waitForTimeout(200);
  eq(await p.$eval('#fTo', el => el.value), '2026-09-04', 'まで');
  eq(await p.$$eval('#list .exp', l => l.map(x => x.dataset.id)), ['a'], 'その日だけ');
  await p.click('#fFold'); await p.waitForTimeout(100);
  ok(await p.$eval('#fBody', el => el.classList.contains('hidden')), 'たためない');
  ok((await p.textContent('#fSummary')).includes('09/04だけ'), '条件の1行');
  return p;
});

(async () => {
  const b = await chromium.launch(); let bad = 0;
  for (const t of tests) {
    let p;
    try { p = await t.fn(b); if (p.errs.length) throw new Error('ページのエラー: ' + p.errs.join(' | ')); console.log('ok  ', t.name); }
    catch (e) { bad++; console.log('NG  ', t.name, '\n     ', e.message); }
    finally { await p?.context().close().catch(() => {}); }
  }
  await b.close();
  console.log(bad ? `${bad}件 失敗` : `全${tests.length}件 ok`); process.exit(bad ? 1 : 0);
})();
