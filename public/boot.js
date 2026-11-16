// Page entry: pick the UI language before any module builds its labels, then load the page module
// named in <html data-entry="...">.
import { setLanguage, translateDom } from './i18n.js';

const settings = await fetch('/api/settings').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
setLanguage(settings.language || 'auto');
translateDom();
await import('./' + document.documentElement.dataset.entry);
