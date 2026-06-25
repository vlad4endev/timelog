/** Web stub — Capacitor bridge is built into www/ for native apps. */
var TimeLogNative = (function () {
  function noop() {
    return Promise.resolve();
  }
  return {
    isNativePlatform: function () {
      return false;
    },
    initNativeTimer: function () {},
    startNativeTimer: noop,
    updateNativeTimer: noop,
    stopNativeTimer: noop,
  };
})();
