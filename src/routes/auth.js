const express = require('express');
const router = express.Router();
const db = require('../config/db');

// User Login / Details
router.get('/user/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'SELECT user_id, name, email, created_at FROM users WHERE user_id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Organization Verifier Login / Details
router.get('/staff/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT s.staff_id, s.name, s.email, s.role, o.org_id, o.org_name, o.org_type 
       FROM org_staff s 
       JOIN organizations o ON s.org_id = o.org_id 
       WHERE s.staff_id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
