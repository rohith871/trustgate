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
  setInterval(renderIndividualAll, 2000);
}

function openUploadModal() {
  const modal = document.getElementById('uploadModalScrim');
  if (modal) modal.style.display = 'flex';
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

async function handleDocumentUpload(e) {
  if (e) e.preventDefault();

  const titleInput = document.getElementById('doc-title');
  const categoryInput = document.getElementById('doc-category');

  const title = titleInput ? titleInput.value.trim() : '';
  const category = categoryInput ? categoryInput.value : 'General';

  if (!title) {
    alert('Please enter a document title.');
    return;
  }

  try {
    const response = await fetch('/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, category })
    });

    if (response.ok) {
      closeUploadModal();
      renderIndividualAll();
    } else {
      const err = await response.json();
      alert('Upload failed: ' + (err.error || 'Unknown error'));
    }
  } catch (err) {
    console.error('Database insertion error:', err);
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
    return `<tr class="row" onclick="openDrawer(${d.document_id})">
      <td><div class="doc-name">${d.title || 'Untitled Document'}</div><div class="doc-meta">Category: ${d.category || 'General'}</div></td>
      <td><span class="version-chip">v1.0</span></td>
      <td><span class="hash">${hashStr}</span></td>
      <td><span class="badge approved">Stored</span></td>
      <td><div class="row-actions"><button class="icon-btn" onclick="event.stopPropagation()">↗</button></div></td>
    </tr>`;
  }).join('') : `<tr><td colspan="5" style="color:var(--ink-faint); text-align:center; padding:32px;">No documents stored.</td></tr>`;
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
          <td><div class="doc-name">${r.document_title || 'Requested Document'}</div></td>
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
        <td><div class="doc-name">${r.document_title || 'Document'}</div></td>
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

async function renderIndividualAll() {
  await renderMyDocuments();
  await renderIncoming();
  await renderSharedAccess();
}

async function handleApprove(requestId) {
  try {
    const res = await fetch(`/api/requests/${requestId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await res.json();
    if (res.ok) {
      alert('✓ Request Approved!\nAccess Key Generated: ' + (data.grant ? data.grant.key_display_code : 'TG-ACTIVE'));
      renderIndividualAll();
    } else {
      if (data.error === 'DOCUMENT_MISSING') {
        const wantUpload = confirm(`${data.message}\n\nWould you like to open the upload modal now?`);
        if (wantUpload && typeof openUploadModal === 'function') {
          openUploadModal();
        }
      } else {
        alert('Approval error: ' + (data.message || data.error));
      }
    }
  } catch (err) {
    console.error('Approval failed:', err);
    alert('Failed to connect to backend server.');
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

    if (titleEl) titleEl.textContent = d.title;
    if (metaEl) metaEl.textContent = d.category;
    if (hashEl) hashEl.textContent = d.file_hash || 'N/A';

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
  setInterval(renderOrgAll, 2000);
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
          <td><div class="doc-name">${r.document_title || 'Document'}</div></td>
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
        <td><div class="doc-name">${r.document_title || 'Document'}</div></td>
        <td>Individual User</td>
        <td><span class="key-chip">${r.key_display_code || 'GRANTED'}</span></td>
        <td class="expiry">Valid</td>
      </tr>`)
      : `<tr><td colspan="4" style="color:var(--ink-faint); text-align:center; padding:32px;">Nothing received yet.</td></tr>`;
  } catch (err) {
    console.error('Error rendering received docs:', err);
  }
}

function renderOrgAll() {
  renderOverviewStats();
  renderRequestsSent();
  renderDocsReceived();
}

async function sendNewRequest() {
  const docInput = document.getElementById('reqDocName');
  const catInput = document.getElementById('reqCategory');
  const reasonInput = document.getElementById('reqReason');

  if (!docInput || !reasonInput) return;

  const docName = docInput.value.trim();
  const category = catInput ? catInput.value : 'KYC document';
  const reason = reasonInput.value.trim();

  if (!docName || !reason) {
    alert('Please provide document name and reason.');
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
      docInput.value = '';
      reasonInput.value = '';
      renderOrgAll();
    } else {
      alert('Failed to send request: ' + (data.error || 'Duplicate or invalid request'));
    }
  } catch (err) {
    console.error('Error submitting request:', err);
  }
}
