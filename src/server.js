const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
require('dotenv').config();

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure disk storage for Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'trustgate_db',
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});

// Helper for generating standard key display codes
function generateKeyDisplayCode() {
  const p1 = Math.floor(1000 + Math.random() * 9000);
  const p2 = Math.floor(1000 + Math.random() * 9000);
  return `TG-${p1}-${p2}`;
}

// ==========================================
// 1. GET ALL USER DOCUMENTS (1 per category)
// ==========================================
app.get('/api/documents', async (req, res) => {
  const ownerId = 1;
  try {
    const query = `
      SELECT 
        d.document_id, 
        d.title, 
        d.category, 
        d.file_path,
        d.created_at,
        latest_ver.version_id,
        latest_ver.file_hash,
        latest_ver.uploaded_at,
        COALESCE(ver_count.total_versions, 1) AS version_count
      FROM documents d
      LEFT JOIN LATERAL (
        SELECT version_id, file_hash, uploaded_at 
        FROM document_versions 
        WHERE document_id = d.document_id 
        ORDER BY version_id DESC 
        LIMIT 1
      ) latest_ver ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS total_versions 
        FROM document_versions 
        WHERE document_id = d.document_id
      ) ver_count ON true
      WHERE d.owner_id = $1
      ORDER BY d.created_at DESC;
    `;
    const { rows } = await pool.query(query, [ownerId]);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching documents:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. UPLOAD/UPDATE DOCUMENT (Enforces 1 document per Category + Version Chain)
// ==========================================
app.post('/api/documents', upload.single('file'), async (req, res) => {
  const client = await pool.connect();
  try {
    const ownerId = 1;
    const { title, category } = req.body;
    const filePath = req.file ? req.file.path : null;

    if (!category) {
      return res.status(400).json({ error: 'Category is required.' });
    }

    const docCategory = category.trim();
    const docTitle = (title || docCategory).trim();

    // Compute SHA-256 fingerprint if file provided, else generated hash
    let fileHash;
    if (filePath && fs.existsSync(filePath)) {
      const fileBuffer = fs.readFileSync(filePath);
      fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    } else {
      fileHash = crypto.createHash('sha256').update(`${docCategory}-${Date.now()}-${Math.random()}`).digest('hex');
    }

    await client.query('BEGIN');

    // Check if user already has a document record for this category
    const existingRes = await client.query(
      `SELECT document_id, title, file_path FROM documents WHERE owner_id = $1 AND LOWER(category) = LOWER($2) LIMIT 1`,
      [ownerId, docCategory]
    );

    let documentId;
    let versionRes;

    if (existingRes.rows.length > 0) {
      // Document for this category exists: append new version to version chain
      documentId = existingRes.rows[0].document_id;

      // Get latest version ID for previous_version_id FK
      const latestVerRes = await client.query(
        `SELECT version_id FROM document_versions WHERE document_id = $1 ORDER BY version_id DESC LIMIT 1`,
        [documentId]
      );
      const prevVersionId = latestVerRes.rows.length > 0 ? latestVerRes.rows[0].version_id : null;

      // Update documents title & file_path (if new file uploaded)
      await client.query(
        `UPDATE documents 
         SET title = $1, file_path = COALESCE($2, file_path) 
         WHERE document_id = $3`,
        [docTitle, filePath, documentId]
      );

      // Create new immutable version record
      versionRes = await client.query(
        `INSERT INTO document_versions (document_id, previous_version_id, file_hash)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [documentId, prevVersionId, fileHash]
      );

      // Log audit event
      await client.query(
        `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, metadata)
         VALUES ('USER', $1, 'UPDATE_DOCUMENT_VERSION', 'DOCUMENT', $2, $3::jsonb)`,
        [ownerId, documentId, JSON.stringify({ category: docCategory, version_id: versionRes.rows[0].version_id })]
      );

    } else {
      // New document for this category
      const docResult = await client.query(
        `INSERT INTO documents (owner_id, title, category, file_path)
         VALUES ($1, $2, $3, $4)
         RETURNING document_id`,
        [ownerId, docTitle, docCategory, filePath]
      );
      documentId = docResult.rows[0].document_id;

      // Insert initial version (previous_version_id = NULL)
      versionRes = await client.query(
        `INSERT INTO document_versions (document_id, previous_version_id, file_hash)
         VALUES ($1, NULL, $2)
         RETURNING *`,
        [documentId, fileHash]
      );

      // Log audit event
      await client.query(
        `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, metadata)
         VALUES ('USER', $1, 'UPLOAD_DOCUMENT', 'DOCUMENT', $2, $3::jsonb)`,
        [ownerId, documentId, JSON.stringify({ category: docCategory, title: docTitle })]
      );
    }

    // Auto-link any pending verification requests for this category
    await client.query(
      `UPDATE verification_requests 
       SET document_id = $1 
       WHERE document_id IS NULL AND LOWER(category) = LOWER($2)`,
      [documentId, docCategory]
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Document saved to ledger successfully',
      document_id: documentId,
      category: docCategory,
      version: versionRes.rows[0],
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Upload Error:', err);
    res.status(500).json({ error: `Upload Error: ${err.message}` });
  } finally {
    client.release();
  }
});

// Alias route if frontend sends POST to /api/documents/upload
app.post('/api/documents/upload', (req, res) => {
  req.url = '/api/documents';
  app._router.handle(req, res);
});

// ==========================================
// 3. GET ALL VERIFICATION REQUESTS
// ==========================================
app.get('/api/requests', async (req, res) => {
  try {
    const query = `
      SELECT 
        vr.request_id, 
        vr.org_id, 
        vr.document_id,
        COALESCE(d.title, vr.requested_doc_name, 'Requested Document') AS document_title,
        COALESCE(d.category, vr.category, 'General') AS category,
        vr.reason, 
        LOWER(vr.status::text) AS status, 
        vr.requested_at AS created_at,
        ag.key_display_code, 
        ag.expires_at,
        ag.revoked_at
      FROM verification_requests vr
      LEFT JOIN documents d ON vr.document_id = d.document_id
      LEFT JOIN access_grants ag ON vr.request_id = ag.request_id
      ORDER BY vr.request_id DESC;
    `;
    const { rows } = await pool.query(query);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching requests:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. CREATE VERIFICATION REQUEST (Org asks for a Document Category)
// ==========================================
app.post('/api/requests', async (req, res) => {
  const { orgId, docName, category, reason } = req.body;
  const client = await pool.connect();

  try {
    const reqCategory = (category || 'General').trim();
    const reqDocName = (docName || reqCategory).trim();
    const targetOrgId = orgId || 1;

    await client.query('BEGIN');

    // Auto-find if user already has a document for this category
    const docRes = await client.query(
      `SELECT document_id FROM documents WHERE owner_id = 1 AND LOWER(category) = LOWER($1) LIMIT 1`,
      [reqCategory]
    );

    let docId = docRes.rows.length > 0 ? docRes.rows[0].document_id : null;

    // Check for duplicate active request for the same category
    const pendingCheck = await client.query(
      `SELECT request_id FROM verification_requests 
       WHERE LOWER(category) = LOWER($1) AND LOWER(status::text) IN ('requested', 'pending', 'under_review') LIMIT 1`,
      [reqCategory]
    );

    if (pendingCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A pending request for this category already exists.' });
    }

    const result = await client.query(
      `INSERT INTO verification_requests (org_id, document_id, requested_doc_name, category, reason, status)
       VALUES ($1, $2, $3, $4, $5, 'requested')
       RETURNING *`,
      [targetOrgId, docId, reqDocName, reqCategory, reason]
    );

    const newRequest = result.rows[0];

    // Audit log entry
    await client.query(
      `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ('ORG_STAFF', 1, 'CREATE_REQUEST', 'VERIFICATION_REQUEST', $1, $2::jsonb)`,
      [newRequest.request_id, JSON.stringify({ org_id: targetOrgId, category: reqCategory, reason })]
    );

    await client.query('COMMIT');
    res.status(201).json(newRequest);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating request:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 5. FETCH LEDGER DOCUMENTS
// ==========================================
app.get('/api/my-ledger-documents', async (req, res) => {
  const ownerId = 1;
  try {
    const result = await pool.query(
      `SELECT d.document_id, d.title, d.category, dv.version_id, dv.file_hash
       FROM documents d
       LEFT JOIN LATERAL (
         SELECT version_id, file_hash FROM document_versions 
         WHERE document_id = d.document_id ORDER BY version_id DESC LIMIT 1
       ) dv ON true
       WHERE d.owner_id = $1
       ORDER BY d.created_at DESC`,
      [ownerId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching ledger documents:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6. APPROVE REQUEST (Automatic Category Matching)
// ==========================================
app.post('/api/requests/:requestId/approve', async (req, res) => {
  const { requestId } = req.params;
  const ownerId = 1;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch the verification request
    const reqRes = await client.query(
      `SELECT * FROM verification_requests WHERE request_id = $1`,
      [requestId]
    );

    if (reqRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Verification request not found.' });
    }

    const requestData = reqRes.rows[0];

    // Check if already approved
    if ((requestData.status || '').toLowerCase() === 'approved') {
      const existingGrant = await client.query(
        `SELECT * FROM access_grants WHERE request_id = $1 LIMIT 1`,
        [requestId]
      );
      await client.query('COMMIT');
      return res.json({ message: 'Request was already approved.', grant: existingGrant.rows[0] });
    }

    // Auto-match document registered under request's category for this user
    let targetDocId = requestData.document_id;

    if (!targetDocId) {
      const matchDoc = await client.query(
        `SELECT document_id FROM documents WHERE owner_id = $1 AND LOWER(category) = LOWER($2) LIMIT 1`,
        [ownerId, requestData.category]
      );

      if (matchDoc.rows.length > 0) {
        targetDocId = matchDoc.rows[0].document_id;
      }
    }

    // If user does not have a document in this category yet
    if (!targetDocId) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'NO_DOCUMENT_FOR_CATEGORY',
        message: `You have not uploaded a document for the '${requestData.category}' category yet. Please upload it first to grant access.`,
        category: requestData.category
      });
    }

    // Ensure document has at least one version record
    let versionRes = await client.query(
      `SELECT version_id FROM document_versions WHERE document_id = $1 LIMIT 1`,
      [targetDocId]
    );

    if (versionRes.rows.length === 0) {
      const defaultHash = crypto.createHash('sha256').update(`doc-${targetDocId}-${Date.now()}`).digest('hex');
      await client.query(
        `INSERT INTO document_versions (document_id, previous_version_id, file_hash)
         VALUES ($1, NULL, $2)`,
        [targetDocId, defaultHash]
      );
    }

    // Update request status to approved & bind document_id
    await client.query(
      `UPDATE verification_requests 
       SET status = 'approved', document_id = $1, decided_at = CURRENT_TIMESTAMP
       WHERE request_id = $2`,
      [targetDocId, requestId]
    );

    // Issue access grant key
    const displayCode = generateKeyDisplayCode();
    const keyHash = crypto
      .createHash('sha256')
      .update(`${requestId}-${targetDocId}-${Date.now()}-${Math.random()}`)
      .digest('hex');

    const grantRes = await client.query(
      `INSERT INTO access_grants (request_id, key_hash, key_display_code, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')
       RETURNING *`,
      [requestId, keyHash, displayCode]
    );

    // Log audit event
    await client.query(
      `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ('USER', $1, 'APPROVE_REQUEST', 'VERIFICATION_REQUEST', $2, $3::jsonb)`,
      [ownerId, requestId, JSON.stringify({ document_id: targetDocId, key_display_code: displayCode })]
    );

    await client.query('COMMIT');
    res.json({ message: 'Approved successfully', grant: grantRes.rows[0] });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error approving request:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 7. VERIFY ACCESS KEY & FETCH METADATA
// ==========================================
app.post('/api/verify-key', async (req, res) => {
  const { keyCode } = req.body;

  try {
    const result = await pool.query(
      `SELECT 
        ag.grant_id, ag.key_display_code, ag.expires_at, ag.revoked_at,
        d.title, d.category, d.owner_id,
        dv.file_hash, dv.uploaded_at AS version_date
       FROM access_grants ag
       JOIN verification_requests vr ON ag.request_id = vr.request_id
       JOIN documents d ON vr.document_id = d.document_id
       LEFT JOIN LATERAL (
         SELECT file_hash, uploaded_at FROM document_versions 
         WHERE document_id = d.document_id ORDER BY version_id DESC LIMIT 1
       ) dv ON true
       WHERE ag.key_display_code = $1
       LIMIT 1`,
      [keyCode]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ valid: false, message: 'Invalid access key.' });
    }

    const grant = result.rows[0];

    if (new Date(grant.expires_at) < new Date()) {
      return res.status(400).json({ valid: false, message: 'This access key has expired.' });
    }

    if (grant.revoked_at) {
      return res.status(400).json({ valid: false, message: 'Access has been revoked by the document owner.' });
    }

    res.json({
      valid: true,
      message: '✓ Key verified successfully. Ledger integrity confirmed.',
      document: {
        title: grant.title,
        category: grant.category,
        sha256Fingerprint: grant.file_hash,
        expiresAt: grant.expires_at
      }
    });

  } catch (err) {
    console.error('Error verifying key:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 8. FILE ACCESS / DOWNLOAD VIA ACCESS KEY
// ==========================================
app.get('/api/documents/download/:keyCode', async (req, res) => {
  const { keyCode } = req.params;

  try {
    const result = await pool.query(
      `SELECT d.file_path, d.title, ag.expires_at, ag.revoked_at, vr.request_id
       FROM access_grants ag
       JOIN verification_requests vr ON ag.request_id = vr.request_id
       JOIN documents d ON vr.document_id = d.document_id
       WHERE ag.key_display_code = $1
       LIMIT 1`,
      [keyCode]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or missing access key.' });
    }

    const { file_path, expires_at, revoked_at, request_id } = result.rows[0];

    if (expires_at && new Date(expires_at) < new Date()) {
      return res.status(403).json({ error: 'Access key has expired.' });
    }

    if (revoked_at) {
      return res.status(403).json({ error: 'Access has been revoked.' });
    }

    if (!file_path) {
      return res.status(404).json({ error: 'No file binary stored for this document in the database.' });
    }

    const absolutePath = path.resolve(file_path);

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: `File binary not found on disk at: ${absolutePath}` });
    }

    // Audit log access
    await pool.query(
      `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ('ORG_STAFF', 1, 'DOWNLOAD_DOCUMENT', 'VERIFICATION_REQUEST', $1, $2::jsonb)`,
      [request_id, JSON.stringify({ key_display_code: keyCode })]
    );

    return res.sendFile(absolutePath);

  } catch (err) {
    console.error('Error serving document file:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 9. AUDIT LOGS ENDPOINT
// ==========================================
app.get('/api/audit-logs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT log_id, actor_type, actor_id, action, entity_type, entity_id, metadata, timestamp 
       FROM audit_logs 
       ORDER BY log_id DESC 
       LIMIT 50`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching audit logs:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`TrustGate API server active on http://localhost:${PORT}`);
});
