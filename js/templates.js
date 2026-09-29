'use strict';

// カテゴリ定義
const CATEGORIES = [
  { id: 'purchase', name: '物品購入' },
  { id: 'domestic', name: '国内出張' },
  { id: 'overseas', name: '国外出張' },
  { id: 'other',    name: 'その他' },
];

// チェック項目の種類
const ITEM_TYPES = {
  check:            'チェック',
  yes_no:           '有 / 無',
  text:             '短文入力',
  textarea:         '長文入力',
  schedule:         '日程（出発日・帰学日・日帰り）',
  daterange:        '日程（出発日・帰学日）',
  budget:           '予算（選択）',
  file:             'ファイル添付',
  file_or_physical: 'ファイル添付 または 現物提出',
  done_or_na:       '終了 または 不要',
};

// カテゴリごとの初期テンプレート（設定画面から変更可能）
const DEFAULT_TEMPLATES = {
  purchase: [
    { name: '購入', items: [
      { label: '注文日書類', type: 'file' },
      { label: '領収書類',   type: 'file' },
      { label: '法人カード利用', type: 'yes_no' },
      { label: '予算', type: 'budget' },
    ] },
  ],
  domestic: [
    { name: '申請時', items: [
      { label: '日程', type: 'schedule' },
      { label: '用務先・相手', type: 'text' },
      { label: '用務内容', type: 'text' },
      { label: '予算', type: 'budget' },
    ] },
    { name: '終了後', items: [
      { label: '報告内容', type: 'textarea' },
      { label: '証拠資料', type: 'file_or_physical' },
    ] },
  ],
  overseas: [
    { name: '起案', items: [
      { label: '行先', type: 'text' },
      { label: '受付番号', type: 'text' },
      { label: '飛行機の見積もり', type: 'done_or_na' },
    ] },
    { name: '申請時', items: [
      { label: '日程', type: 'daterange' },
      { label: '用務先', type: 'text' },
      { label: '用務内容', type: 'text' },
      { label: '予算', type: 'budget' },
      { label: '飛行機の手配', type: 'check' },
    ] },
    { name: '終了後', items: [
      { label: '報告内容', type: 'textarea' },
      { label: '証拠資料', type: 'file_or_physical' },
    ] },
  ],
  other: [
    { name: '項目', items: [] },
  ],
};

// 種類ごとの初期値
function defaultValue(type) {
  switch (type) {
    case 'check':            return { checked: false };
    case 'yes_no':           return { answer: '' };
    case 'text':
    case 'textarea':         return { text: '' };
    case 'schedule':         return { start: '', end: '', dayTrip: false };
    case 'daterange':        return { start: '', end: '' };
    case 'budget':           return { budget: '' };
    case 'file':             return { files: [] };
    case 'file_or_physical': return { files: [], physical: false };
    case 'done_or_na':       return { state: '' };
    default:                 return {};
  }
}

// 項目が完了しているか
function isDone(item) {
  const v = item.value || {};
  switch (item.type) {
    case 'check':            return !!v.checked;
    case 'yes_no':           return v.answer === 'yes' || v.answer === 'no';
    case 'text':
    case 'textarea':         return !!(v.text && v.text.trim());
    case 'schedule':         return !!v.start && (!!v.dayTrip || !!v.end);
    case 'daterange':        return !!v.start && !!v.end;
    case 'budget':           return !!v.budget;
    case 'file':             return (v.files || []).length > 0;
    case 'file_or_physical': return (v.files || []).length > 0 || !!v.physical;
    case 'done_or_na':       return v.state === 'done' || v.state === 'na';
    default:                 return false;
  }
}

// 設定データの正規化（欠けている部分を初期値で補う）
function normalizeSettings(s) {
  s = (s && typeof s === 'object') ? s : {};
  const out = {
    budgets: Array.isArray(s.budgets) ? s.budgets.filter(b => typeof b === 'string' && b.trim()) : [],
    templates: {},
  };
  for (const c of CATEGORIES) {
    const src = (s.templates && Array.isArray(s.templates[c.id])) ? s.templates[c.id] : DEFAULT_TEMPLATES[c.id];
    out.templates[c.id] = src.map(sec => ({
      name: String(sec.name || ''),
      items: (Array.isArray(sec.items) ? sec.items : []).map(i => ({
        label: String(i.label || ''),
        type: ITEM_TYPES[i.type] ? i.type : 'check',
      })),
    }));
  }
  return out;
}
