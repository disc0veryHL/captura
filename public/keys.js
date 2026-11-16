// Customizable keyboard shortcuts. Keys are matched by physical key (event.code),
// so shortcuts keep working with any keyboard layout (e.g. Russian).
import { state } from './store.js';

// [id, scope, label, default combos]
export const ACTIONS = [
  // library
  ['lib.search', 'library', 'Search', ['Ctrl+K', '/']],
  ['lib.selectAll', 'library', 'Select all in view', ['Ctrl+A']],
  ['lib.open', 'library', 'Open selected photo', ['Enter']],
  ['lib.star', 'library', 'Favorite / unfavorite', ['S']],
  ['lib.hide', 'library', 'Hide / unhide', ['H']],
  ['lib.slideshow', 'library', 'Slideshow', ['F5', 'Space']],
  ['lib.zoomIn', 'library', 'Bigger thumbnails', ['=', 'Shift+=', 'Num+']],
  ['lib.zoomOut', 'library', 'Smaller thumbnails', ['-', 'Num-']],
  ['lib.copyEdits', 'library', 'Copy edits', ['Ctrl+C']],
  ['lib.pasteEdits', 'library', 'Paste edits', ['Ctrl+V']],
  ['lib.capture', 'library', 'Capture region', ['Ctrl+Shift+X']],
  ['lib.settings', 'library', 'Settings', ['Ctrl+,']],
  ['lib.help', 'library', 'Keyboard shortcuts', ['Shift+/', 'F1']],
  // photo viewer
  ['pv.next', 'viewer', 'Next photo', ['Right', 'PageDown', 'Space']],
  ['pv.prev', 'viewer', 'Previous photo', ['Left', 'PageUp', 'Backspace']],
  ['pv.first', 'viewer', 'First photo', ['Home']],
  ['pv.last', 'viewer', 'Last photo', ['End']],
  ['pv.zoomIn', 'viewer', 'Zoom in', ['=', 'Shift+=', 'Num+']],
  ['pv.zoomOut', 'viewer', 'Zoom out', ['-', 'Num-']],
  ['pv.fit', 'viewer', 'Fit to screen', ['0', 'Num0']],
  ['pv.actual', 'viewer', 'Actual size (1:1)', ['1', 'Num1']],
  ['pv.rotateCW', 'viewer', 'Rotate clockwise', [']', 'Ctrl+R']],
  ['pv.rotateCCW', 'viewer', 'Rotate counter-clockwise', ['[', 'Ctrl+Shift+R']],
  ['pv.star', 'viewer', 'Star', ['S']],
  ['pv.info', 'viewer', 'Photo info', ['I']],
  ['pv.edit', 'viewer', 'Edit photo', ['E']],
  ['pv.slideshow', 'viewer', 'Slideshow', ['F5', 'Enter']],
  ['pv.fullscreen', 'viewer', 'Full screen ⇄ window', ['F11', 'F']],
  ['pv.delete', 'viewer', 'Move to Recycle Bin', ['Delete']],
  // photo editor (adjustments)
  ['ed.undo', 'editor', 'Undo', ['Ctrl+Z']],
  ['ed.redo', 'editor', 'Redo', ['Ctrl+Y', 'Ctrl+Shift+Z']],
  ['ed.save', 'editor', 'Save', ['Ctrl+S']],
  ['ed.compare', 'editor', 'Compare with original (hold)', ['\\']],
  // screenshot editor
  ['sx.select', 'annotate', 'Select / move', ['V']],
  ['sx.rect', 'annotate', 'Rectangle', ['R']],
  ['sx.ellipse', 'annotate', 'Ellipse', ['E']],
  ['sx.line', 'annotate', 'Line', ['L']],
  ['sx.arrow', 'annotate', 'Arrow', ['A']],
  ['sx.pen', 'annotate', 'Freehand', ['P']],
  ['sx.text', 'annotate', 'Text', ['T']],
  ['sx.balloon', 'annotate', 'Speech balloon', ['B']],
  ['sx.step', 'annotate', 'Step number', ['S']],
  ['sx.highlight', 'annotate', 'Highlight', ['H']],
  ['sx.blur', 'annotate', 'Blur', ['U']],
  ['sx.pixelate', 'annotate', 'Pixelate', ['X']],
  ['sx.magnify', 'annotate', 'Magnify', ['M']],
  ['sx.spotlight', 'annotate', 'Spotlight', ['O']],
  ['sx.eraser', 'annotate', 'Smart eraser', ['Z']],
  ['sx.crop', 'annotate', 'Crop', ['C']],
  ['sx.undo', 'annotate', 'Undo', ['Ctrl+Z']],
  ['sx.redo', 'annotate', 'Redo', ['Ctrl+Y', 'Ctrl+Shift+Z']],
  ['sx.copy', 'annotate', 'Copy image', ['Ctrl+C']],
  ['sx.save', 'annotate', 'Save', ['Ctrl+S']],
  ['sx.saveCopy', 'annotate', 'Save copy', ['Ctrl+Shift+S']],
  ['sx.delete', 'annotate', 'Delete selected annotation', ['Delete', 'Backspace']],
  ['sx.fit', 'annotate', 'Fit to window', ['0']],
  ['sx.actual', 'annotate', 'Actual size', ['1']],
];
export const SCOPES = [['library', 'Library'], ['viewer', 'Photo viewer'], ['editor', 'Photo editor'], ['annotate', 'Screenshot editor']];
const BY_ID = new Map(ACTIONS.map((a) => [a[0], a]));

const CODE = {
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Slash: '/', Minus: '-', Equal: '=', Comma: ',', Period: '.',
  Semicolon: ';', Quote: "'", Backquote: '`', Space: 'Space', NumpadAdd: 'Num+', NumpadSubtract: 'Num-',
  NumpadMultiply: 'Num*', NumpadDivide: 'Num/', NumpadEnter: 'Enter', NumpadDecimal: 'Num.', IntlBackslash: '\\',
};
const KEYNAME = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Escape: 'Esc', ' ': 'Space' };

// Keyboard event → "Ctrl+Shift+R" style combo (null for a lone modifier)
export function comboOf(e) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return null;
  const c = e.code || '';
  let k = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : /^Numpad\d$/.test(c) ? 'Num' + c.slice(6)
    : CODE[c] || KEYNAME[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  if (!k || k === 'Unidentified') return null;
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', k].filter(Boolean).join('+');
}

export function keysFor(id) {
  const custom = state.settings?.keymap?.[id];
  return Array.isArray(custom) ? custom : BY_ID.get(id)?.[3] || [];
}
export const defaultKeys = (id) => BY_ID.get(id)?.[3] || [];

// Does this keyboard event trigger the action?
export function isKey(e, id) {
  const c = comboOf(e);
  return !!c && keysFor(id).includes(c);
}

export function prettyCombo(c) {
  return c.replace('Shift+/', '?').replace(/^Left$/, '←').replace(/^Right$/, '→').replace(/^Up$/, '↑').replace(/^Down$/, '↓')
    .replace(/\+/g, ' + ').replace(' +  + ', ' + +');
}

// Same combo used twice in one scope (or in a scope that is active at the same time)
export function conflicts(scope, id, combo) {
  return ACTIONS.filter((a) => a[0] !== id && a[1] === scope && keysFor(a[0]).includes(combo)).map((a) => a[2]);
}
