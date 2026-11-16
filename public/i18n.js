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
// Locale for dates and numbers: follows the chosen UI language.
export const uiLocale = () => ({ en: 'en-US', es: 'es-ES', fr: 'fr-FR', ru: 'ru-RU', zh: 'zh-CN' }[lang] || 'en-US');

// English singular forms for count strings ("1 photo", not "1 photos").
const EN_ONE = {
  '{n} photos': '{n} photo', '{n} photos · {f} folders': '{n} photos · {f} folder', '{n} selected': '{n} selected',
  'Export {n} photos': 'Export {n} photo', 'Exported {n} photos': 'Exported {n} photo', '{n} favorites': '{n} favorite',
  '{n} annotations': '{n} annotation', '{n} copies': '{n} copy', '{n} groups of look-alike photos': '{n} group of look-alike photos',
  'Hid {n} photos': 'Hid {n} photo', 'Unhid {n} photos': 'Unhid {n} photo', 'Pasted edits to {n} photos': 'Pasted edits to {n} photo',
  'Tagged {n} photos “{tag}”': 'Tagged {n} photo “{tag}”', 'Hid {n} extra copies': 'Hid {n} extra copy',
  'Apply edits ({n} edited photos)': 'Apply edits ({n} edited photo)', '{n} photos with location': '{n} photo with location',
  'Created “{name}” with {n} photos': 'Created “{name}” with {n} photo', 'This week in {y} · {n} photos': 'This week in {y} · {n} photo',
  '{n} photos are still being analyzed.': '{n} photo is still being analyzed.', '{n} seconds': '{n} second',
};

export function t(s, vars) {
  let r = dict[s] ?? s;
  if (lang === 'en' && vars) {
    if (String(vars.n) === '1' && EN_ONE[s]) r = EN_ONE[s];
    if (s === '{n} photos · {f} folders') r = (String(vars.n) === '1' ? '{n} photo' : '{n} photos') + (String(vars.f) === '1' ? ' · {f} folder' : ' · {f} folders');
  }
  if (vars) r = r.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return r;
}

// Translate static text in HTML: elements with data-i18n (text) or data-i18n-title / data-i18n-placeholder.
export function translateDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
}
