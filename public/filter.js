// Tiny, dependency-free client-side table filter. Progressive enhancement: the tables
// work fine without JS; this just hides non-matching rows as you type/select.
//
// Markup contract: wrap the toolbar + table in an element with [data-filterable].
// Inside it: an <input data-filter-search>, an optional <select data-filter-status>,
// and a <table> whose body rows carry data-search (text to match) and, for status
// filtering, data-status (+ optional data-overdue="1"). A <tr data-empty> row (kept
// hidden) is shown when a filter matches nothing.
(function () {
  function norm(s) { return (s || "").toLowerCase().trim(); }

  document.querySelectorAll("[data-filterable]").forEach(function (root) {
    var table = root.querySelector("table");
    if (!table || !table.tBodies.length) return;
    var search = root.querySelector("[data-filter-search]");
    var statusSel = root.querySelector("[data-filter-status]");
    var body = table.tBodies[0];
    var rows = Array.prototype.slice.call(body.rows).filter(function (r) { return !r.hasAttribute("data-empty"); });
    var emptyRow = body.querySelector("[data-empty]");

    function apply() {
      var q = search ? norm(search.value) : "";
      var st = statusSel ? statusSel.value : "";
      var shown = 0;
      rows.forEach(function (r) {
        var hay = norm(r.getAttribute("data-search") || r.textContent);
        var matchText = !q || hay.indexOf(q) !== -1;
        var matchStatus = !st
          || (r.getAttribute("data-status") || "") === st
          || (st === "overdue" && r.getAttribute("data-overdue") === "1");
        var show = matchText && matchStatus;
        r.style.display = show ? "" : "none";
        if (show) shown++;
      });
      if (emptyRow) emptyRow.style.display = shown === 0 ? "" : "none";
    }

    if (search) search.addEventListener("input", apply);
    if (statusSel) statusSel.addEventListener("change", apply);
  });
})();
