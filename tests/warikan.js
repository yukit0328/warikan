// 割り勘（index.html）の動作テスト。お試しモード（firebaseConfig を null）で開き、使い方（❓）と一覧の動きを確かめる。
// 使い方: npm i playwright && npx playwright install chromium && node tests/warikan.js
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/const firebaseConfig = \{[\s\S]*?\};/, 'const firebaseConfig = null;');
const BASE = 'https://example.test/warikan/';
const K = 'test000000000000000000aa', now = Date.now();
const DATA = { meta: { name: '旅行', status: 'active', createdAt: now, updatedAt: now },
  members: { y: { name: 'ゆうき', order: 1, createdAt: now }, a: { name: 'A', order: 2, createdAt: now } },
  expenses: { e1: { title: '昼食', amount: 2000, payer: 'y', participants: ['__all__'], date: '2026-11-08', createdAt: now, updatedAt: now } } };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ok = (v, m) => { if (!v) throw new Error(m); };
const visible = (p, sel) => p.locator(sel).isVisible();

async function open(b, hash, ls = {}) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 800 } });
  const p = await ctx.newPage(); p.errs = []; p.dialogs = [];
  p.on('pageerror', e => p.errs.push(e.message));
  p.on('dialog', d => { p.dialogs.push(d.message()); d.accept(); });
  await ctx.route(/^https:\/\/example\.test\/warikan\/(#.*)?$/, r => r.fulfill({ contentType: 'text/html', body: PAGE }));
  await ctx.route(/example\.test\/warikan\/img\//, r => r.fulfill({ status: 404, body: '' }));
  await ctx.route(/cdnjs|gstatic|googleapis|jsdelivr/, r => r.abort());
  // 最初の1回だけ localStorage に入れる（開き直したときは入れ直さない）
  await ctx.addInitScript(ls => { if (sessionStorage.getItem('t-init')) return; sessionStorage.setItem('t-init', '1'); for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); }, ls);
  await p.goto(BASE + hash); await p.waitForTimeout(700);
  return p;
}

test('割り勘ページを初めて開くと、「あなたは誰？」のあとに使い方が出る。2回目は出ない', async b => {
  const p = await open(b, '#k=' + K, { ['warikan-demo-' + K]: JSON.stringify(DATA) });
  ok(await visible(p, '#whoModal'), '最初は「あなたは誰？」');
  ok(!(await visible(p, '#guideModal')), '名前を選ぶ前は使い方を出さない');
  await p.click('#whoHelpBtn'); ok(await visible(p, '#whoHelp'), '❓で名前の説明が出る');
  await p.click('#whoChips [data-me="y"]'); await p.waitForTimeout(400);
  ok(await visible(p, '#guideModal'), '名前を選んだら使い方が出る');
  const t = await p.locator('#guideBody').innerText();
  ok(t.includes('払ったら記録する') && t.includes('最後に精算する') && t.includes('次に開くとき'), '3ステップ');
  ok(!(await p.locator('#guideBody details').getAttribute('open')), '「くわしく」は閉じている');
  await p.click('#guideOk'); ok(!(await visible(p, '#guideModal')), '閉じる');
  await p.reload(); await p.waitForTimeout(700);
  ok(!(await visible(p, '#guideModal')), '2回目は自動で出ない');
  await p.click('#helpBtn'); ok(await visible(p, '#guideModal'), '❓で開く');
  ok(await visible(p, '#backLink'), '「‹ 割り勘の一覧」がある');
  ok((await p.locator('#backLink').getAttribute('href')) === './', '一覧へのリンク先');
  return p;
});

test('トップページの❓は「送られてきた割り勘を開く」が先頭。自動では出さない', async b => {
  const p = await open(b, '', {});
  ok(!(await visible(p, '#guideModal')), 'トップでは自動で出さない');
  ok(!(await visible(p, '#backLink')), 'トップには戻るリンクなし');
  await p.click('#helpBtn');
  const first = await p.locator('#guideBody .guide-step b').first().innerText();
  ok(first === '送られてきた割り勘を開く', '先頭: ' + first);
  return p;
});

test('自分のスマホで作成した割り勘は精算完了まで外せない。開いただけのものは外せる', async b => {
  const hist = [{ k: 'mine00000000000000000000', name: '作った旅行', status: 'active', mine: true, at: now },
    { k: 'mine00000000000000000001', name: '作って精算済み', status: 'settled', mine: true, at: now },
    { k: 'open00000000000000000000', name: '開いた旅行', status: 'active', at: now }];
  const p = await open(b, '', { 'warikan-history': JSON.stringify(hist) });
  ok(await p.locator('#histBody [data-mine]').count() === 1, 'グレーのボタンは作った・精算中の1件だけ');
  await p.click('#histBody [data-mine]', { force: true });   // 見た目はグレーだが押せる（押すとお知らせ） await p.waitForTimeout(100);
  ok((await p.locator('#toast').innerText()).includes('精算完了後に外せます'), '押すとお知らせ');
  ok(await p.locator('#histBody .hist').count() === 3, '外れていない');
  await p.locator('#histBody [data-unhist]').first().click(); await p.waitForTimeout(100);
  ok(await p.locator('#histBody .hist').count() === 2, '精算済み・開いただけのものは外せる');
  ok(p.dialogs.length === 0, 'ダイアログを出さない');
  return p;
});

test('「作る」で作った割り勘は、自分のスマホで作成した印が付く', async b => {
  const p = await open(b, '', {});
  await p.fill('#newName', '新しい旅行'); await p.click('#newKeyBtn'); await p.waitForTimeout(800);
  const h = await p.evaluate(() => JSON.parse(localStorage.getItem('warikan-history')));
  ok(h.length === 1 && h[0].mine === true && h[0].name === '新しい旅行', JSON.stringify(h));
  return p;
});

test('「写真だけで入力する」は最初からオン。外したらそのスマホではオフのまま', async b => {
  const p = await open(b, '#k=' + K, { ['warikan-demo-' + K]: JSON.stringify(DATA), ['warikan-me-' + K]: 'y', 'warikan-guide-seen': '1' });
  await p.click('#fab'); await p.waitForTimeout(300);
  ok(await p.locator('#laterMode').isChecked(), '最初はオン');
  await p.click('#laterMode'); await p.click('#sheetClose'); await p.reload(); await p.waitForTimeout(700);
  await p.click('#fab'); await p.waitForTimeout(300);
  ok(!(await p.locator('#laterMode').isChecked()), '外したらオフのまま');
  return p;
});

test('「共有する」は共有メニューにURLを渡す。共有メニューがなければコピーになる', async b => {
  const ls = { ['warikan-demo-' + K]: JSON.stringify(DATA), ['warikan-me-' + K]: 'y', 'warikan-guide-seen': '1' };
  const p = await open(b, '#k=' + K, ls);
  ok((await p.locator('#shareSec .banner').innerText()).includes('メンバーにだけ送って'), '注意書き');
  await p.evaluate(() => { window.__shared = null; navigator.share = async d => { window.__shared = d; }; });
  await p.click('#shareBtn'); await p.waitForTimeout(100);
  const d = await p.evaluate(() => window.__shared);
  ok(d && d.url.includes('#k=') && d.text.includes('旅行'), JSON.stringify(d));
  await p.evaluate(() => { delete navigator.share; Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); window.__copied = null; navigator.clipboard.writeText = async v => { window.__copied = v; }; });
  await p.click('#shareBtn'); await p.waitForTimeout(100);
  ok((await p.evaluate(() => window.__copied) || '').includes('#k='), 'コピーになる');
  return p;
});

test('自分が払う円の行にだけ「PayPayで送る」。押すと金額をコピーしてPayPayを開く', async b => {
  const d = JSON.parse(JSON.stringify(DATA));   // ゆうきが2000円を全員で割る → A がゆうきに1000円
  const p = await open(b, '#k=' + K, { ['warikan-demo-' + K]: JSON.stringify(d), ['warikan-me-' + K]: 'a', 'warikan-guide-seen': '1' });
  ok(await p.locator('#resultBody [data-paypay]').count() === 1, 'A の精算に1つ');
  ok(await p.locator('#resultBody [data-paypay]').getAttribute('data-paypay') === '1000', '金額');
  await p.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async v => { window.__copied = v; }; });
  const req = p.waitForRequest(r => r.url().startsWith('paypay:'), { timeout: 2000 }).catch(() => null);
  await p.click('#resultBody [data-paypay]'); await p.waitForTimeout(200);
  ok(await p.evaluate(() => window.__copied) === '1000', 'コピー');
  ok((await p.locator('#toast').innerText()).includes('1,000円'), 'お知らせ');
  await req;
  return p;
});

test('受け取る側には「PayPayで送る」を出さない', async b => {
  const p = await open(b, '#k=' + K, { ['warikan-demo-' + K]: JSON.stringify(DATA), ['warikan-me-' + K]: 'y', 'warikan-guide-seen': '1' });
  ok(await p.locator('#resultBody [data-paypay]').count() === 0, 'なし');
  return p;
});

(async () => {
  const b = await chromium.launch();
  let fail = 0;
  for (const t of tests) {
    try { const p = await t.fn(b); if (p?.errs?.length) throw new Error('ページのエラー: ' + p.errs.join(' / ')); console.log('ok  ', t.name); }
    catch (e) { fail++; console.log('FAIL', t.name, '\n     ', e.message); }
  }
  await b.close();
  console.log(fail ? `${fail}件 失敗` : 'すべて成功');
  process.exit(fail ? 1 : 0);
})();
