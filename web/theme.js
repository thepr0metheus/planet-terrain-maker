'use strict';

/*
 * The colour scheme: the device's own, unless the person picked one. The choice is kept in a
 * cookie and, when cookies are off, in this browser's storage. The file is loaded in the head and
 * runs at once, so that the page is never painted in the other scheme for the moment before its
 * main script wakes up.
 */

class Theme {
  static KEY = 'ptm-theme';
  static CHOICES = ['light', 'dark'];
  /** A parent domain whose pages would all see the choice, or null: the cookie is this site's own. */
  static SHARED = null;
  static YEAR = 365 * 24 * 3600;

  /** The domain to set the cookie for, or null — a host-only cookie — anywhere else, a laptop's localhost for one. */
  static domain(host) {
    return Theme.SHARED && (host === Theme.SHARED || host.endsWith(`.${Theme.SHARED}`)) ? Theme.SHARED : null;
  }

  static fromCookie() {
    const found = document.cookie.match(new RegExp(`(?:^|; )${Theme.KEY}=([^;]*)`));
    return found ? decodeURIComponent(found[1]) : null;
  }

  /** Storage may be off (a private window): that is "no choice kept here", not a failure. */
  static fromStorage() {
    try {
      return window.localStorage.getItem(Theme.KEY);
    } catch (err) {
      return null;
    }
  }

  /** The saved choice, or null: the cookie is the one the other pages see, so it is asked first. */
  static saved() {
    for (const value of [Theme.fromCookie(), Theme.fromStorage()]) {
      if (Theme.CHOICES.includes(value)) return value;
    }
    return null;
  }

  static apply() {
    const choice = Theme.saved();
    if (choice) document.documentElement.dataset.theme = choice;
    else delete document.documentElement.dataset.theme;
  }

  /** What the page looks like now: the choice, or else what the device says. */
  static current() {
    const chosen = document.documentElement.dataset.theme;
    if (chosen) return chosen;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  /** Keeps the choice for the next visit. */
  static keep(choice) {
    try {
      window.localStorage.setItem(Theme.KEY, choice);
    } catch (err) {
      // the cookie below still carries it, where cookies are on
    }
    const domain = Theme.domain(window.location.hostname);
    document.cookie = `${Theme.KEY}=${choice}; Path=/; Max-Age=${Theme.YEAR}; SameSite=Lax${domain ? `; Domain=${domain}` : ''}`;
  }

  /** The other scheme, kept for next time. Returns the one now shown. */
  static toggle() {
    const next = Theme.current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    Theme.keep(next);
    return next;
  }
}

if (typeof module !== 'undefined') module.exports = { Theme };
if (typeof document !== 'undefined') Theme.apply();
