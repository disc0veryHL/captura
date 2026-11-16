// Tiny translation layer. Keys are the English UI strings; {name} placeholders are filled from vars.
// Shared by the pages and the Electron main process (no DOM access at import time).
import es from './locales/es.js';
import fr from './locales/fr.js';
import ru from './locales/ru.js';
import zh from './locales/zh.js';

export const LANGS = [['auto', 'System language'], ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['ru', 'Русский'], ['zh', '中文（简体）']];
const DICTS = { es, fr, ru, zh };

let lang = 'en';
let dict = {};

export function resolveLanguage(code, systemLocale) {
  if (code && code !== 'auto' && (code === 'en' || DICTS[code])) return code;
  const sys = String(systemLocale || (typeof navigator !== 'undefined' ? navigator.language : 'en')).toLowerCase().slice(0, 2);
  return DICTS[sys] ? sys : 'en';
}

export function setLanguage(code, systemLocale) {
  lang = resolveLanguage(code, systemLocale);
  dict = DICTS[lang] || {};
  if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  return lang;
}
export const currentLanguage = () => lang;

export function t(s, vars) {
  let r = dict[s] ?? s;
  if (vars) r = r.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return r;
}

// Translate static text in HTML: elements with data-i18n (text) or data-i18n-title / data-i18n-placeholder.
export function translateDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
}
