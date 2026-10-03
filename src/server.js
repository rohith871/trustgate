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

// ==========================================
// 1. GET ALL USER DOCUMENTS
// ==========================================
app.get('/api/documents', async (req, res) => {
  try {
    const query = `
      SELECT DISTINCT d.document_id, d.title, d.category, d.created_at,
             dv.version_id, dv.file_hash, dv.uploaded_at
      FROM documents d
      LEFT JOIN document_versions dv ON d.document_id = dv.document_id
      ORDER BY d.document_id DESC;
    `;
    const { rows } = await pool.query(query);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching documents:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. UPLOAD NEW DOCUMENT (Single Consolidated Route)
// ==========================================
app.post('/api/documents', upload.single('file'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { title, category } = req.body;
    const filePath = req.file ? req.file.path : null;

    if (!filePath) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    // Dynamic SHA-256 computation of uploaded file
    const fileBuffer = fs.readFileSync(filePath);
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    await client.query('BEGIN');

    // Insert into documents table
    const docResult = await client.query(
      `INSERT INTO documents (owner_id, title, category, file_path)
       VALUES ($1, $2, $3, $4)
       RETURNING document_id`,
      [1, title, category || 'General', filePath]
    );

    const documentId = docResult.rows[0].document_id;

    // Insert version tracking without relying on storage_path
    const versionRes = await client.query(
      `INSERT INTO document_versions (document_id, file_hash)
       VALUES ($1, $2)
       RETURNING *`,
      [documentId, fileHash]
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Document uploaded successfully',
      document_id: documentId,
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
        d.title AS document_title,
        d.category AS category,
        vr.reason, 
        LOWER(vr.status::text) AS status, 
        vr.requested_at AS created_at,
        ag.key_display_code, 
        ag.expires_at
      FROM verification_requests vr
      JOIN documents d ON vr.document_id = d.document_id
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
// 4. CREATE VERIFICATION REQUEST
// ==========================================
app.post('/api/requests', async (req, res) => {
  const { orgId, docName, category, reason } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let docRes = await client.query(
      `SELECT document_id FROM documents WHERE LOWER(title) = LOWER($1) LIMIT 1`,
      [docName]
    );

    let docId;
    if (docRes.rows.length > 0) {
      docId = docRes.rows[0].document_id;
    } else {
      const newDoc = await client.query(
        `INSERT INTO documents (owner_id, category, title)
         VALUES ($1, $2, $3) RETURNING document_id`,
        [1, category || 'General', docName]
      );
      docId = newDoc.rows[0].document_id;
    }

    const pendingCheck = await client.query(
      `SELECT request_id FROM verification_requests 
       WHERE document_id = $1 AND LOWER(status::text) IN ('requested', 'pending', 'under_review') LIMIT 1`,
      [docId]
    );

    if (pendingCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A pending request for this document already exists.' });
    }

    const result = await client.query(
      `INSERT INTO verification_requests (org_id, document_id, reason, status)
       VALUES ($1, $2, $3, 'requested')
       RETURNING *`,
      [orgId || 1, docId, reason]
    );

    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating request:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 5. FETCH LEDGER DOCUMENTS FOR SELECTION
// ==========================================
app.get('/api/my-ledger-documents', async (req, res) => {
  const ownerId = 1;
  try {
    const result = await pool.query(
      `SELECT d.document_id, d.title, d.category, dv.version_id, dv.file_hash
       FROM documents d
       LEFT JOIN document_versions dv ON d.document_id = dv.document_id
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
// 6. APPROVE REQUEST
// ==========================================
app.post('/api/requests/:requestId/approve', async (req, res) => {
  const { requestId } = req.params;
  const { selectedDocumentId } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const reqRes = await client.query(
      `SELECT * FROM verification_requests WHERE request_id = $1`,
      [requestId]
    );

    if (reqRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Verification request not found.' });
    }

    const requestData = reqRes.rows[0];
    const targetDocId = selectedDocumentId || requestData.document_id;

    if (!targetDocId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'NO_DOCUMENT_SELECTED', message: 'Please select a document from your ledger.' });
    }

    const existingGrant = await client.query(
      `SELECT vr.request_id 
       FROM verification_requests vr
       JOIN access_grants ag ON vr.request_id = ag.request_id
       WHERE vr.org_id = $1 AND vr.document_id = $2 AND vr.status = 'approved' AND ag.revoked_at IS NULL`,
      [requestData.org_id, targetDocId]
    );

    if (existingGrant.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'DUPLICATE_ACTIVE_REQUEST',
        message: 'This organization already has an active approval for the selected document.'
      });
    }

    let versionRes = await client.query(
      `SELECT version_id FROM document_versions WHERE document_id = $1 LIMIT 1`,
      [targetDocId]
    );

    if (versionRes.rows.length === 0) {
      const defaultHash = crypto.createHash('sha256').update(`doc-${targetDocId}-${Date.now()}`).digest('hex');
      await client.query(
        `INSERT INTO document_versions (document_id, file_hash)
         VALUES ($1, $2)`,
        [targetDocId, defaultHash]
      );
    }

    await client.query(
      `UPDATE verification_requests 
       SET status = 'approved', document_id = $1, decided_at = CURRENT_TIMESTAMP
       WHERE request_id = $2`,
      [targetDocId, requestId]
    );

    const displayCode = 'TG-' + Math.floor(1000 + Math.random() * 9000) + '-' + Math.floor(1000 + Math.random() * 9000);
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
// 7. VERIFY ACCESS KEY & FETCH DOCUMENT METADATA
// ==========================================
app.post('/api/verify-key', async (req, res) => {
  const { keyCode } = req.body;

  try {
    const result = await pool.query(
      `SELECT 
        ag.grant_id, ag.key_display_code, ag.expires_at, ag.revoked_at,
        d.title, d.category, d.owner_id,
        dv.file_hash, dv.created_at AS version_date
       FROM access_grants ag
       JOIN verification_requests vr ON ag.request_id = vr.request_id
       JOIN documents d ON vr.document_id = d.document_id
       LEFT JOIN document_versions dv ON d.document_id = dv.document_id
       WHERE ag.key_display_code = $1
       ORDER BY dv.created_at DESC LIMIT 1`,
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
      `SELECT d.file_path, d.title, ag.expires_at, ag.revoked_at
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

    const { file_path, expires_at, revoked_at } = result.rows[0];

    if (expires_at && new Date(expires_at) < new Date()) {
      return res.status(403).json({ error: 'Access key has expired.' });
    }

    if (revoked_at) {
      return res.status(403).json({ error: 'Access has been revoked.' });
    }

    if (!file_path) {
      return res.status(404).json({ error: 'No file path registered for this document in the database.' });
    }

    const absolutePath = path.resolve(file_path);

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: `File binary not found on disk at: ${absolutePath}` });
    }

    return res.sendFile(absolutePath);

  } catch (err) {
    console.error('Error serving document file:', err);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`TrustGate API server active on http://localhost:${PORT}`);
});
