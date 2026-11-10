// 経費精算（keihi.html）の動作テスト。お試しモード（#trial）で画面を開き、データを入れて確かめる。
// 使い方: npm i playwright && npx playwright install chromium && node tests/run.js
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'keihi.html'), 'utf8');
// テスト用に、中の関数を window.__t から呼べるようにしたページを作る
const HOOK = `window.__t={applyConsultAnswers, applyPostAnswers, applyAiResults, ex:()=>expenses, ev:()=>evidence, st:()=>statements, notices, goTab, setListKind, openEdit, store:()=>store, todoSay, waitingFor, suggestOf, stDecide, linkedIds, dayContext, openNotes, renderClose, closeBlockers, exportable, tabTrail:()=>tabTrail, openProfile, renderFix, consult:()=>consult, journalOf, ledgerOf, applyMailInbox, orderFor};\n`;
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

test('差し戻されたまま直していない下書きは、まとめて申請に入れない（直して保存すれば入る）', async b => {
  const p = await open(b, { expenses: { a: { date: '2026-11-01', amount: 100, vendor: 'x', status: 'draft', payMethod: '個人カード', noticeK: 'reject', noticeAt: Date.now() }, c: { date: '2026-11-02', amount: 200, vendor: 'y', status: 'draft', payMethod: '個人カード' } } });
  await p.evaluate(() => { __t.goTab('list'); __t.setListKind('biz'); }); await p.waitForTimeout(200);
  ok((await p.$eval('#fBulk', b => b.textContent)).includes('1件'), 'まとめて申請に差し戻しが入っている');
  ok((await p.$eval('#sumline', el => el.textContent)).includes('差し戻された 1件'), '差し戻しの案内がない');
  await p.evaluate(() => __t.openEdit('a')); await p.waitForTimeout(200);
  await p.click('#eSaveDraft'); await p.waitForTimeout(400);
  eq((await ex(p, 'a')).noticeK, 'fixed', '直して保存した印');
  await p.evaluate(() => __t.goTab('list')); await p.waitForTimeout(200);
  ok((await p.$eval('#fBulk', b => b.textContent)).includes('2件'), '直したものはまとめて申請に戻る');
  return p;
});

test('差し戻しをまとめて直す：目的をまとめて入れ、直した分だけ申請し直す', async b => {
  const now = Date.now();
  const p = await open(b, { expenses: { a: { date: '2026-11-01', amount: 100, vendor: 'カフェA', category: '会議費', status: 'draft', payMethod: '個人カード', noticeK: 'reject', noticeAt: now }, c: { date: '2026-11-02', amount: 200, vendor: 'カフェB', category: '会議費', status: 'draft', payMethod: '個人カード', noticeK: 'reject', noticeAt: now }, d: { date: '2026-11-03', amount: 300, vendor: 'カフェC', category: '会議費', status: 'draft', payMethod: '個人カード', noticeK: 'reject', noticeAt: now, purpose: '元の目的' } },
    consult: { k1: { expenseId: 'a', by: 'ベテランくん', text: '【差し戻し】目的と同席者を書いてください', at: now } } });
  await p.evaluate(() => { __t.goTab('list'); __t.setListKind('biz'); }); await p.waitForTimeout(200);
  await p.click('#fFix'); await p.waitForTimeout(200);
  eq(await p.$$eval('#xList .xrow', l => l.length), 3, '差し戻しが並ぶ');
  ok((await p.$eval('#xList', el => el.textContent)).includes('目的と同席者を書いてください'), '理由が出ない');
  await p.fill('#xAllP', '打合せ'); await p.click('#xAllPBtn'); await p.waitForTimeout(200);
  eq(await p.$eval('#xCount', el => el.textContent), '直した 2件', '空の目的だけ埋まる');
  await p.click('#xSend'); await p.waitForTimeout(800);
  eq([(await ex(p, 'a')).status, (await ex(p, 'c')).status, (await ex(p, 'd')).status], ['applied', 'applied', 'draft'], '直した分だけ申請');
  eq((await ex(p, 'a')).purpose, '打合せ', '目的が入る');
  eq(await p.$$eval('#xList .xrow', l => l.length), 1, '残りは1件');
  return p;
});

test('お試しモード：申請中をまとめて承認済みにできる', async b => {
  const p = await open(b, { expenses: { a: { date: '2026-09-03', amount: 1100, vendor: 'x', category: '会議費', status: 'applied', payMethod: '個人カード' } } });
  await p.evaluate(() => { __t.goTab('list'); __t.setListKind('biz'); }); await p.waitForTimeout(200);
  await p.click('#fTrialOk'); await p.waitForTimeout(400);
  eq((await ex(p, 'a')).status, 'done', '承認済み');
  return p;
});

test('差し戻しをまとめて直す：1件ずつ保存・申請し直しができ、同じ内容のままなら押せない', async b => {
  const now = Date.now();
  const p = await open(b, { expenses: { a: { date: '2026-11-01', amount: 100, vendor: 'カフェA', category: '会議費', status: 'draft', payMethod: '個人カード', noticeK: 'reject', noticeAt: now, purpose: '前の目的' }, c: { date: '2026-11-02', amount: 200, vendor: 'カフェB', category: '会議費', status: 'draft', payMethod: '個人カード', noticeK: 'reject', noticeAt: now } } });
  await p.evaluate(() => __t.goTab('fix')); await p.waitForTimeout(200);
  const row = id => `#xList .xrow[data-id="${id}"]`;
  ok(await p.$eval(row('a') + ' .x-send', el => el.disabled), '同じ内容のままでは申請し直せない');
  await p.fill(row('a') + ' .x-p', '新しい目的'); await p.waitForTimeout(100);
  await p.click(row('a') + ' .x-save'); await p.waitForTimeout(400);
  const a = await ex(p, 'a'); eq([a.purpose, a.status, a.noticeK, a.fixSaved], ['新しい目的', 'draft', 'reject', true], '保存だけ（画面に残る）');
  eq(await p.$$eval('#xList .xrow', l => l.length), 2, 'まだ2件並ぶ');
  ok(!(await p.$eval(row('a') + ' .x-send', el => el.disabled)), '保存したら申請し直せる');
  eq(await p.$eval('#xCount', el => el.textContent), '直した 1件', '保存した分が数に入る');
  await p.click(row('a') + ' .x-send'); await p.waitForTimeout(500);
  const a2 = await ex(p, 'a'); eq([a2.status, a2.fixSaved], ['applied', undefined], '1件だけ申請し直し');
  eq((await ex(p, 'c')).status, 'draft', 'ほかはそのまま');
  eq(await p.$$eval('#xList .xrow', l => l.length), 1, '残り1件');
  return p;
});

test('お試しモード：9月のダミーを入れられる', async b => {
  const p = await open(b, { expenses: {} });
  await p.evaluate(() => { __t.goTab('list'); __t.setListKind('biz'); }); await p.waitForTimeout(200);
  await p.click('#fTrialSeed'); await p.waitForTimeout(400);
  const l = await p.evaluate(() => __t.ex());
  eq(l.length, 5, '5件'); ok(l.every(e => e.date.startsWith('2026-09') && e.status === 'draft' && e.category && e.payMethod), '9月の下書き');
  eq(await p.$('#fTrialSeed'), null, '入れたらボタンは消える');
  ok(await p.$('#fBulk'), 'まとめて申請できる');
  return p;
});

test('年の集計：承認済みを決算書の欄の順に、按分後で合計する', async b => {
  const p = await open(b, { expenses: {
    a: { date: '2026-09-04', amount: 1000, category: '会議費', status: 'done', payMethod: '現金' },
    c: { date: '2026-09-18', amount: 6600, category: '通信費', ratio: 50, status: 'done', payMethod: '現金' },
    d: { date: '2026-10-01', amount: 500, category: '雑費', status: 'done', payMethod: '現金' },
    f: { date: '2026-10-02', amount: 900, category: '通信費', status: 'draft', payMethod: '現金' },
    g: { date: '2025-12-31', amount: 777, category: '通信費', status: 'done', payMethod: '現金' } } });
  await p.evaluate(() => __t.goTab('export')); await p.waitForTimeout(200);
  await p.selectOption('#yYear', '2026'); await p.dispatchEvent('#yYear', 'input'); await p.waitForTimeout(100);
  const rows = await p.$$eval('#yBody tr', l => l.slice(1).map(r => [...r.cells].map(c => c.textContent)));
  eq(rows.map(r => [r[0], r[1], r[4]]), [['⑫', '通信費', '3,300円'], ['㉕', '会議費', '1,000円'], ['㉛', '雑費', '500円'], ['', '経費の合計', '4,800円']], '欄の順と按分後');
  ok((await p.textContent('#yWarn')).includes('承認済みでない経費が 1件'), '下書きの注意');
  return p;
});

test('資産：減価償却費は処理のしかたが要り、使い始めた日は後から保存できる', async b => {
  const p = await open(b, { expenses: { a: { date: '2026-11-09', amount: 450000, vendor: 'FMV Store', item: 'ノートPC', status: 'draft', payMethod: '個人カード', noReceipt: true, noReceiptWhy: 'メール待ち' } } });
  await p.evaluate(() => __t.openEdit('a')); await p.waitForTimeout(200);
  ok(await p.isVisible('#eAssetHint'), '10万円以上で案内');
  await p.selectOption('#eCat', '減価償却費'); await p.dispatchEvent('#eCat', 'change');
  ok(await p.isVisible('#eAssetBox') && !(await p.isVisible('#eAssetHint')), '資産の欄が出る');
  await p.click('#eSaveDone'); await p.waitForTimeout(400);
  eq((await ex(p, 'a')).status, 'draft', '処理のしかたが空なら申請できない');
  await p.selectOption('#eAssetKind', 'small'); await p.click('#eSaveDone'); await p.waitForTimeout(400);
  eq((await ex(p, 'a')).status, 'draft', '40万円以上は少額にできない');
  await p.fill('#eAmount', '385110'); await p.click('#eSaveDone'); await p.waitForTimeout(600);
  let a = await ex(p, 'a'); eq([a.status, a.assetKind, a.useDate], ['applied', 'small', undefined], '使い始めた日が空でも申請できる');
  await p.evaluate(() => __t.openEdit('a')); await p.waitForTimeout(200);
  await p.fill('#eUseDate', '2026-11-28'); await p.click('#eUseSave'); await p.waitForTimeout(400);
  a = await ex(p, 'a'); eq([a.status, a.useDate], ['applied', '2026-11-28'], '使い始めた日だけ保存');
  const raw = await p.evaluate(() => JSON.parse(localStorage.getItem('keihi-trial')));
  ok(Object.values(raw.history || {}).some(h => h.after?.useDate === '2026-11-28'), '履歴に残る');
  ok(await p.evaluate(() => [...document.querySelectorAll('#eCat option')].some(o => o.value === '支払手数料')), '支払手数料も選べる');
  return p;
});

test('資産：少額の上限は取得日で決まる（2026/4/1より前は30万円未満）', async b => {
  const p = await open(b, { expenses: { a: { date: '2026-03-20', amount: 350000, vendor: 'X', status: 'draft', payMethod: '個人カード', noReceipt: true, noReceiptWhy: 'test', category: '減価償却費', assetKind: 'small' } } });
  await p.evaluate(() => __t.openEdit('a')); await p.waitForTimeout(200);
  await p.click('#eSaveDone'); await p.waitForTimeout(400);
  eq((await ex(p, 'a')).status, 'draft', '3月取得なら35万円は少額にできない');
  await p.fill('#eAcqDate', '2026-04-02'); await p.click('#eSaveDone'); await p.waitForTimeout(600);
  const a = await ex(p, 'a'); eq([a.status, a.acqDate], ['applied', '2026-04-02'], '4/2に受け取ったなら40万円未満でよい');
  return p;
});

test('相談の答えの「入れる案」を押すと目的・科目が入り、下書きなら申請される', async b => {
  const p = await open(b, { expenses: { a: { date: '2026-11-01', amount: 6600, vendor: 'TRIBE', status: 'draft', payMethod: '個人カード', noReceipt: true, noReceiptWhy: 'カード明細', noticeK: 'reject' } } });
  await p.evaluate(() => __t.applyConsultAnswers([{ id: 'x1', by: 'ベテランくん', text: '目的を書けば承認します', expenseId: 'a', fix: { purpose: '町田さんと2名。事業の相談', category: '会議費', bogus: 'x' } }])); await p.waitForTimeout(400);
  await p.evaluate(() => __t.openEdit('a')); await p.waitForTimeout(200);
  const btn = await p.$('#eConsult [data-fix]'); ok(btn, '案のボタン');
  ok((await p.textContent('#eConsult')).includes('目的「町田さんと2名。事業の相談」・科目「会議費」'), '案の中身');
  await btn.click(); await p.waitForTimeout(600);
  const a = await ex(p, 'a'); eq([a.purpose, a.category, a.status], ['町田さんと2名。事業の相談', '会議費', 'applied'], '入って申請');
  ok((await p.textContent('#eConsult')).includes('入れ済み'), '入れ済み');
  return p;
});

test('売上：入金を入れると損益・貸借対照表・消費税のめやすが出る', async b => {
  const p = await open(b, { expenses: { a: { date: '2026-09-04', amount: 11000, category: '会議費', status: 'done', payMethod: '現金' } } });
  await p.evaluate(() => __t.goTab('export')); await p.waitForTimeout(200);
  await p.selectOption('#yYear', '2026'); await p.dispatchEvent('#yYear', 'input');
  await p.fill('#sDate', '2026-09-30'); await p.fill('#sClient', 'A社'); await p.fill('#sAmount', '550000'); await p.click('#sAdd'); await p.waitForTimeout(400);
  const pl = await p.$$eval('#yPl tr', l => l.map(r => r.cells[1].textContent));
  eq(pl, ['550,000円', '11,000円', '539,000円'], '損益');
  ok((await p.textContent('#yMonths')).includes('550,000円'), '月別');
  const bs = await p.$$eval('#yBs tr', l => l.slice(-1)[0].textContent);
  ok(bs.split('550,000円').length === 3, '貸借が合う: ' + bs);
  // 550,000 → 税抜500,000 → 消費税39,000 → 2割 7,800 → 地方 2,200 → 計10,000
  eq(await p.$$eval('#yTax tr', l => l.map(r => r.cells[1].textContent)), ['500,000円', '39,000円', '7,800円', '2,200円', '10,000円'], '2割特例のめやす');
  ok((await p.textContent('#sList')).includes('A社'), '一覧');
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

test('取り込み形式：保存した形式の名前と支払方法を直せる（列の割り当てはそのまま）', async b => {
  const v = { name: 'マネーフォワード', pay: '現金', sig: 'a|b', d: { i: 0, name: 'a' }, t: { i: 1, name: 'b' }, o: { i: 2, name: 'c' }, i: null, neg: false };
  const p = await open(b, { settings: { csvVariants: [v] } });
  await p.evaluate(() => __t.goTab('import')); await p.waitForTimeout(200);
  await p.selectOption('#mVar', '0'); await p.waitForTimeout(100);
  ok(await p.isVisible('#mRenVar'), '形式を選ぶと直すボタンが出る');
  const pay = await p.evaluate(() => [...document.querySelectorAll('#mPay option')].map(o => o.value).find(x => x && x !== '現金'));
  await p.selectOption('#mPay', pay);
  await p.evaluate(() => { window.prompt = () => 'JCB'; });
  await p.click('#mRenVar'); await p.waitForTimeout(300);
  const raw = await p.evaluate(() => JSON.parse(localStorage.getItem('keihi-trial')));
  const w = raw.settings.csvVariants;
  eq([w.length, w[0].name, w[0].pay, w[0].sig, w[0].d.i], [1, 'JCB', pay, 'a|b', 0], '名前と支払方法だけ変わる');
  ok(p.dialogs.some(m => m.includes('支払方法も')), '支払方法を変えるときは確かめる');
  return p;
});
test('注文メール：Amazonの注文が明細の行（分けた発送も）に合い、品目が目的の下書きになる', async b => {
  const p = await open(b, { statements: {
    s1: { source: '個人カード', date: '2026-11-03', amount: 3980, desc: 'AMAZON.CO.JP', decision: '' },
    s2: { source: '個人カード', date: '2026-11-05', amount: 1200, desc: 'AMAZON.CO.JP', decision: '' },
    s3: { source: '個人カード', date: '2026-11-08', amount: 800, desc: 'AMAZON.CO.JP', decision: '' },
    s4: { source: '個人カード', date: '2026-11-05', amount: 777, desc: 'AMAZON.CO.JP', decision: '' } } });
  await p.evaluate(() => __t.applyMailInbox([
    { id: 'm1', kind: 'order', card: 'Amazon', orderNo: '250-1', date: '2026-11-02', amount: 3980, desc: 'USBハブ' },
    { id: 'm2', kind: 'order', card: 'Amazon', orderNo: '250-2', date: '2026-11-04', amount: 2000, desc: 'ノート、ペン' },
    { id: 'm3', kind: 'order', card: 'Nanika', orderNo: 'x', date: '2026-11-04', amount: 777, desc: '読み方の表にない' }])); await p.waitForTimeout(400);
  const no = await p.evaluate(() => __t.st().map(x => __t.orderFor(x)?.no || ''));
  eq(no, ['250-1', '250-2', '250-2', ''], '1行・分けた発送・合わない行');
  ok((await p.evaluate(() => __t.st().length)) === 4, '注文メールは明細の行を増やさない');
  await p.evaluate(async () => __t.stDecide(__t.st()[0], 'biz', '消耗品費')); await p.waitForTimeout(400);
  eq((await ex(p, 'st-s1')).purpose, 'Amazon USBハブ', '目的の下書き');
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

test('キャラのページ：直接メッセージを送れ、答えは個別の会話に入る。虫めがねはページの中を探す', async b => {
  const p = await open(b, { expenses: { a: { date: '2026-11-01', amount: 100, vendor: 'タリーズ', status: 'draft' } },
    consult: { c1: { expenseId: 'a', by: 'ベテランくん', text: '会議費でよいです', at: Date.now() - 5000 }, c2: { expenseId: 'a', by: 'ベテランくん', text: '目的を書いてください', at: Date.now() - 4000 } } });
  await p.evaluate(() => __t.openProfile('vet')); await p.waitForTimeout(200);
  await p.click('#fab'); await p.waitForTimeout(100);
  ok(await p.$eval('#t-profile', el => !el.classList.contains('hidden')), '検索に移ってしまった');
  await p.fill('#pfFind input', '目的'); await p.waitForTimeout(100);
  eq(await p.$$eval('#pfBody .todo:not(.fhide)', l => l.length), 1, 'ページの中の絞り込み');
  await p.click('#pfChat'); await p.waitForTimeout(200);
  ok(await p.$eval('#dmFoot', el => !el.classList.contains('hidden')), '送る欄がない');
  await p.fill('#dmText', '家賃の按分はどう考える？'); await p.click('#dmSend'); await p.waitForTimeout(400);
  eq(await p.evaluate(() => __t.consult().filter(c => c.expenseId === 'chat-vet').map(c => c.by)), ['Yuki'], '送った');
  await p.evaluate(() => __t.applyConsultAnswers([{ id: 'q1/ベテランくん', by: 'ベテランくん', expenseId: 'chat-vet', text: '仕事に使う広さの割合で按分します' }, { id: 'q2/経費くん', by: '経費くん', expenseId: 'a', text: 'x' }])); await p.waitForTimeout(400);
  eq(await p.evaluate(() => __t.consult().filter(c => c.expenseId === 'chat-vet').map(c => c.by)), ['Yuki', 'ベテランくん'], '答えが会話に入る');
  eq(await p.evaluate(() => __t.consult().filter(c => c.by === '経費くん').length), 0, '経費くんの答えは個別メッセージだけ');
  return p;
});

test('経費の相談欄に、その経費へのお知らせも出る', async b => {
  const p = await open(b, { expenses: { a: { date: '2026-11-01', amount: 520, vendor: 'タリーズ', status: 'draft', fromStatement: 's1', category: '会議費' } } });
  await p.evaluate(() => __t.openEdit('a')); await p.waitForTimeout(300);
  const t = await p.$eval('#eConsult', el => el.textContent);
  ok(t.includes('経費くん') && t.includes('未対応のお知らせ') && t.includes('レシートがないよ'), 'お知らせが相談欄にない: ' + t.slice(0, 80));
  return p;
});

test('相談でコメントした経費のお知らせは「対応中」になり、未対応から外れる', async b => {
  const now = Date.now();
  const p = await open(b, { expenses: { a: { date: '2026-11-01', amount: 100, vendor: 'x', status: 'draft', noticeK: 'reject', noticeAt: now - 5000 } },
    consult: { k1: { expenseId: 'a', by: 'ベテランくん', text: '【差し戻し】目的を書いて', at: now - 5000 } } });
  eq(await p.evaluate(() => __t.notices().filter(n => n.id === 'a').map(n => n.open)), [true], 'はじめは未対応');
  await p.evaluate(() => __t.openEdit('a')); await p.waitForTimeout(200);
  await p.fill('#eAsk', '打合せです'); await p.click('#eAskBtn'); await p.waitForTimeout(400);
  eq(await p.evaluate(() => __t.notices().filter(n => n.id === 'a').map(n => [n.open, n.doing])), [[false, true]], '対応中');
  await p.evaluate(() => __t.goTab('bell')); await p.waitForTimeout(200);
  ok((await p.$eval('#bList', el => el.textContent)).includes('対応中'), 'お知らせに対応中と出ない');
  return p;
});

test('相談タブ：一覧を開いただけでは既読にならず、会話を開くと既読', async b => {
  const now = Date.now();
  const p = await open(b, { expenses: { a: { date: '2026-11-01', amount: 100, vendor: 'x', status: 'draft' } },
    consult: { c1: { expenseId: 'a', by: 'Yuki', text: 'q', at: now - 2000 }, c2: { expenseId: 'a', by: 'ベテランくん', text: 'ans', at: now - 1000 } } });
  await p.click('#tabs button[data-t="consult"]'); await p.waitForTimeout(200);
  ok(await p.$('#cList .dmrow.unread'), '開いた直後に未読の印がない');
  await p.selectOption('#cShow', 'unread'); await p.waitForTimeout(200);
  eq(await p.$$eval('#cList .dmrow', l => l.length), 1, '未読の絞り込み');
  await p.reload(); await p.waitForTimeout(700);
  await p.click('#tabs button[data-t="consult"]'); await p.waitForTimeout(200);
  ok(await p.$('#cList .dmrow.unread'), '一覧を開いただけで既読になった');
  await p.click('#cList .dmrow'); await p.waitForTimeout(200);
  ok(await p.$('#dmMsgs .cmsg.new'), '会話で新しい答えに枠がない');
  await p.click('#tabs button[data-t="consult"]'); await p.waitForTimeout(200);
  ok(!(await p.$('#cList .dmrow.unread')), '会話を開いたら既読');
  ok(await p.$eval('#cUnread', el => el.classList.contains('hidden')), '未読の数が消えない');
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
  await p.evaluate(() => { __t.goTab('list'); __t.setListKind('todo'); }); await p.reload(); await p.waitForTimeout(700);
  eq(await p.$eval('#fKind button.on', b => b.dataset.k), 'todo', '更新しても未仕分けのまま');
  await p.evaluate(() => __t.setListKind('todo')); await p.click('#list .exp'); await p.waitForTimeout(200);
  eq(await p.$$eval('#mList .st', l => l.map(x => x.dataset.id)), ['s1'], '押すとその1行だけ');
  ok(await p.$('#mOneOff'), 'ほかも見るボタン');
  await p.click('#mOneOff'); await p.waitForTimeout(200);
  ok((await p.$$('#mList .st')).length >= 1, 'ほかの明細');
  return p;
});

test('検索：期間はカレンダーで続けて押す。同じ日2回でその日だけ。条件はたためる', async b => {
  const p = await open(b, { expenses: { a: { date: '2026-09-04', amount: 100, vendor: 'x', status: 'draft' }, c: { date: '2026-09-05', amount: 200, vendor: 'y', status: 'draft' } } });
  await p.evaluate(() => { __t.goTab('list'); __t.setListKind('biz'); }); await p.waitForTimeout(200);
  // カレンダーで「から」「まで」を続けて押す（同じ日を2回でその日だけ）
  const pick = async d => { await p.click('#fRange'); await p.evaluate(() => { for (let i = 0; i < 24 && !document.querySelector('#rgPop [data-d="2026-09-01"]'); i++) document.querySelector('#rgPop [data-mv="' + (document.querySelector('#rgPop [data-d]').dataset.d > '2026-09' ? -1 : 1) + '"]').click(); });
    for (const v of d) await p.click(`#rgPop [data-d="${v}"]`); await p.waitForTimeout(200); };
  await pick(['2026-09-04', '2026-09-05']);
  eq([await p.$eval('#fFrom', el => el.value), await p.$eval('#fTo', el => el.value)], ['2026-09-04', '2026-09-05'], 'から・まで');
  ok(await p.$eval('#rgPop', el => el.classList.contains('hidden')), '2回目で閉じる');
  eq((await p.$$eval('#list .exp', l => l.map(x => x.dataset.id))).sort(), ['a', 'c'], '期間の分');
  ok((await p.textContent('#fRange')).includes('9/4 〜 9/5'), 'ボタンに期間');
  await pick(['2026-09-04', '2026-09-04']);
  eq(await p.$eval('#fTo', el => el.value), '2026-09-04', 'まで');
  eq(await p.$$eval('#list .exp', l => l.map(x => x.dataset.id)), ['a'], 'その日だけ');
  await p.click('#fFold'); await p.waitForTimeout(100);
  ok(await p.$eval('#fBody', el => el.classList.contains('hidden')), 'たためない');
  ok((await p.textContent('#fSummary')).includes('09/04だけ'), '条件の1行');
  return p;
});


test('帳簿：仕訳帳と総勘定元帳が按分後の経費と売上で合い、番号で元に戻れる', async b => {
  const p = await open(b, { expenses: {
    a: { date: '2026-09-04', amount: 1000, category: '会議費', status: 'done', payMethod: '現金' },
    c: { date: '2026-09-18', amount: 6600, category: '通信費', ratio: 50, status: 'done', payMethod: '個人カード' },
    f: { date: '2026-10-02', amount: 900, category: '通信費', status: 'draft', payMethod: '現金' } },
    settings: { sales: [{ id: 'abcd1234', date: '2026-09-30', client: 'A社', amount: 550000 }], opening: { 2026: 0 } } });
  await p.evaluate(() => __t.goTab('export')); await p.waitForTimeout(200);
  await p.selectOption('#yYear', '2026'); await p.dispatchEvent('#yYear', 'input'); await p.waitForTimeout(100);
  const js = await p.evaluate(() => __t.journalOf('2026'));
  eq(js.map(j => [j.no, j.dr, j.cr, j.amt]), [[1, '会議費', '事業主借', 1000], [2, '通信費', '事業主借', 3300], [3, '事業主貸', '売上高', 550000]], '仕訳帳');
  eq(js[2].ref, 'U260930-ABCD', '売上の番号');
  const lg = await p.evaluate(() => __t.ledgerOf('2026').map(a => [a.name, a.dr, a.cr, a.close]));
  eq(lg, [['事業主貸', 550000, 0, 550000], ['事業主借', 0, 4300, 4300], ['売上高', 0, 550000, 550000], ['通信費', 3300, 0, 3300], ['会議費', 1000, 0, 1000]], '元帳の残高');
  ok((await p.textContent('#bWarn')).includes('承認済みでない経費 1件'), '下書きの注意');
  await p.selectOption('#bKind', 'g'); await p.dispatchEvent('#bKind', 'input'); await p.waitForTimeout(100);
  eq(await p.$$eval('#bBody h3', l => l.map(x => x.textContent)), ['事業主貸', '事業主借', '売上高', '通信費', '会議費'], '元帳の科目');
  await p.selectOption('#bKind', 'j'); await p.dispatchEvent('#bKind', 'input'); await p.waitForTimeout(100);
  await p.click('#bBody .b-ref[data-eid="c"]'); await p.waitForTimeout(300);
  ok(!(await p.$eval('#editSheet', el => el.classList.contains('hidden'))), '番号で経費が開く');
  return p;
});

test('売上：直す・消すと前後の値が履歴に残り、番号は変わらない', async b => {
  const p = await open(b, { settings: { sales: [{ id: 'abcd1234', date: '2026-09-30', client: 'A社', amount: 550000 }] } });
  await p.evaluate(() => __t.goTab('export')); await p.waitForTimeout(200);
  await p.selectOption('#yYear', '2026'); await p.dispatchEvent('#yYear', 'input'); await p.waitForTimeout(100);
  await p.click('#sList .s-edit'); await p.fill('#sDate', '2026-10-01'); await p.fill('#sAmount', '560000'); await p.click('#sAdd'); await p.waitForTimeout(400);
  let raw = await p.evaluate(() => JSON.parse(localStorage.getItem('keihi-trial')));
  eq([raw.settings.sales[0].date, raw.settings.sales[0].amount, raw.settings.sales[0].no], ['2026-10-01', 560000, 'U260930-ABCD'], '直した売上');
  let h = raw.history.filter(x => x.expenseId === 'sales');
  eq([h[0].action, h[0].before.amount, h[0].after.amount, h[0].after.no], ['edit', 550000, 560000, 'U260930-ABCD'], '直した履歴');
  await p.click('#sList .s-del'); await p.waitForTimeout(400);
  raw = await p.evaluate(() => JSON.parse(localStorage.getItem('keihi-trial')));
  eq([raw.settings.sales.length, raw.settings.sales[0].deleted], [1, true], '取消の印で残る');
  h = raw.history.filter(x => x.expenseId === 'sales');
  eq([h[1].action, h[1].before.amount], ['delete', 560000], '消した履歴');
  eq((await p.$$('#sList tr')).length, 0, '一覧から消える');
  eq(await p.evaluate(() => __t.journalOf('2026').length), 0, '仕訳から消える');
  await p.click('#sHistBox summary'); await p.waitForTimeout(300);
  eq(await p.$$eval('#sHist tr', l => l.length), 3, '直した記録が見える');
  return p;
});


test('減価償却：少額減価償却資産は使い始めた年に⑱へ。年をまたぐと備品で残り、翌年の元入金になる', async b => {
  const pc = { date: '2026-11-09', amount: 385110, category: '減価償却費', assetKind: 'small', assetName: 'ノートPC FMV', status: 'done', payMethod: '個人カード' };
  const p = await open(b, { expenses: { pc: { ...pc, useDate: '2026-12-01' }, lp: { date: '2026-06-01', amount: 150000, category: '減価償却費', assetKind: 'lump', useDate: '2026-06-01', assetName: 'デスク', status: 'done', payMethod: '現金' } },
    settings: { sales: [{ id: 'abcd1234', date: '2026-12-25', client: 'A社', amount: 1000000 }] } });
  await p.evaluate(() => __t.goTab('export')); await p.waitForTimeout(200);
  await p.selectOption('#yYear', '2026'); await p.dispatchEvent('#yYear', 'input'); await p.waitForTimeout(100);
  const js = await p.evaluate(() => __t.journalOf('2026').map(j => [j.date, j.dr, j.cr, j.amt]));
  eq(js, [['2026-06-01', '一括償却資産', '事業主借', 150000], ['2026-11-09', '工具器具備品', '事業主借', 385110], ['2026-12-25', '事業主貸', '売上高', 1000000],
    ['2026-12-31', '減価償却費', '一括償却資産', 50000], ['2026-12-31', '減価償却費', '工具器具備品', 385110]], '仕訳');
  const rows = await p.$$eval('#yBody tr', l => l.slice(1).map(r => [...r.cells].map(c => c.textContent)));
  eq(rows.map(r => [r[0], r[1], r[4]]), [['⑱', '減価償却費', '435,110円'], ['', '経費の合計', '435,110円']], '⑱減価償却費');
  const bs = await p.$$eval('#yBs tr', l => l.map(r => r.textContent));
  ok(bs.some(t => t.includes('一括償却資産100,000円')), '一括償却資産の残り: ' + bs.join('|'));
  const tot = bs.slice(-1)[0].split('合計').map(x => x.replace(/[^0-9]/g, '')).filter(Boolean); eq(tot[0], tot[1], '貸借が合う');
  const dep = await p.$$eval('#yDep tr', l => l.map(r => r.textContent));
  ok(dep.some(t => t.includes('ノートPC FMV') && t.includes('措法28条の2')), '減価償却の明細');
  ok((await p.textContent('#yShokyaku')).includes('ノートPC FMV') && !(await p.textContent('#yShokyaku')).includes('デスク'), '償却資産申告は少額だけ');
  // 使い始めが翌年なら、その年は備品のまま
  await p.evaluate(pc => { const s = JSON.parse(localStorage.getItem('keihi-trial')); s.expenses.pc = { ...pc, useDate: '2027-01-05' }; delete s.expenses.lp; localStorage.setItem('keihi-trial', JSON.stringify(s)); }, pc);
  await p.reload(); await p.waitForTimeout(700); await p.evaluate(() => __t.goTab('export')); await p.waitForTimeout(200);
  await p.selectOption('#yYear', '2026'); await p.dispatchEvent('#yYear', 'input'); await p.waitForTimeout(100);
  eq(await p.evaluate(() => __t.journalOf('2026').filter(j => j.dr === '減価償却費').length), 0, '2026年は償却なし');
  const bs2 = await p.$$eval('#yBs tr', l => l.map(r => r.textContent));
  ok(bs2.some(t => t.includes('工具器具備品385,110円')), '備品で残る: ' + bs2.join('|'));
  const lg = await p.evaluate(() => __t.ledgerOf('2027').map(a => [a.name, a.open, a.close]));
  eq(lg, [['工具器具備品', 385110, 0], ['元入金', 385110, 385110], ['減価償却費', 0, 385110]], '2027年の元帳');
  return p;
});


test('開業日：開業した年は期間を出し、開業前の経費を知らせ、少額減価償却資産の上限300万円を月割りする', async b => {
  const ex = { a: { date: '2026-03-10', amount: 5000, category: '消耗品費', status: 'done', payMethod: '現金' } };
  for (let i = 0; i < 6; i++) ex['pc' + i] = { date: '2026-11-09', amount: 390000, category: '減価償却費', assetKind: 'small', useDate: '2026-12-01', assetName: 'PC' + i, status: 'done', payMethod: '個人カード' };
  const p = await open(b, { expenses: ex });
  await p.evaluate(() => __t.goTab('export')); await p.waitForTimeout(200);
  await p.selectOption('#yYear', '2026'); await p.dispatchEvent('#yYear', 'input'); await p.waitForTimeout(100);
  eq(await p.$eval('#sStart', el => el.value), '2026-04-01', '開業日の初期値');
  ok((await p.textContent('#yPl')).includes('2026/4/1 〜 2026/12/31'), '期間');
  ok((await p.textContent('#yWarn')).includes('開業日（2026/4/1）より前の経費が 1件'), '開業前の経費');
  ok((await p.textContent('#yDep')).includes('上限 2,250,000円（年300万円を9か月で月割り）'), '上限の月割り');
  await p.fill('#sStart', '2025-04-01'); await p.click('#sStartSave'); await p.waitForTimeout(300);
  ok(!(await p.textContent('#yDep')).includes('上限'), '開業の翌年からは300万円: ' + (await p.textContent('#yDep')).slice(0, 80));
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
