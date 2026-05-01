// Scroll-driven section reveal: fade-in + 12px translate-up as elements enter
// the viewport. Vanilla IntersectionObserver, ~30 lines, no dependencies.
//
// Usage: add class="reveal" to anything you want to animate in. The observer
// adds .is-visible when the element crosses 15% into the viewport.
//
// Honors prefers-reduced-motion: skips the observer entirely and renders
// everything visible immediately. Also no-ops if IntersectionObserver isn't
// available (very old browser); content remains visible because the .reveal
// hidden state is gated behind body.gate-disabled in CSS.

(function () {
  function whenReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  whenReady(function () {
    var prefersReduced = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var els = document.querySelectorAll('.reveal');
    if (prefersReduced || !('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('is-visible');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
    els.forEach(function (el) { io.observe(el); });
  });
})();
