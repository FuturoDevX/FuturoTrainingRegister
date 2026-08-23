// In-page tabs + copy-to-clipboard. Progressive enhancement: with no JS, all panels show
// stacked (still fully usable) and the copy button just sits next to selectable link text.
(function () {
  document.querySelectorAll("[data-tabs]").forEach(function (root) {
    var tabs = Array.prototype.slice.call(root.querySelectorAll("[data-tab]"));
    var panels = Array.prototype.slice.call(root.querySelectorAll("[data-tab-panel]"));
    if (!tabs.length) return;
    function show(name) {
      var found = false;
      panels.forEach(function (p) {
        var on = p.getAttribute("data-tab-panel") === name;
        p.style.display = on ? "" : "none";
        if (on) found = true;
      });
      tabs.forEach(function (t) { t.classList.toggle("on", t.getAttribute("data-tab") === name); });
      return found;
    }
    tabs.forEach(function (t) {
      t.addEventListener("click", function (e) {
        e.preventDefault();
        var n = t.getAttribute("data-tab");
        show(n);
        if (history.replaceState) history.replaceState(null, "", "#" + n);
      });
    });
    var initial = (location.hash || "").replace("#", "");
    if (!initial || !show(initial)) show(tabs[0].getAttribute("data-tab"));
  });

  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy");
      var done = function () { var o = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = o; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {});
      }
    });
  });
})();
