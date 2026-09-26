// Theme is applied before the first stylesheet; no desktop settings are read.
try {
    const theme = localStorage.getItem('cloudig-docs-theme');
    const language = localStorage.getItem('cloudig-docs-language');
    if (theme === 'star-night')
        document.documentElement.dataset.theme = theme;
    if (language === 'en')
        document.documentElement.lang = language;
}
catch { /* Reading remains available when browser storage is disabled. */ }
// An explicit link from the app may request its current reading language/theme.
// This does not silently overwrite the browser's saved preferences.
const requested = new URLSearchParams(location.search);
if (['dawn', 'star-night'].includes(requested.get('theme'))) document.documentElement.dataset.theme = requested.get('theme');
if (['zh-CN', 'en'].includes(requested.get('lang'))) document.documentElement.lang = requested.get('lang');
