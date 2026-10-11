// A WMTS service can describe its own layer. This reads that description when the URL follows
// the standard REST WMTS route; ordinary XYZ services fall back to their actual host name.
export class LayerDescription {
  static async read(url, fetchFn, signal) {
    const parsed = new URL(url.replace(/\{[zxy]\}/g, '0'));
    const at = parsed.pathname.toLowerCase().indexOf('/wmts/');
    if (at < 0) return null;
    const endpoint = new URL(parsed);
    endpoint.pathname = parsed.pathname.slice(0, at + 6) + '1.0.0/WMTSCapabilities.xml';
    try {
      const answer = await fetchFn(endpoint.href, { signal, mode: 'cors', credentials: 'omit' });
      if (!answer.ok) return null;
      return this.parse(await answer.text(), parsed.pathname);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return null; // No description does not mean the tile requests will fail too.
    }
  }

  static parse(text, path, parser = new DOMParser()) {
    if (text.length > 2000000) return null;
    const doc = parser.parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    const all = (node, name) => [...node.getElementsByTagNameNS('*', name)];
    const own = (node, name) => [...node.children].find((c) => c.localName === name)?.textContent.trim() ?? '';
    const layers = all(doc, 'Layer');
    const parts = path.split('/').map((part) => decodeURIComponent(part));
    const wmts = parts.findIndex((part) => part.toLowerCase() === 'wmts');
    if (wmts < 0) return null;
    const layer = layers.find((one) => own(one, 'Identifier') === parts[wmts + 1]);
    if (!layer) return null; // Never take another layer's title or zoom limits.
    const sets = all(layer, 'TileMatrixSet').map((one) => one.textContent.trim());
    const set = all(doc, 'TileMatrixSet').find((one) => sets.includes(own(one, 'Identifier')) && parts.includes(own(one, 'Identifier')));
    const matrices = set ? all(set, 'TileMatrix') : [];
    const link = set ? all(layer, 'TileMatrixSetLink').find((one) => own(one, 'TileMatrixSet') === own(set, 'Identifier')) : null;
    const limits = link ? all(link, 'TileMatrixLimits') : [];
    const identifiers = limits.length ? limits.map((one) => own(one, 'TileMatrix')) : matrices.map((one) => own(one, 'Identifier'));
    const levels = [...new Set(identifiers.map((id) => id.match(/(?:^|:)(\d+)$/)?.[1])
      .filter((n) => n !== undefined).map(Number).filter((n) => n <= 22))].sort((a, b) => a - b);
    return { name: own(layer, 'Title').slice(0, 120), credit: (all(doc, 'ProviderName')[0]?.textContent.trim() ?? '').slice(0, 600),
      maxZoom: levels.length ? Math.max(...levels) : null, zooms: levels };
  }
}
