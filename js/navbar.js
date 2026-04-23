// ============================================
// FitMerge - Navbar Logic
// Toggle menu mobile + highlight active link
// ============================================

function toggleNav() {
  const menu = document.getElementById('navbarMenu');
  if (menu) menu.classList.toggle('open');
}

function logout() {
  if (!confirm('Yakin ingin logout?')) return;
  localStorage.removeItem('fitmerge_user');
  window.location.href = getBase() + 'html/login.html';
}

function getBase() {
  const path = window.location.pathname;
  if (path.includes('/html/')) return '../';
  return './';
}

// Highlight active nav link based on current page
function highlightNav() {
  const current = window.location.pathname.split('/').pop() || 'index.html';
  const links = document.querySelectorAll('.navbar-menu a');
  links.forEach(link => {
    const href = link.getAttribute('href').split('/').pop();
    if (href === current) link.classList.add('active');
  });
}

document.addEventListener('DOMContentLoaded', highlightNav);
