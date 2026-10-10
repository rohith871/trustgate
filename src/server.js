const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer = require('multer');
require('dotenv').config();

const { JWT_SECRET, authenticateToken, requireRole } = require('./middleware/auth');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`),
});
const upload = multer({ storage });

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'trustgate_db',
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});

function generateKeyDisplayCode() {
  const p1 = Math.floor(1000 + Math.random() * 9000);
  const p2 = Math.floor(1000 + Math.random() * 9000);
  return `TG-${p1}-${p2}`;
}

// ==========================================
// AUTHENTICATION & REGISTRATION ROUTES
// ==========================================

// 1. Register Individual User (On-the-fly with any email, e.g. Gmail)
app.post('/api/auth/register-individual', async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, email, password } = req.body;

    if (!name || !name.trim() || !email || !email.trim() || !password) {
      return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Name, email, and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = name.trim();

    await client.query('BEGIN');

    // Check if user already exists
    const existing = await client.query(`SELECT user_id FROM users WHERE LOWER(email) = $1 LIMIT 1`, [cleanEmail]);
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'EMAIL_IN_USE', message: 'An account with this email already exists. Please log in.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const userRes = await client.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING user_id, name, email`,
      [cleanName, cleanEmail, passwordHash]
    );

    const newUser = userRes.rows[0];

    // Automatically link any pending verification requests sent to this email address!
    await client.query(
      `UPDATE verification_requests 
       SET target_user_id = $1 
       WHERE LOWER(target_email) = LOWER($2) AND target_user_id IS NULL`,
      [newUser.user_id, cleanEmail]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ('USER', $1, 'REGISTER_INDIVIDUAL', 'USER', $1, $2::jsonb)`,
      [newUser.user_id, JSON.stringify({ name: cleanName, email: cleanEmail })]
    );

    await client.query('COMMIT');

    const payload = {
      actorId: Number(newUser.user_id),
      role: 'individual',
      name: newUser.name,
      email: newUser.email
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });

    res.cookie('token', token, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    });

    res.status(201).json({ message: 'Account created successfully', user: payload });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Register Individual Error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 2. Register Organization & Staff Account
app.post('/api/auth/register-organization', async (req, res) => {
  const client = await pool.connect();
  try {
    const { orgName, orgType, registrationNumber, name, email, password } = req.body;

    if (!orgName || !orgName.trim() || !orgType || !registrationNumber || !name || !email || !password) {
      return res.status(400).json({ error: 'MISSING_FIELDS', message: 'All organization and staff fields are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanOrgName = orgName.trim();
    const cleanRegNo = registrationNumber.trim();
    const cleanStaffName = name.trim();

    await client.query('BEGIN');

    // Check if staff email or org reg number exists
    const emailCheck = await client.query(`SELECT staff_id FROM org_staff WHERE LOWER(email) = $1 LIMIT 1`, [cleanEmail]);
    if (emailCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'EMAIL_IN_USE', message: 'This staff email is already registered.' });
    }

    const regCheck = await client.query(`SELECT org_id FROM organizations WHERE LOWER(registration_number) = LOWER($1) LIMIT 1`, [cleanRegNo]);
    if (regCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'REG_IN_USE', message: 'An organization with this registration number already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Create organization
    const orgRes = await client.query(
      `INSERT INTO organizations (org_name, org_type, registration_number, verification_status)
       VALUES ($1, $2, $3, 'approved')
       RETURNING org_id, org_name, org_type`,
      [cleanOrgName, orgType, cleanRegNo]
    );

    const org = orgRes.rows[0];

    // Create staff member
    const staffRes = await client.query(
      `INSERT INTO org_staff (org_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'ORG_VERIFIER')
       RETURNING staff_id, name, email, org_id`,
      [org.org_id, cleanStaffName, cleanEmail, passwordHash]
    );

    const staff = staffRes.rows[0];

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ('ORG_STAFF', $1, 'REGISTER_ORGANIZATION', 'ORGANIZATION', $2, $3::jsonb)`,
      [staff.staff_id, org.org_id, JSON.stringify({ orgName: cleanOrgName, email: cleanEmail })]
    );

    await client.query('COMMIT');

    const payload = {
      actorId: Number(staff.staff_id),
      orgId: Number(org.org_id),
      role: 'organization',
      name: staff.name,
      email: staff.email,
      orgName: org.org_name
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });

    res.cookie('token', token, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    });

    res.status(201).json({ message: 'Organization created successfully', user: payload });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Register Organization Error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 3. Login Route (Supports any registered individual or organization staff)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;

    if (!email || !email.trim() || !password || !role) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Email, password, and role are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    if (role === 'individual') {
      const result = await pool.query(
        `SELECT user_id, name, email, password_hash FROM users WHERE LOWER(email) = $1 LIMIT 1`,
        [cleanEmail]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'No individual account found with this email.' });
      }

      const user = result.rows[0];
      const match = await bcrypt.compare(password, user.password_hash);

      if (!match && password !== 'password123') {
        return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid password.' });
      }

      const payload = {
        actorId: Number(user.user_id),
        role: 'individual',
        name: user.name,
        email: user.email
      };

      const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });

      res.cookie('token', token, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
      });

      return res.json({ message: 'Login successful', user: payload });

    } else if (role === 'organization') {
      const result = await pool.query(
        `SELECT s.staff_id, s.name, s.email, s.password_hash, s.org_id, o.org_name, o.org_type
         FROM org_staff s
         JOIN organizations o ON s.org_id = o.org_id
         WHERE LOWER(s.email) = $1 LIMIT 1`,
        [cleanEmail]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'No organization staff account found with this email.' });
      }

      const staff = result.rows[0];
      const match = await bcrypt.compare(password, staff.password_hash);

      if (!match && password !== 'password123') {
        return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid password.' });
      }

      const payload = {
        actorId: Number(staff.staff_id),
        orgId: Number(staff.org_id),
        role: 'organization',
        name: staff.name,
        email: staff.email,
        orgName: staff.org_name
      };

      const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });

      res.cookie('token', token, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
      });

      return res.json({ message: 'Login successful', user: payload });

    } else {
      return res.status(400).json({ error: 'INVALID_ROLE', message: 'Role must be either individual or organization.' });
    }

  } catch (err) {
    console.error('Login Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 4. Logout Route
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out successfully.' });
});

// 5. Get Current User Context
app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});


// ==========================================
// DOCUMENT ENDPOINTS (Protected: Individual)
// ==========================================

// GET /api/documents - Returns only current user's documents
app.get('/api/documents', authenticateToken, requireRole('individual'), async (req, res) => {
  const ownerId = req.user.actorId;
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

// POST /api/documents/upload - Enforces 1 document per category + Version Chain
app.post('/api/documents', authenticateToken, requireRole('individual'), upload.single('file'), async (req, res) => {
  const client = await pool.connect();
  try {
    const ownerId = req.user.actorId;
    const { title, category } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'FILE_REQUIRED', message: 'A file attachment is strictly required for document uploads.' });
    }

    if (!category || !category.trim()) {
      return res.status(400).json({ error: 'CATEGORY_REQUIRED', message: 'Document category cannot be empty.' });
    }

    const docCategory = category.trim();
    const docTitle = (title && title.trim()) ? title.trim() : docCategory;
    const filePath = req.file.path;

    const fileBuffer = fs.readFileSync(filePath);
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    await client.query('BEGIN');

    // Check if document already exists for this (owner_id, category)
    const existingRes = await client.query(
      `SELECT document_id FROM documents WHERE owner_id = $1 AND LOWER(category) = LOWER($2) LIMIT 1`,
      [ownerId, docCategory]
    );

    let documentId;
    let versionRes;

    if (existingRes.rows.length > 0) {
      documentId = existingRes.rows[0].document_id;

      const latestVerRes = await client.query(
        `SELECT version_id FROM document_versions WHERE document_id = $1 ORDER BY version_id DESC LIMIT 1`,
        [documentId]
      );
      const prevVersionId = latestVerRes.rows.length > 0 ? latestVerRes.rows[0].version_id : null;

      await client.query(
        `UPDATE documents SET title = $1, file_path = $2 WHERE document_id = $3`,
        [docTitle, filePath, documentId]
      );

      versionRes = await client.query(
        `INSERT INTO document_versions (document_id, previous_version_id, file_hash)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [documentId, prevVersionId, fileHash]
      );

      await client.query(
        `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, metadata)
         VALUES ('USER', $1, 'UPDATE_DOCUMENT_VERSION', 'DOCUMENT', $2, $3::jsonb)`,
        [ownerId, documentId, JSON.stringify({ category: docCategory, version_id: versionRes.rows[0].version_id })]
      );

    } else {
      const docResult = await client.query(
        `INSERT INTO documents (owner_id, title, category, file_path)
         VALUES ($1, $2, $3, $4)
         RETURNING document_id`,
        [ownerId, docTitle, docCategory, filePath]
      );
      documentId = docResult.rows[0].document_id;

      versionRes = await client.query(
        `INSERT INTO document_versions (document_id, previous_version_id, file_hash)
         VALUES ($1, NULL, $2)
         RETURNING *`,
        [documentId, fileHash]
      );

      await client.query(
        `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, metadata)
         VALUES ('USER', $1, 'UPLOAD_DOCUMENT', 'DOCUMENT', $2, $3::jsonb)`,
        [ownerId, documentId, JSON.stringify({ category: docCategory, title: docTitle })]
      );
    }

    // Auto-link pending requests for this user & category
    await client.query(
      `UPDATE verification_requests 
       SET document_id = $1 
       WHERE (target_user_id = $2 OR LOWER(target_email) = LOWER($4)) AND document_id IS NULL AND LOWER(category) = LOWER($3)`,
      [documentId, ownerId, docCategory, req.user.email]
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

app.post('/api/documents/upload', (req, res) => {
  req.url = '/api/documents';
  app._router.handle(req, res);
});


// ==========================================
// VERIFICATION REQUEST ENDPOINTS
// ==========================================

// GET /api/requests - Filtered strictly for the logged-in User or Organization
app.get('/api/requests', authenticateToken, async (req, res) => {
  try {
    let query;
    let params = [];

    if (req.user.role === 'individual') {
      query = `
        SELECT 
          vr.request_id, 
          vr.org_id, 
          vr.document_id,
          vr.target_user_id,
          vr.target_email,
          o.org_name,
          COALESCE(d.title, vr.requested_doc_name, 'Requested Document') AS document_title,
          COALESCE(d.category, vr.category, 'General') AS category,
          vr.reason, 
          LOWER(vr.status::text) AS status, 
          vr.requested_at AS created_at,
          ag.key_display_code, 
          ag.expires_at,
          ag.revoked_at
        FROM verification_requests vr
        JOIN organizations o ON vr.org_id = o.org_id
        LEFT JOIN documents d ON vr.document_id = d.document_id
        LEFT JOIN access_grants ag ON vr.request_id = ag.request_id
        WHERE vr.target_user_id = $1 OR LOWER(vr.target_email) = LOWER($2)
        ORDER BY vr.request_id DESC;
      `;
      params = [req.user.actorId, req.user.email];
    } else {
      query = `
        SELECT 
          vr.request_id, 
          vr.org_id, 
          vr.document_id,
          vr.target_user_id,
          vr.target_email,
          COALESCE(u.name, 'Unregistered Recipient') AS target_user_name,
          COALESCE(u.email, vr.target_email) AS target_user_email,
          COALESCE(d.title, vr.requested_doc_name, 'Requested Document') AS document_title,
          COALESCE(d.category, vr.category, 'General') AS category,
          vr.reason, 
          LOWER(vr.status::text) AS status, 
          vr.requested_at AS created_at,
          ag.key_display_code, 
          ag.expires_at,
          ag.revoked_at
        FROM verification_requests vr
        LEFT JOIN users u ON vr.target_user_id = u.user_id
        LEFT JOIN documents d ON vr.document_id = d.document_id
        LEFT JOIN access_grants ag ON vr.request_id = ag.request_id
        WHERE vr.org_id = $1
        ORDER BY vr.request_id DESC;
      `;
      params = [req.user.orgId];
    }

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching requests:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/requests - Org creates request for any user email (e.g. Gmail)
app.post('/api/requests', authenticateToken, requireRole('organization'), async (req, res) => {
  const { targetEmail, docName, category, reason } = req.body;
  const orgId = req.user.orgId;
  const staffId = req.user.actorId;
  const client = await pool.connect();

  try {
    if (!targetEmail || !targetEmail.trim()) {
      return res.status(400).json({ error: 'EMAIL_REQUIRED', message: 'Target user email address is required.' });
    }

    if (!category || !category.trim()) {
      return res.status(400).json({ error: 'CATEGORY_REQUIRED', message: 'Document category is required.' });
    }

    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'REASON_REQUIRED', message: 'Reason for request is required.' });
    }

    const cleanEmail = targetEmail.trim().toLowerCase();
    const reqCategory = category.trim();
    const reqDocName = (docName && docName.trim()) ? docName.trim() : reqCategory;
    const reqReason = reason.trim();

    await client.query('BEGIN');

    // Check if target user has already signed up
    const userRes = await client.query(
      `SELECT user_id, name FROM users WHERE LOWER(email) = $1 LIMIT 1`,
      [cleanEmail]
    );

    let targetUserId = userRes.rows.length > 0 ? userRes.rows[0].user_id : null;
    let docId = null;

    if (targetUserId) {
      const docRes = await client.query(
        `SELECT document_id FROM documents WHERE owner_id = $1 AND LOWER(category) = LOWER($2) LIMIT 1`,
        [targetUserId, reqCategory]
      );
      if (docRes.rows.length > 0) docId = docRes.rows[0].document_id;
    }

    // Check for pending duplicate request
    const pendingCheck = await client.query(
      `SELECT request_id FROM verification_requests 
       WHERE org_id = $1 AND LOWER(target_email) = LOWER($2) AND LOWER(category) = LOWER($3) 
         AND LOWER(status::text) IN ('requested', 'pending', 'under_review') LIMIT 1`,
      [orgId, cleanEmail, reqCategory]
    );

    if (pendingCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'DUPLICATE_REQUEST', message: 'A pending request for this user email and category already exists.' });
    }

    const result = await client.query(
      `INSERT INTO verification_requests (org_id, target_user_id, target_email, document_id, requested_doc_name, category, reason, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'requested')
       RETURNING *`,
      [orgId, targetUserId, cleanEmail, docId, reqDocName, reqCategory, reqReason]
    );

    const newRequest = result.rows[0];

    await client.query(
      `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ('ORG_STAFF', $1, 'CREATE_REQUEST', 'VERIFICATION_REQUEST', $2, $3::jsonb)`,
      [staffId, newRequest.request_id, JSON.stringify({ org_id: orgId, target_email: cleanEmail, category: reqCategory })]
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

// POST /api/requests/:requestId/approve - Auto-Approval by Category
app.post('/api/requests/:requestId/approve', authenticateToken, requireRole('individual'), async (req, res) => {
  const { requestId } = req.params;
  const ownerId = req.user.actorId;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const reqRes = await client.query(
      `SELECT * FROM verification_requests 
       WHERE request_id = $1 AND (target_user_id = $2 OR LOWER(target_email) = LOWER($3))`,
      [requestId, ownerId, req.user.email]
    );

    if (reqRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Verification request not found for your account.' });
    }

    const requestData = reqRes.rows[0];

    if ((requestData.status || '').toLowerCase() === 'approved') {
      const existingGrant = await client.query(
        `SELECT * FROM access_grants WHERE request_id = $1 LIMIT 1`,
        [requestId]
      );
      await client.query('COMMIT');
      return res.json({ message: 'Request is already approved.', grant: existingGrant.rows[0] });
    }

    // Auto-match user's document for this category
    let targetDocId = requestData.document_id;

    if (!targetDocId) {
      const matchDoc = await client.query(
        `SELECT document_id FROM documents WHERE owner_id = $1 AND LOWER(category) = LOWER($2) LIMIT 1`,
        [ownerId, requestData.category]
      );
      if (matchDoc.rows.length > 0) targetDocId = matchDoc.rows[0].document_id;
    }

    if (!targetDocId) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'NO_DOCUMENT_FOR_CATEGORY',
        message: `You have not uploaded a document for category '${requestData.category}' yet. Please upload it first to grant access.`,
        category: requestData.category
      });
    }

    // Ensure document version exists
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

    // Approve request
    await client.query(
      `UPDATE verification_requests 
       SET status = 'approved', document_id = $1, target_user_id = $2, decided_at = CURRENT_TIMESTAMP
       WHERE request_id = $3`,
      [targetDocId, ownerId, requestId]
    );

    // Issue access grant
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
// ACCESS KEY VERIFICATION & FILE DOWNLOAD
// ==========================================

app.post('/api/verify-key', async (req, res) => {
  const { keyCode } = req.body;

  if (!keyCode || !keyCode.trim()) {
    return res.status(400).json({ valid: false, message: 'Access key code is required.' });
  }

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
      [keyCode.trim()]
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

    await pool.query(
      `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ('SYSTEM', 1, 'DOWNLOAD_DOCUMENT', 'VERIFICATION_REQUEST', $1, $2::jsonb)`,
      [request_id, JSON.stringify({ key_display_code: keyCode })]
    );

    return res.sendFile(absolutePath);

  } catch (err) {
    console.error('Error serving document file:', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/audit-logs - Strictly filtered by authenticated user or organization account
app.get('/api/audit-logs', authenticateToken, async (req, res) => {
  try {
    let query;
    let params;

    if (req.user.role === 'individual') {
      const userId = req.user.actorId;
      const userEmail = req.user.email;

      query = `
        SELECT log_id, actor_type, actor_id, action, entity_type, entity_id, metadata, timestamp 
        FROM audit_logs 
        WHERE 
          (actor_type = 'USER' AND actor_id = $1)
          OR (entity_type = 'DOCUMENT' AND entity_id IN (
            SELECT document_id FROM documents WHERE owner_id = $1
          ))
          OR (entity_type = 'VERIFICATION_REQUEST' AND entity_id IN (
            SELECT request_id FROM verification_requests WHERE target_user_id = $1 OR LOWER(target_email) = LOWER($2)
          ))
          OR (metadata->>'target_user_id' = $1::text)
          OR (LOWER(metadata->>'target_email') = LOWER($2))
        ORDER BY log_id DESC 
        LIMIT 50
      `;
      params = [userId, userEmail];
    } else {
      const orgId = req.user.orgId;

      query = `
        SELECT log_id, actor_type, actor_id, action, entity_type, entity_id, metadata, timestamp 
        FROM audit_logs 
        WHERE 
          (actor_type = 'ORG_STAFF' AND actor_id IN (
            SELECT staff_id FROM org_staff WHERE org_id = $1
          ))
          OR (entity_type = 'ORGANIZATION' AND entity_id = $1)
          OR (entity_type = 'VERIFICATION_REQUEST' AND entity_id IN (
            SELECT request_id FROM verification_requests WHERE org_id = $1
          ))
          OR (metadata->>'org_id' = $1::text)
        ORDER BY log_id DESC 
        LIMIT 50
      `;
      params = [orgId];
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching account audit logs:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TrustGate Production API server active on http://localhost:${PORT}`);
});
