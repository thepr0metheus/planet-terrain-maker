// One name for a model and its places. A model renamed by hand once kept showing the places' old
// names under the new one on its card, as if the model had two names. A model's name made of its
// places' names now gives each place its part: one place takes the whole name; two places take the
// parts around the word that joins them (" and " in English, t(' and ') in any language). A name that does not
// split so (no such word, or more than one) leaves the places as they are. The rule is used where a
// name is given by hand: "Rename" in the library, the pencil by the model's name, and "Save".
// Pure rules of text, without state: functions.

// The places' names a model's name gives, or null when it gives none.
export function placesOfName(name, count, joiner) {
  const clean = String(name).trim();
  if (!clean || count < 1) return null;
  if (count === 1) return [clean];
  const parts = clean.split(joiner).map((part) => part.trim());
  return parts.length === count && parts.every(Boolean) ? parts : null;
}

// The model's name its places' names make.
export function nameOfPlaces(places, joiner) {
  return places.map((name) => String(name).trim()).join(joiner);
}

// What a rename by hand sends: { name, places } (places null: they stay as they are), or null when
// nothing changes. A name typed again as it was still gives the places their parts: that is how a
// model renamed before this rule gets its places right.
export function renaming({ name: before, places }, name, joiner) {
  const clean = String(name).trim();
  if (!clean) return null;
  const given = placesOfName(clean, places.length, joiner);
  const changed = clean !== before || (given !== null && given.some((part, i) => part !== places[i]));
  return changed ? { name: clean, places: given } : null;
}
