# テスト

`keihi.html`（経費精算）の動作テスト。お試しモード（`#trial`）でページを開き、データを入れて操作した結果を確かめる。Firebase やドライブには接続しない。

```
npm i --no-save playwright
npx playwright install chromium
node tests/run.js
```

PR ごとに GitHub Actions（`.github/workflows/test.yml`）でも動く。直したら、その動きを確かめるテストを `tests/run.js` に足す。
