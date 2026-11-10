// electron/closePlayerOnQuitSetting.cjs
// The quit switch 「Folia 退出时关闭外部播放器」, as the quit reads it from the shared store the renderer
// writes through `save-settings` (electron/main.cjs). The upper-case key is the name every switch in
// that store uses; the fork published this one under a lower-case name before it followed them, so a
// value saved back then is carried over to the upper-case key before the quit reads it. The
// lower-case key is never renamed or deleted: it is only read once, and the new key answers after.
//
// Only the carrying lives here. What an unset switch answers is the quit's own rule (unset reads as
// on, so that only an explicit no turns it off), which electron/main.cjs reads from the upper-case
// key directly: this fork issued the switch under the older lower-case key, and a listener who chose
// there must keep that choice rather than fall through to the newer default.

const CLOSE_PLAYER_ON_QUIT_SETTING_KEY = 'CLOSE_EXTERNAL_PLAYER_ON_QUIT';
// What the fork's earlier releases stored the same switch under (already published, so never renamed).
const LEGACY_CLOSE_PLAYER_ON_QUIT_SETTING_KEY = 'close_external_player_on_quit';

/**
 * Carries a value this fork stored under the older lower-case key over to the upper-case one, so the
 * quit's own read (which answers from the upper-case key alone) sees what the listener chose before
 * this key existed. Nothing is carried once the upper-case key holds a value of its own, and nothing
 * is carried when the older key holds nothing either: the switch then keeps the quit's default. The
 * older key is only read, never renamed or deleted. A store that cannot be written still leaves it in
 * place, so the next read tries again.
 *
 * Answers whether a value was carried, which the caller logs.
 */
function carryClosePlayerOnQuitSetting(store, log = console.log) {
  if (store.has(CLOSE_PLAYER_ON_QUIT_SETTING_KEY)) return false;
  if (!store.has(LEGACY_CLOSE_PLAYER_ON_QUIT_SETTING_KEY)) return false;
  const carried = store.get(LEGACY_CLOSE_PLAYER_ON_QUIT_SETTING_KEY) === true;
  try {
    store.set(CLOSE_PLAYER_ON_QUIT_SETTING_KEY, carried);
    log(`[ClosePlayerOnQuit] carried the stored value over to ${CLOSE_PLAYER_ON_QUIT_SETTING_KEY}: ${carried}`);
    return true;
  } catch (error) {
    console.warn('[ClosePlayerOnQuit] could not write the carried value:', error);
    return false;
  }
}

module.exports = {
  CLOSE_PLAYER_ON_QUIT_SETTING_KEY,
  LEGACY_CLOSE_PLAYER_ON_QUIT_SETTING_KEY,
  carryClosePlayerOnQuitSetting,
};
