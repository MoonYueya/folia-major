// electron/closePlayerOnQuitSetting.cjs
// The quit switch 「Folia 退出时关闭外部播放器」, as the quit reads it from the shared store the renderer
// writes through `save-settings` (electron/main.cjs). The upper-case key is the name every switch in
// that store uses; the fork published this one under a lower-case name before it followed them, so a
// value saved back then is carried over to the upper-case key the first time it is read here. The
// lower-case key is never renamed or deleted: it is only read once, and the new key answers after.

const CLOSE_PLAYER_ON_QUIT_SETTING_KEY = 'CLOSE_EXTERNAL_PLAYER_ON_QUIT';
// What the fork's earlier releases stored the same switch under (already published, so never renamed).
const LEGACY_CLOSE_PLAYER_ON_QUIT_SETTING_KEY = 'close_external_player_on_quit';

/**
 * Answers whether quitting closes the player outside Folia: the upper-case key when it holds a value,
 * otherwise the older lower-case one, whose value is written to the upper-case key as it is read (a
 * store that cannot be written still answers). Nothing stored under either key is off.
 */
function createClosePlayerOnQuitSetting(store, log = console.log) {
  return function closePlayerOnQuit() {
    if (store.has(CLOSE_PLAYER_ON_QUIT_SETTING_KEY)) {
      return store.get(CLOSE_PLAYER_ON_QUIT_SETTING_KEY) === true;
    }
    if (!store.has(LEGACY_CLOSE_PLAYER_ON_QUIT_SETTING_KEY)) return false;
    const carried = store.get(LEGACY_CLOSE_PLAYER_ON_QUIT_SETTING_KEY) === true;
    try {
      store.set(CLOSE_PLAYER_ON_QUIT_SETTING_KEY, carried);
      log(`[ClosePlayerOnQuit] carried the stored value over to ${CLOSE_PLAYER_ON_QUIT_SETTING_KEY}: ${carried}`);
    } catch (error) {
      console.warn('[ClosePlayerOnQuit] could not write the carried value:', error);
    }
    return carried;
  };
}

module.exports = {
  CLOSE_PLAYER_ON_QUIT_SETTING_KEY,
  LEGACY_CLOSE_PLAYER_ON_QUIT_SETTING_KEY,
  createClosePlayerOnQuitSetting,
};
