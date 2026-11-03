// The way to the list of the home's services, for a page that is one of the home's sites.
//
// The home's parent domain is the shared theme file's (Theme.domain gives it for a host that stands under it, and null anywhere
// else: a laptop's localhost, a copy of this page that is no part of any home). Its address is the home's own: the domain
// itself, over https. No domain, no address, and the page draws no button: nothing here names a network.

// domain: what Theme.domain(location.hostname) said.
export function servicesAddress(domain) {
  return typeof domain === 'string' && domain ? `https://${domain}/` : null;
}
