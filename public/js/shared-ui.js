/* ============================================================
   TrustGate — shared UI helpers
   Used by both individual.html and organization.html:
   sidebar tab switching, and the access-key issuance modal.
   ============================================================ */

/* Wires up every .nav-item inside the page's sidebar to show the
   matching #id .view section and hide the rest. */
function initTabNav() {
  document.querySelectorAll('.sidebar nav .nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      const target = document.getElementById(item.dataset.view);
      if (target) target.classList.add('active');
    });
  });
}

function switchTab(viewId) {
  const item = document.querySelector(`.nav-item[data-view="${viewId}"]`);
  if (item) item.click();
}

function openKeyModal(org, doc, key, expiryText) {
  document.getElementById('modalOrg').textContent = org;
  document.getElementById('modalDoc').textContent = doc;
  document.getElementById('modalKey').textContent = key;
  if (expiryText) document.getElementById('modalExp').textContent = expiryText;
  document.getElementById('modalScrim').classList.add('open');
}
function closeModal() {
  document.getElementById('modalScrim').classList.remove('open');
}

function renderAuditList(containerId, entries) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = entries.length ? entries.map(a => `
    <div class="audit-item">
      <div class="audit-time">${a.time}</div>
      <div class="audit-dot"></div>
      <div class="audit-text">${a.main}${a.sub ? `<div class="audit-sub">${a.sub}</div>` : ''}</div>
    </div>`).join('') : `<div class="audit-item"><div class="audit-text" style="color:var(--ink-faint)">No activity yet.</div></div>`;
}
