// Apply the saved theme before first paint to avoid a flash (external file so the CSP can stay strict).
try {
  var t = localStorage.getItem('cwc-theme') || 'system';
  var d = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', d);
} catch (e) {}
