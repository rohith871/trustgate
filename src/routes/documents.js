const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../config/db');

// Get all documents for a specific user with their latest version hash
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const query = `
      SELECT 
        d.document_id,
        d.category,
        d.title,
        d.created_at,
        dv.version_id,
        dv.file_hash,
        dv.uploaded_at
      FROM documents d
      JOIN document_versions dv ON d.document_id = dv.document_id
      WHERE d.owner_id = $1
      AND dv.version_id = (
        SELECT MAX(version_id) 
        FROM document_versions 
        WHERE document_id = d.document_id
      )
      ORDER BY d.created_at DESC;
    `;
    const result = await db.query(query, [userId]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add a new document and create its initial version
router.post('/upload', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { userId, category, title, fileContent } = req.body;

    if (!userId || !category || !title) {
      return res.status(400).json({ error: 'Missing required fields: userId, category, title' });
    }

    // Generate SHA-256 hash from file content or random byte sequence if none provided
    const fileHash = crypto
      .createHash('sha256')
      .update(fileContent || `${title}-${Date.now()}-${Math.random()}`)
      .digest('hex');

    await client.query('BEGIN');

    // 1. Insert document metadata
    const docResult = await client.query(
      'INSERT INTO documents (owner_id, category, title) VALUES ($1, $2, $3) RETURNING document_id',
      [userId, category, title]
    );
    const documentId = docResult.rows[0].document_id;

    // 2. Insert initial version
    const versionResult = await client.query(
      'INSERT INTO document_versions (document_id, previous_version_id, file_hash) VALUES ($1, NULL, $2) RETURNING version_id, file_hash, uploaded_at',
      [documentId, fileHash]
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Document uploaded successfully',
      documentId,
      version: versionResult.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
