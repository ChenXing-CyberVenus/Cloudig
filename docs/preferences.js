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
