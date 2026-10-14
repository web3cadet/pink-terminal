const menuToggle = document.querySelector('#menuToggle');
const sidebar = document.querySelector('#sidebar');
const sidebarOverlay = document.querySelector('#sidebarOverlay');
const progress = document.querySelector('#scrollProgress');
const toast = document.querySelector('#toast');
const sections = [...document.querySelectorAll('.section[id]')];
const navLinks = [...document.querySelectorAll('.docs-nav a, #pageNav a')];
const routeChoices = [...document.querySelectorAll('[data-route-choice]')];
const routeStatus = document.querySelector('#routeStatus');
const routeStatusLabel = document.querySelector('#routeStatusLabel');
const routeSelectionNote = document.querySelector('#routeSelectionNote');
const numberedSections = [...document.querySelectorAll('main > .section:not(.hero)')];

const routeLabels = {
  vps: 'VPS · Ubuntu',
  local: 'Local · Windows',
};

function renumberVisibleSections() {
  const visibleSections = numberedSections.filter((section) => getComputedStyle(section).display !== 'none');
  visibleSections.forEach((section, index) => {
    const number = section.querySelector(':scope > .section-heading > span');
    if (number) number.textContent = String(index + 1).padStart(2, '0');
  });
}

function applyRoute(route, persist = true) {
  if (!routeLabels[route]) return;
  document.body.dataset.route = route;
  if (persist) localStorage.setItem('polyester-guide-route', route);

  routeChoices.forEach((choice) => {
    const selected = choice.dataset.routeChoice === route;
    choice.classList.toggle('active', selected);
    choice.setAttribute('aria-pressed', String(selected));
  });

  routeStatus.hidden = false;
  routeStatusLabel.textContent = routeLabels[route];
  routeSelectionNote.textContent = route === 'vps'
    ? 'VPS path selected — continue with choosing an Ubuntu server.'
    : 'Local path selected — VPS and SSH steps are now skipped.';

  requestAnimationFrame(renumberVisibleSections);
}

routeChoices.forEach((choice) => {
  choice.addEventListener('click', () => applyRoute(choice.dataset.routeChoice));
});

const savedRoute = localStorage.getItem('polyester-guide-route');
if (routeLabels[savedRoute]) applyRoute(savedRoute, false);
else renumberVisibleSections();

function setMenu(open) {
  sidebar.classList.toggle('open', open);
  sidebarOverlay.classList.toggle('show', open);
  menuToggle.setAttribute('aria-expanded', String(open));
  document.body.style.overflow = open ? 'hidden' : '';
}

menuToggle?.addEventListener('click', () => setMenu(!sidebar.classList.contains('open')));
sidebarOverlay?.addEventListener('click', () => setMenu(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setMenu(false);
});

document.querySelectorAll('.docs-nav a').forEach((link) => {
  link.addEventListener('click', () => setMenu(false));
});

const observer = new IntersectionObserver((entries) => {
  const visible = entries
    .filter((entry) => entry.isIntersecting)
    .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
  if (!visible) return;
  navLinks.forEach((link) => link.classList.toggle('active', link.hash === `#${visible.target.id}`));
}, { rootMargin: '-15% 0px -67% 0px', threshold: [0, .15, .4] });

sections.forEach((section) => observer.observe(section));

function updateProgress() {
  const distance = document.documentElement.scrollHeight - window.innerHeight;
  const ratio = distance > 0 ? window.scrollY / distance : 0;
  progress.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
}

window.addEventListener('scroll', updateProgress, { passive: true });
updateProgress();

let toastTimer;
document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = 'Copied';
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.classList.remove('show');
        button.textContent = 'Copy';
      }, 1600);
    } catch {
      toast.textContent = 'Select and copy the command manually';
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2200);
    }
  });
});

document.querySelector('#year').textContent = new Date().getFullYear();
