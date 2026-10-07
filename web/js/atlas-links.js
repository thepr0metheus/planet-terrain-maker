// Links to maps of a world on other sites (worlds.js, `atlases`), each opened in a new tab: a place
// spotted there is then found in this app by name. The main page lists them, every world in a row
// (only there: the map screen keeps its room for the map). Builders of elements without state: functions.

import { t } from './i18n.js';

// One link, as an <a> that opens a new tab and tells the other site nothing of this page.
export function atlasLink(link) {
  return Dom.el('a', { href: link.url, target: '_blank', rel: 'noopener noreferrer', title: t(link.hint) }, t(link.label));
}

// Elements with a dot between each two.
export function dotted(nodes) {
  return nodes.flatMap((node, i) => (i ? [' · ', node] : [node]));
}
