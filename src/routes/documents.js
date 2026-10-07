const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../config/db');

// Get all documents for a specific user with their latest version info
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const query = `
      SELECT 
        d.document_id,
        d.category,
        d.title,
        d.file_path,
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

// Save or update document for a category (enforces 1 document per category + version chain)
router.post('/upload', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { userId, category, title, fileContent, filePath } = req.body;

    if (!userId || !category) {
      return res.status(400).json({ error: 'Missing required fields: userId, category' });
    }

    const fileHash = crypto
      .createHash('sha256')
      .update(fileContent || `${title}-${Date.now()}-${Math.random()}`)
      .digest('hex');

    await client.query('BEGIN');

    const existingDoc = await client.query(
      `SELECT document_id FROM documents WHERE owner_id = $1 AND LOWER(category) = LOWER($2) LIMIT 1`,
      [userId, category]
    );

    let documentId;
    let versionResult;

    if (existingDoc.rows.length > 0) {
      documentId = existingDoc.rows[0].document_id;
      const latestVer = await client.query(
        `SELECT version_id FROM document_versions WHERE document_id = $1 ORDER BY version_id DESC LIMIT 1`,
        [documentId]
      );
      const prevVersionId = latestVer.rows.length > 0 ? latestVer.rows[0].version_id : null;

      await client.query(
        `UPDATE documents SET title = COALESCE($1, title), file_path = COALESCE($2, file_path) WHERE document_id = $3`,
        [title, filePath, documentId]
      );

      versionResult = await client.query(
        `INSERT INTO document_versions (document_id, previous_version_id, file_hash) VALUES ($1, $2, $3) RETURNING *`,
        [documentId, prevVersionId, fileHash]
      );
    } else {
      const docResult = await client.query(
        `INSERT INTO documents (owner_id, category, title, file_path) VALUES ($1, $2, $3, $4) RETURNING document_id`,
        [userId, category, title || category, filePath]
      );
      documentId = docResult.rows[0].document_id;

      versionResult = await client.query(
        `INSERT INTO document_versions (document_id, previous_version_id, file_hash) VALUES ($1, NULL, $2) RETURNING *`,
        [documentId, fileHash]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Document saved successfully',
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
