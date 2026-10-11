// The picture each world's places are captured with. It is chosen for each place anew, from the top
// of the world's list, and kept only while the page is open: Back comes to the choice made. Kept
// between visits (it was, in localStorage), a custom source came back by itself on every new place,
// its address empty, and the guide looked stuck on it.
export class PictureChoices {
  // optionsOf(world): the world's pictures in the order the list shows them, [{ id, label }].
  constructor(optionsOf) {
    this._optionsOf = optionsOf;
    this._chosen = new Map();         // world -> the id chosen for the place in hand
  }

  // The picture chosen for the world's place in hand: the top of its list until one is chosen.
  chosen(world) {
    const options = this._optionsOf(world);
    return options.find((option) => option.id === this._chosen.get(world)) ?? options[0];
  }

  // An id the world's list does not have changes nothing.
  choose(world, id) {
    if (this._optionsOf(world).some((option) => option.id === id)) this._chosen.set(world, id);
  }

  // A new place: its picture starts from the top again.
  fromTop(world) {
    this._chosen.delete(world);
  }
}
