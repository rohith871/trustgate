const express = require('express');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

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
      INNER JOIN document_versions dv ON d.document_id = dv.document_id
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
// 2. UPLOAD NEW DOCUMENT
// ==========================================
app.post('/api/documents', async (req, res) => {
  const { title, category, fileHash } = req.body;
  const ownerId = 1;
  const finalHash = fileHash || ('a1b2c3d4e5f67890' + '0'.repeat(48));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let docRes = await client.query(
      `SELECT document_id FROM documents WHERE LOWER(title) = LOWER($1) AND owner_id = $2 LIMIT 1`,
      [title, ownerId]
    );

    let docId;
    if (docRes.rows.length > 0) {
      docId = docRes.rows[0].document_id;
    } else {
      const newDoc = await client.query(
        `INSERT INTO documents (owner_id, category, title)
         VALUES ($1, $2, $3) RETURNING document_id`,
        [ownerId, category || 'General', title]
      );
      docId = newDoc.rows[0].document_id;
    }

    const verRes = await client.query(
      `INSERT INTO document_versions (document_id, previous_version_id, file_hash)
       VALUES ($1, NULL, $2) RETURNING version_id, file_hash`,
      [docId, finalHash]
    );

    await client.query('COMMIT');
    res.status(201).json({ document_id: docId, title, category, version: verRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error uploading document:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 3. GET ALL VERIFICATION REQUESTS
// ==========================================
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
// 5. APPROVE REQUEST
// ==========================================
app.post('/api/requests/:requestId/approve', async (req, res) => {
  const { requestId } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch the request along with document details
    const reqRes = await client.query(
      `SELECT vr.*, d.document_id, dv.version_id 
       FROM verification_requests vr
       JOIN documents d ON vr.document_id = d.document_id
       LEFT JOIN document_versions dv ON d.document_id = dv.document_id
       WHERE vr.request_id = $1`,
      [requestId]
    );

    if (reqRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Verification request not found.' });
    }

    const requestData = reqRes.rows[0];

    // Check if the actual document version exists
    if (!requestData.version_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: 'DOCUMENT_MISSING', 
        message: 'No uploaded document version found for this request. Please upload the document to your repository first.' 
      });
    }

    // Update request status
    await client.query(
      `UPDATE verification_requests 
       SET status = 'approved', decided_at = CURRENT_TIMESTAMP
       WHERE request_id = $1`,
      [requestId]
    );

    const displayCode = 'TG-' + Math.floor(1000 + Math.random() * 9000) + '-' + Math.floor(1000 + Math.random() * 9000);
    const keyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    // Insert access grant using exact table schema (key_hash, key_display_code)
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`TrustGate API server active on http://localhost:${PORT}`);
});
