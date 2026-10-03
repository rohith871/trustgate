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
        d.title AS document_title,
        d.category AS document_category,
        ag.key_display_code,
        ag.expires_at
      FROM verification_requests vr
      JOIN organizations o ON vr.org_id = o.org_id
      JOIN documents d ON vr.document_id = d.document_id
      LEFT JOIN access_grants ag ON vr.request_id = ag.request_id
      WHERE d.owner_id = $1
      ORDER BY vr.requested_at DESC;
    `;
    const result = await db.query(query, [userId]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approve a verification request using the safe database transaction function
router.post('/:requestId/approve', async (req, res) => {
  try {
    const { requestId } = req.params;
    const { staffId } = req.body;

    // Call PostgreSQL stored procedure
    const result = await db.query(
      'SELECT * FROM approve_verification_request($1, $2)',
      [requestId, staffId || 1]
    );

    res.json({
      message: 'Request approved successfully',
      grant: result.rows[0],
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
