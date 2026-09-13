/* Theme controller — load synchronously in <head> BEFORE the stylesheet so the
   right palette is on <html> at first paint (no flash). Paper (light) is the
   default for a study desk you read in daylight; phosphor (dark) is a tap away.
   "system" follows the OS live. */
(function () {
  "use strict";
  var KEY = "plumimemo.theme";        // "light" | "dark" | "system"
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function osTheme() { return mq && mq.matches ? "dark" : "light"; }
  function mode() {
    // ?theme=dark|light on the URL wins, so screenshots and tests can pin a theme.
    try { var q = new URLSearchParams(location.search).get("theme"); if (q === "light" || q === "dark") return q; } catch (e) {}
    try { var m = localStorage.getItem(KEY); if (m === "light" || m === "dark" || m === "system") return m; } catch (e) {}
    return "system";
  }
  function resolved() { var m = mode(); return m === "system" ? osTheme() : m; }
  function apply() {
    var t = resolved();
    document.documentElement.setAttribute("data-theme", t);
    // The address-bar colour: insert a non-media theme-color AHEAD of the pair in
    // <head> so it wins when the learner has picked a theme by hand.
    var meta = document.getElementById("theme-color-override");
    if (mode() === "system") { if (meta) meta.remove(); return; }
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color"; meta.id = "theme-color-override";
      document.head.insertBefore(meta, document.head.firstChild);
    }
    meta.content = t === "dark" ? "#141210" : "#F8F6F1";
  }
  apply();
  if (mq && mq.addEventListener) mq.addEventListener("change", function () { if (mode() === "system") apply(); });
  window.PlumiTheme = {
    mode: mode,
    resolved: resolved,
    set: function (m) { try { localStorage.setItem(KEY, m); } catch (e) {} apply(); },
    toggle: function () { this.set(resolved() === "dark" ? "light" : "dark"); },
  };
})();
