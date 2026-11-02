import template from './ui/template.html.txt' with { type: 'text' };
import browser from './ui-bundle';
import profileCSS from './ui/profile.css.txt' with { type: 'text' };
import type { Catalog } from './types';
export function explorerHTML(catalog: Catalog): string {
  return template
    .replace('__CATALOG_DATA__', () => JSON.stringify(catalog).replaceAll('<', '\\u003c'))
    .replace('__PROFILE_CSS__', () => profileCSS)
    .replace('__BROWSER_CODE__', () => browser.replaceAll('</script', '<\\/script'));
}
