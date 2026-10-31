/* ===========================================================================
 * Memory Weaver — UI language (EN default + VI)
 *
 * PURE module (no ST imports, node-importable). English is the source
 * language: every UI string is written in English in the code and doubles as
 * its own translation key, so a string without a Vietnamese entry simply
 * stays English. index.js resolves the setting (en | vi | auto → ST locale)
 * and calls setUiLanguage(); everything else just calls tr()/trn() at render
 * time.
 *
 * Only the UI is translated. Text sent to the AI (optimizer / summarizer /
 * recall prompts, injected memory / schedule / chapter blocks) and stored
 * data (memory text, schedule labels) never pass through tr().
 * ========================================================================= */

import VI_MAIN from './i18n/vi-main.js';
import VI_DASHBOARD from './i18n/vi-dashboard.js';

export const UI_LANGUAGES = Object.freeze({ en: 'English', vi: 'Tiếng Việt' });
export const UI_LANGUAGE_SETTINGS = Object.freeze(['en', 'vi', 'auto']);
export const DEFAULT_UI_LANGUAGE = 'en';

const DICTIONARIES = { vi: { ...VI_MAIN, ...VI_DASHBOARD } };

let active = DEFAULT_UI_LANGUAGE;

/* setting 'en' | 'vi' → itself; 'auto' (or anything unknown) → follow the
   SillyTavern locale ("vi", "vi-vn" → vi), else English. */
export function resolveUiLanguage(setting, currentLocale = '') {
    if (setting === 'en' || setting === 'vi') return setting;
    if (setting !== 'auto') return DEFAULT_UI_LANGUAGE;
    const locale = String(currentLocale ?? '').toLowerCase();
    return locale === 'vi' || locale.startsWith('vi-') ? 'vi' : DEFAULT_UI_LANGUAGE;
}

export function setUiLanguage(language) {
    active = Object.hasOwn(UI_LANGUAGES, language) ? language : DEFAULT_UI_LANGUAGE;
    return active;
}

export function getUiLanguage() {
    return active;
}

/* BCP-47 tag for toLocale*String so dates/numbers follow the UI language. */
export function uiLocale() {
    return active === 'vi' ? 'vi-VN' : 'en-US';
}

function fill(text, params) {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match));
}

/* tr('Added {n} memories', { n: 3 }) — the English text is the key;
   {name} placeholders are filled after lookup. */
export function tr(text, params = null) {
    const source = String(text ?? '');
    const dictionary = DICTIONARIES[active];
    const translated = dictionary && Object.hasOwn(dictionary, source) ? dictionary[source] : source;
    return fill(translated, params);
}

/* English singular/plural pick by n (Vietnamese has no plural form — both
   keys usually map to the same text). {n} is always available. */
export function trn(one, other, n, params = null) {
    return tr(Number(n) === 1 ? one : other, { n, ...(params ?? {}) });
}

/* Test/audit helper: the raw dictionary of a language (read-only copy). */
export function dictionaryFor(language) {
    return { ...(DICTIONARIES[language] ?? {}) };
}
