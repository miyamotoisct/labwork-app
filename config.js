// 接続設定の初期値（任意）
// ここに書いた値は「設定」画面の初期値として使われます。
// パスワードやトークンは絶対にここに書かないでください（各自が設定画面から入力します）。
window.APP_CONFIG = {
  mode: 'gas',   // 'gas'（Google Drive / Apps Script・推奨） または 'github'
  gasUrl: 'https://script.google.com/macros/s/AKfycbz53A5uL6mL9J-2yTRXJWA4n-1PQcFEd_wGAIlupMKT1IjemtN_VIBq6skquCu8mJ7LXQ/exec',    // Apps Script の Web アプリ URL（https://script.google.com/macros/s/.../exec）
  owner: '',     // （GitHub 方式のみ）GitHub のユーザー名または組織名
  repo: '',      // （GitHub 方式のみ）データ保存用リポジトリ名
  branch: 'main',
};
