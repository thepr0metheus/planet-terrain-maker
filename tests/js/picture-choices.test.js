import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PictureChoices } from '../../web/js/picture-choices.js';

const LISTS = {
  earth: [{ id: 'photo' }, { id: 's2' }, { id: 'usgs' }, { id: 'custom' }],
  moon: [{ id: 'wac' }, { id: 'kaguya' }],
};

test('a place\'s picture starts from the top of its world\'s list; a choice holds until the next place', () => {
  const pictures = new PictureChoices((world) => LISTS[world]);
  assert.equal(pictures.chosen('earth').id, 'photo', 'nothing chosen: the top of the list');
  pictures.choose('earth', 'custom');
  assert.equal(pictures.chosen('earth').id, 'custom', 'Back comes to the choice made');
  assert.equal(pictures.chosen('moon').id, 'wac', 'each world has its own');
  pictures.choose('earth', 'nowhere');
  assert.equal(pictures.chosen('earth').id, 'custom', 'an id the list has not changes nothing');
  pictures.fromTop('earth');
  assert.equal(pictures.chosen('earth').id, 'photo', 'a new place: the top again');
  assert.equal(new PictureChoices((world) => LISTS[world]).chosen('earth').id, 'photo', 'a page opened anew remembers nothing');
});
