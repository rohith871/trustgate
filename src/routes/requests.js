const express = require('express');
const router = express.Router();
const db = require('../config/db');

// Get all incoming requests for a user
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const query = `
      SELECT 
        vr.request_id,
        vr.status,
        vr.reason,
        vr.requested_at,
        vr.decided_at,
        o.org_name,
        o.org_type,
        COALESCE(d.title, vr.requested_doc_name, 'Requested Document') AS document_title,
        COALESCE(d.category, vr.category, 'General') AS document_category,
        ag.key_display_code,
        ag.expires_at
      FROM verification_requests vr
      JOIN organizations o ON vr.org_id = o.org_id
      LEFT JOIN documents d ON vr.document_id = d.document_id
      LEFT JOIN access_grants ag ON vr.request_id = ag.request_id
      WHERE d.owner_id = $1 OR vr.document_id IS NULL
      ORDER BY vr.requested_at DESC;
    `;
    const result = await db.query(query, [userId]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approve a verification request automatically by matching document category
router.post('/:requestId/approve', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { requestId } = req.params;
    const ownerId = 1;

    await client.query('BEGIN');

    const reqRes = await client.query(
      `SELECT * FROM verification_requests WHERE request_id = $1`,
      [requestId]
    );

    if (reqRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Request not found.' });
    }

    const requestData = reqRes.rows[0];
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

    if (!targetDocId) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'NO_DOCUMENT_FOR_CATEGORY',
        message: `No document uploaded for '${requestData.category}' yet.`,
        category: requestData.category
      });
    }

    await client.query(
      `UPDATE verification_requests SET status = 'approved', document_id = $1, decided_at = CURRENT_TIMESTAMP WHERE request_id = $2`,
      [targetDocId, requestId]
    );

    const p1 = Math.floor(1000 + Math.random() * 9000);
    const p2 = Math.floor(1000 + Math.random() * 9000);
    const displayCode = `TG-${p1}-${p2}`;
    const keyHash = require('crypto').createHash('sha256').update(`${requestId}-${Date.now()}`).digest('hex');

    const grantRes = await client.query(
      `INSERT INTO access_grants (request_id, key_hash, key_display_code, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')
       RETURNING *`,
      [requestId, keyHash, displayCode]
    );

    await client.query('COMMIT');
    res.json({ message: 'Request approved successfully', grant: grantRes.rows[0] });

  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
