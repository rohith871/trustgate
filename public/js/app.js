/* ============================================================
   TrustGate — Real-time Client Application Logic
   ============================================================ */

document.addEventListener('DOMContentLoaded', async () => {
  if (typeof initTabNav === 'function') {
    initTabNav();
  }

  const isIndividualPage = !!document.getElementById('myDocsBody');
  const isOrgPage = !!document.getElementById('orgGate') || !!document.getElementById('sentBody');

  if (isIndividualPage) {
    initIndividualDashboard();
  } else if (isOrgPage) {
    initOrgDashboard();
  }
});

/* ============================================================
   INDIVIDUAL DASHBOARD LOGIC
   ============================================================ */

function initIndividualDashboard() {
  renderIndividualAll();
  setInterval(renderIndividualAll, 2500);
}

function openUploadModal(preselectCategory) {
  const modal = document.getElementById('uploadModalScrim');
  if (modal) modal.style.display = 'flex';

  if (preselectCategory) {
    const categorySelect = document.getElementById('doc-category');
    if (categorySelect) categorySelect.value = preselectCategory;
  }
}

function closeUploadModal() {
  const modal = document.getElementById('uploadModalScrim');
  if (modal) modal.style.display = 'none';

  const fileInput = document.getElementById('doc-file');
  if (fileInput) fileInput.value = '';

  const titleInput = document.getElementById('doc-title');
  if (titleInput) titleInput.value = '';

  const uploadLabel = document.getElementById('file-upload-label');
  if (uploadLabel) uploadLabel.textContent = 'Click to choose a file from your computer';
}

function handleFileSelect(input) {
  if (input.files && input.files[0]) {
    const selectedFile = input.files[0];
    const titleInput = document.getElementById('doc-title');
    if (titleInput && !titleInput.value) {
      titleInput.value = selectedFile.name.replace(/\.[^/.]+$/, '');
    }
    const uploadLabel = document.getElementById('file-upload-label');
    if (uploadLabel) uploadLabel.textContent = `Selected: ${selectedFile.name}`;
  }
}

async function handleDocumentUpload(event) {
  event.preventDefault();

  const titleInput = document.getElementById('doc-title');
  const categorySelect = document.getElementById('doc-category');
  const fileInput = document.getElementById('doc-file');

  if (!categorySelect.value) {
    alert('Please select a document category.');
    return;
  }

  const formData = new FormData();
  formData.append('title', titleInput.value || categorySelect.value);
  formData.append('category', categorySelect.value);
  if (fileInput.files[0]) {
    formData.append('file', fileInput.files[0]);
  }

  try {
    const res = await fetch('/api/documents/upload', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();

    if (res.ok) {
      alert(`✓ Document saved to ledger!\nCategory: ${data.category}\nHash: ${data.version.file_hash.substring(0, 16)}...`);
      closeUploadModal();
      renderIndividualAll();
    } else {
      alert('Upload Error: ' + (data.message || data.error));
    }
  } catch (err) {
    console.error('Document upload error:', err);
    alert('Failed to connect to backend server.');
  }
}

async function filterDocuments(query) {
  const term = query.toLowerCase().trim();
  try {
    const res = await fetch('/api/documents');
    const docs = await res.json();
    const filtered = docs.filter(d => 
      (d.title && d.title.toLowerCase().includes(term)) || 
      (d.category && d.category.toLowerCase().includes(term))
    );
    renderMyDocumentsList(filtered);
  } catch (err) {
    console.error('Filter error:', err);
  }
}

async function renderMyDocuments() {
  try {
    const res = await fetch('/api/documents');
    const docs = await res.json();
    renderMyDocumentsList(docs);
  } catch (err) {
    console.error('Error fetching documents:', err);
  }
}

function renderMyDocumentsList(docs) {
  const body = document.getElementById('myDocsBody');
  const docCountEl = document.getElementById('statDocCount');

  if (docCountEl) docCountEl.textContent = docs.length;
  if (!body) return;

  body.innerHTML = docs.length ? docs.map((d) => {
    const hashStr = d.file_hash ? d.file_hash.substring(0, 16) + '...' : 'Pending';
    const verText = d.version_count ? `v${d.version_count}.0` : 'v1.0';
    return `<tr class="row" onclick="openDrawer(${d.document_id})">
      <td><div class="doc-name">${d.category}</div><div class="doc-meta">Label: ${d.title || d.category}</div></td>
      <td><span class="version-chip">${verText}</span></td>
      <td><span class="hash">${hashStr}</span></td>
      <td><span class="badge approved">Stored</span></td>
      <td><div class="row-actions"><button class="icon-btn" onclick="event.stopPropagation()">↗</button></div></td>
    </tr>`;
  }).join('') : `<tr><td colspan="5" style="color:var(--ink-faint); text-align:center; padding:32px;">No category documents stored yet.</td></tr>`;
}

async function renderIncoming() {
  const incomingBody = document.getElementById('incomingBody');
  if (!incomingBody) return;

  try {
    const res = await fetch('/api/requests');
    const requests = await res.json();

    const pending = requests.filter(r => {
      const s = (r.status || '').toLowerCase();
      return s === 'requested' || s === 'pending' || s === 'under_review';
    });

    const countEl = document.getElementById('incomingCount');
    if (countEl) countEl.textContent = `Waiting on you (${pending.length})`;

    const navCount = document.getElementById('navIncomingCount') || document.querySelector('.nav-item[data-view="incoming"] .nav-count');
    if (navCount) navCount.textContent = pending.length;

    const statAwaitingNum = document.getElementById('statAwaitingNum') || document.querySelector('#statAwaiting .stat-num');
    if (statAwaitingNum) statAwaitingNum.textContent = pending.length;

    incomingBody.innerHTML = pending.length ? pending.map((r) => {
      const formattedDate = r.created_at ? new Date(r.created_at).toLocaleDateString() : 'Just now';
      return `
        <tr class="row">
          <td><div class="doc-name">${r.category}</div><div class="doc-meta">Requested: ${r.document_title}</div></td>
          <td>Organization #${r.org_id || 1}</td>
          <td class="doc-meta">${r.reason || 'Verification request'}</td>
          <td class="expiry">${formattedDate}</td>
          <td><div class="row-actions">
            <button class="icon-btn accept" onclick="handleApprove(${r.request_id})">✓ Approve</button>
          </div></td>
        </tr>`;
    }).join('')
      : `<tr><td colspan="5" style="color:var(--ink-faint); text-align:center; padding:32px;">Nothing waiting — you're all caught up.</td></tr>`;
  } catch (err) {
    console.error('Error fetching incoming requests:', err);
  }
}

async function renderSharedAccess() {
  const sharedBody = document.getElementById('sharedBody');
  if (!sharedBody) return;

  try {
    const res = await fetch('/api/requests');
    const requests = await res.json();
    const approved = requests.filter(r => (r.status || '').toLowerCase() === 'approved');

    const navCount = document.getElementById('navSharedCount') || document.querySelector('.nav-item[data-view="sharedAccess"] .nav-count');
    if (navCount) navCount.textContent = approved.length;

    const statKeysNum = document.getElementById('statKeysNum') || document.querySelector('#statKeys .stat-num');
    if (statKeysNum) statKeysNum.textContent = approved.length;

    sharedBody.innerHTML = approved.length ? approved.map((r) => `
      <tr class="row">
        <td><div class="doc-name">${r.category}</div><div class="doc-meta">${r.document_title}</div></td>
        <td>Organization #${r.org_id || 1}</td>
        <td><span class="key-chip">${r.key_display_code || 'TG-ACTIVE'}</span></td>
        <td class="expiry">24 Hours</td>
        <td><div class="row-actions"><span class="badge approved">Active</span></div></td>
      </tr>`).join('')
      : `<tr><td colspan="5" style="color:var(--ink-faint); text-align:center; padding:32px;">No active keys yet.</td></tr>`;
  } catch (err) {
    console.error('Error fetching shared access:', err);
  }
}

async function renderAuditLogs() {
  try {
    const res = await fetch('/api/audit-logs');
    const logs = await res.json();

    const formattedLogs = logs.map(l => ({
      time: new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      main: `${l.actor_type} perform ${l.action} on ${l.entity_type} #${l.entity_id}`,
      sub: l.metadata ? JSON.stringify(l.metadata) : ''
    }));

    if (typeof renderAuditList === 'function') {
      renderAuditList('auditIndividualBody', formattedLogs);
      renderAuditList('auditOrgBody', formattedLogs);
      renderAuditList('auditOrgBody2', formattedLogs);
    }
  } catch (err) {
    console.error('Error fetching audit logs:', err);
  }
}

async function renderIndividualAll() {
  await renderMyDocuments();
  await renderIncoming();
  await renderSharedAccess();
  await renderAuditLogs();
}

// Single-click automatic category approval
async function handleApprove(requestId) {
  try {
    const approveRes = await fetch(`/api/requests/${requestId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await approveRes.json();

    if (approveRes.ok) {
      if (typeof openKeyModal === 'function' && data.grant) {
        openKeyModal('Organization #1', 'Category Document', data.grant.key_display_code, 'Expires in 24 hours');
      } else {
        alert(`✓ Access Granted Automatically!\nAccess Key: ${data.grant.key_display_code}`);
      }
      renderIndividualAll();
    } else if (data.error === 'NO_DOCUMENT_FOR_CATEGORY') {
      const wantUpload = confirm(`You do not have a document stored for category '${data.category}' yet.\n\nWould you like to upload a document for '${data.category}' now?`);
      if (wantUpload) {
        openUploadModal(data.category);
      }
    } else {
      alert('Approval Error: ' + (data.message || data.error));
    }
  } catch (err) {
    console.error('Approval submission error:', err);
    alert('Failed to send approval decision to server.');
  }
}

async function openDrawer(docId) {
  try {
    const res = await fetch('/api/documents');
    const docs = await res.json();
    const d = docs.find(item => item.document_id === docId);
    if (!d) return;

    const titleEl = document.getElementById('d-title');
    const metaEl = document.getElementById('d-meta');
    const hashEl = document.getElementById('d-hash');
    const chainEl = document.getElementById('d-chain');

    if (titleEl) titleEl.textContent = d.category;
    if (metaEl) metaEl.textContent = `Title: ${d.title} | Versions: ${d.version_count || 1}`;
    if (hashEl) hashEl.textContent = d.file_hash || 'N/A';

    if (chainEl) {
      chainEl.innerHTML = `<div class="chain-item">
        <span class="chain-v">v${d.version_count || 1}.0 (Latest)</span>
        <span class="chain-hash">${d.file_hash ? d.file_hash.substring(0, 16) + '...' : 'N/A'}</span>
      </div>`;
    }

    document.getElementById('scrim')?.classList.add('open');
    document.getElementById('drawer')?.classList.add('open');
  } catch (err) {
    console.error('Error opening drawer:', err);
  }
}

function closeDrawer() {
  document.getElementById('scrim')?.classList.remove('open');
  document.getElementById('drawer')?.classList.remove('open');
}

/* ============================================================
   ORGANIZATION DASHBOARD LOGIC
   ============================================================ */

function initOrgDashboard() {
  renderOrgAll();
  setInterval(renderOrgAll, 2500);
}

function handleOrgFileSelect(input) {
  if (input.files && input.files[0]) {
    const label = document.getElementById('orgUploadFileName');
    if (label) label.textContent = `Selected: ${input.files[0].name}`;
  }
}

function submitGate() {
  const gateForm = document.getElementById('gateForm');
  const gatePending = document.getElementById('gatePending');
  if (gateForm) gateForm.style.display = 'none';
  if (gatePending) gatePending.style.display = 'block';
}

function approveGate() {
  const gatePending = document.getElementById('gatePending');
  const gateApproved = document.getElementById('gateApproved');
  if (gatePending) gatePending.style.display = 'none';
  if (gateApproved) gateApproved.style.display = 'block';
}

function enterOrgApp() {
  const gate = document.getElementById('orgGate');
  const app = document.getElementById('orgApp');
  if (gate) gate.style.display = 'none';
  if (app) app.style.display = 'block';
  renderOrgAll();
}

async function renderOverviewStats() {
  try {
    const res = await fetch('/api/requests');
    const requests = await res.json();

    const approved = requests.filter(r => (r.status || '').toLowerCase() === 'approved');
    const pending = requests.filter(r => {
      const s = (r.status || '').toLowerCase();
      return s === 'requested' || s === 'pending' || s === 'under_review';
    });

    const statReceived = document.getElementById('statReceived');
    const statPending = document.getElementById('statPending');
    const statSent = document.getElementById('statSent');

    if (statReceived) statReceived.textContent = approved.length;
    if (statPending) statPending.textContent = pending.length;
    if (statSent) statSent.textContent = requests.length;
  } catch (err) {
    console.error('Error rendering org stats:', err);
  }
}

async function renderRequestsSent() {
  const sentBody = document.getElementById('sentBody');
  if (!sentBody) return;

  try {
    const res = await fetch('/api/requests');
    const requests = await res.json();

    sentBody.innerHTML = requests.length ? requests.map((r) => {
      const statusText = r.status ? r.status.toUpperCase() : 'PENDING';
      const formattedDate = r.created_at ? new Date(r.created_at).toLocaleDateString() : 'Just now';
      return `
        <tr class="row">
          <td><div class="doc-name">${r.category}</div><div class="doc-meta">${r.document_title}</div></td>
          <td>Individual User</td>
          <td><span class="badge ${(r.status || '').toLowerCase()}">${statusText}</span></td>
          <td class="expiry">${formattedDate}</td>
        </tr>`;
    }).join('')
      : `<tr><td colspan="4" style="color:var(--ink-faint); text-align:center; padding:32px;">No requests sent yet.</td></tr>`;

    const navCount = document.querySelector('.nav-item[data-view="requestsSent"] .nav-count');
    if (navCount) navCount.textContent = requests.length;
  } catch (err) {
    console.error('Error rendering sent requests:', err);
  }
}

async function renderDocsReceived() {
  const receivedBody = document.getElementById('receivedBody');
  if (!receivedBody) return;

  try {
    const res = await fetch('/api/requests');
    const requests = await res.json();
    const approved = requests.filter(r => (r.status || '').toLowerCase() === 'approved');

    receivedBody.innerHTML = approved.length ? approved.map((r) => `
      <tr class="row">
        <td><div class="doc-name">${r.category}</div><div class="doc-meta">${r.document_title}</div></td>
        <td>Individual User</td>
        <td><span class="key-chip">${r.key_display_code || 'GRANTED'}</span></td>
        <td class="expiry">Valid</td>
        <td>
          <a href="/api/documents/download/${r.key_display_code}" 
             target="_blank" 
             style="padding: 6px 12px; background-color: #2563eb; color: #ffffff; border-radius: 4px; text-decoration: none; font-size: 13px; font-weight: 500; display: inline-block;">
            View Document
          </a>
        </td>
      </tr>`)
      : `<tr><td colspan="5" style="color:var(--ink-faint); text-align:center; padding:32px;">Nothing received yet.</td></tr>`;
  } catch (err) {
    console.error('Error rendering received docs:', err);
  }
}

function renderOrgAll() {
  renderOverviewStats();
  renderRequestsSent();
  renderDocsReceived();
  renderAuditLogs();
}

async function sendNewRequest() {
  const docInput = document.getElementById('reqDocName');
  const catInput = document.getElementById('reqCategory');
  const reasonInput = document.getElementById('reqReason');

  if (!catInput || !reasonInput) return;

  const category = catInput.value.trim();
  const docName = docInput && docInput.value.trim() ? docInput.value.trim() : category;
  const reason = reasonInput.value.trim();

  if (!category || !reason) {
    alert('Please provide category and reason.');
    return;
  }

  try {
    const res = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        orgId: 1,
        docName: docName,
        category: category,
        reason: reason 
      })
    });

    const data = await res.json();

    if (res.ok) {
      alert('Request sent successfully!');
      if (docInput) docInput.value = '';
      reasonInput.value = '';
      renderOrgAll();
    } else {
      alert('Failed to send request: ' + (data.error || 'Duplicate or invalid request'));
    }
  } catch (err) {
    console.error('Error submitting request:', err);
  }
}
