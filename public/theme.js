// SiteGrab — (c) 2026 Salih Avcioglu. MIT License.
/* Applies the saved theme before first paint to avoid a flash. */
(function () {
  try {
    var t = localStorage.getItem("sitegrab:theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* ignore */ }
})();
