/**
 * Where things are on the marble bust model, as fractions of its size, found by looking at it.
 * `mouth` is the lip line measured up from the bottom of the model; the jaw below it swings open.
 */
export const BUST = {
  mouth: 0.655,
  /** How far below the lip line the jaw eases in. */
  soft: 0.01,
  /** How far below the lip line the jaw reaches before fading out into the neck. */
  jaw: 0.07,
  /** Biggest jaw drop. */
  amount: 0.014,
  /** Half the face's width, from its middle. */
  halfWidth: 0.17,
  /** The head turns less than the built-in character: a relief has no back to show. */
  sway: 0.4,
  /** The frame is centred this far up the model, and zoomed in so the head and shoulders fill it. */
  focus: 0.7,
  zoom: 1.7,
};
