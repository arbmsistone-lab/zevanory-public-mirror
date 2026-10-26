// ZEVANORY phone buy bar (site audit S-09, 2026-10-25). The bar (.buy-bar, phones only) stays out of the
// way until the hero call to action has scrolled above the viewport; before that it would repeat the
// button right above it and cover the payment/delivery facts. Hidden = not visible, not focusable,
// not announced (visibility:hidden + inert). No network, no storage. Without JavaScript the bar
// behaves as before (always shown on phones).
(function () {
  "use strict";
  var bar = document.querySelector(".buy-bar");
  var cta = document.querySelector("main .hero .button.primary");
  if (!bar || !cta || !("IntersectionObserver" in window)) return;
  function set(shown) {
    bar.classList.toggle("is-shown", shown);
    if (shown) bar.removeAttribute("inert"); else bar.setAttribute("inert", "");
  }
  bar.classList.add("buy-bar-auto");
  set(false);
  new IntersectionObserver(function (entries) {
    var e = entries[entries.length - 1];
    set(!e.isIntersecting && e.boundingClientRect.bottom <= 0);
  }).observe(cta);
})();
