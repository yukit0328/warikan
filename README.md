# 割り勘・精算

旅行中の立て替えを記録して、最後に誰が誰にいくら払うかを計算するページです。

- 公開URL：https://yukit0328.github.io/warikan/
- 旅行ごとに「新しい精算ページを作る」で作り、URL（合言葉入り）を旅行メンバーだけに共有します。
- データは Firebase Firestore（プロジェクト trips-warikan）に保存します。
- 管理画面：admin.html（管理者の Google アカウントだけが一覧を見られます）

## 経費精算（keihi.html）

個人事業の経費を記録するページです（管理者の Google アカウントだけが使えます）。

- URL：https://yukit0328.github.io/warikan/keihi.html （`#trial` を付けるとお試しモード）
- レシート写真・PDFの原本は Google ドライブの「経費レシート/年-月」に保存し、指紋（SHA-256）を Firestore に記録して改ざんを確かめます。
- 写真は暗号化して依頼箱（keihiAiQueue）に入れ、おてつだいAIが読み取って結果（keihiAiResult）を返します。
- 経費はすべて（現金・カード・口座引き落とし）MF 仕訳帳の取込用 CSV に出力します。MF の連携明細は「対象外」にして二重計上を防ぎます。
- 毎月の家賃などは「定期の支払い」で自動作成します。
