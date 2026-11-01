// Shows a sticky "Apply Now" bar on phones once the main button has scrolled out of view.
const hero = document.getElementById('hero-cta');
const closing = document.getElementById('closing-panel');
const sticky = document.getElementById('sticky-cta');

if (hero && sticky && 'IntersectionObserver' in window) {
  let heroVisible = true;
  let closingVisible = false;
  const update = () => {
    const hidden = heroVisible || closingVisible;
    sticky.hidden = hidden;
    document.body.style.paddingBottom = hidden ? '' : '84px';
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.target === hero) heroVisible = e.isIntersecting;
      else closingVisible = e.isIntersecting;
    }
    update();
  });
  io.observe(hero);
  if (closing) io.observe(closing);
}
