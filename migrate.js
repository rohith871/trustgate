const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'trustgate_db',
});

async function runMigration() {
  const client = await pool.connect();
  try {
    console.log('Starting DB migration...');
    await client.query('BEGIN');

    // 1. Disable version mutation trigger temporarily for migration
    await client.query(`ALTER TABLE document_versions DISABLE TRIGGER trg_prevent_version_mutation;`);

    // 2. Ensure required columns exist on verification_requests
    await client.query(`
      ALTER TABLE verification_requests 
      ADD COLUMN IF NOT EXISTS requested_doc_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS category VARCHAR(100);
    `);

    // 3. Make document_id in verification_requests nullable
    await client.query(`
      ALTER TABLE verification_requests 
      ALTER COLUMN document_id DROP NOT NULL;
    `);

    // 4. Drop legacy index/constraint if present
    await client.query(`
      DROP INDEX IF EXISTS uq_active_document_request;
      ALTER TABLE verification_requests 
      DROP CONSTRAINT IF EXISTS uq_active_document_request;
    `);

    // 5. Ensure file_path column exists on documents
    await client.query(`
      ALTER TABLE documents 
      ADD COLUMN IF NOT EXISTS file_path VARCHAR(512);
    `);

    // 6. Normalize category names
    await client.query(`UPDATE documents SET category = 'Degree / Marksheet' WHERE category IN ('Degree', 'Degree / Marksheet');`);
    await client.query(`UPDATE documents SET category = 'KYC Document' WHERE category IN ('KYC', 'KYC Document');`);
    await client.query(`UPDATE documents SET category = 'Medical Record' WHERE category IN ('Medical record', 'Medical Record');`);
    await client.query(`UPDATE verification_requests SET category = 'Degree / Marksheet' WHERE category IN ('Degree', 'Degree / Marksheet');`);
    await client.query(`UPDATE verification_requests SET category = 'KYC Document' WHERE category IN ('KYC', 'KYC Document');`);
    await client.query(`UPDATE verification_requests SET category = 'Medical Record' WHERE category IN ('Medical record', 'Medical Record');`);

    // 7. Consolidate duplicate documents per (owner_id, category)
    const dupes = await client.query(`
      SELECT owner_id, category, COUNT(*) 
      FROM documents 
      GROUP BY owner_id, category 
      HAVING COUNT(*) > 1
    `);

    if (dupes.rows.length > 0) {
      console.log('Consolidating duplicate categories into single document version chains...');
      for (const dupe of dupes.rows) {
        const docs = await client.query(`
          SELECT document_id, title, file_path FROM documents 
          WHERE owner_id = $1 AND category = $2 
          ORDER BY document_id ASC
        `, [dupe.owner_id, dupe.category]);

        const primaryDocId = docs.rows[0].document_id;
        const latestDoc = docs.rows[docs.rows.length - 1];
        const duplicateIds = docs.rows.slice(1).map(r => r.document_id);

        console.log(`Primary Doc ID for category '${dupe.category}': ${primaryDocId}. Merging IDs:`, duplicateIds);

        // Update primary document metadata to latest title and file_path
        if (latestDoc.file_path || latestDoc.title) {
          await client.query(`
            UPDATE documents 
            SET title = $1, file_path = COALESCE($2, file_path) 
            WHERE document_id = $3
          `, [latestDoc.title, latestDoc.file_path, primaryDocId]);
        }

        // Point all versions from duplicates to primaryDocId
        await client.query(`
          UPDATE document_versions 
          SET document_id = ${primaryDocId} 
          WHERE document_id = ANY(ARRAY[${duplicateIds.join(',')}]::bigint[])
        `);

        // Point all verification requests from duplicates to primaryDocId
        await client.query(`
          UPDATE verification_requests 
          SET document_id = ${primaryDocId} 
          WHERE document_id = ANY(ARRAY[${duplicateIds.join(',')}]::bigint[])
        `);

        // Delete duplicate document rows
        await client.query(`
          DELETE FROM documents 
          WHERE document_id = ANY(ARRAY[${duplicateIds.join(',')}]::bigint[])
        `);

        // Link versions of primaryDocId sequentially to form version chain
        const versions = await client.query(`
          SELECT version_id FROM document_versions 
          WHERE document_id = ${primaryDocId} 
          ORDER BY version_id ASC
        `);

        let prevVerId = null;
        for (const v of versions.rows) {
          if (prevVerId === null) {
            await client.query(`
              UPDATE document_versions 
              SET previous_version_id = NULL 
              WHERE version_id = ${v.version_id}
            `);
          } else {
            await client.query(`
              UPDATE document_versions 
              SET previous_version_id = ${prevVerId} 
              WHERE version_id = ${v.version_id}
            `);
          }
          prevVerId = v.version_id;
        }
      }
    }

    // 8. Re-enable version mutation trigger
    await client.query(`ALTER TABLE document_versions ENABLE TRIGGER trg_prevent_version_mutation;`);

    // 9. Add unique constraint uq_user_category on documents(owner_id, category)
    await client.query(`
      ALTER TABLE documents 
      DROP CONSTRAINT IF EXISTS uq_user_category;
      
      ALTER TABLE documents 
      ADD CONSTRAINT uq_user_category UNIQUE (owner_id, category);
    `);

    await client.query('COMMIT');
    console.log('✓ Migration executed successfully!');

    // Output current state
    const docsRes = await client.query('SELECT document_id, owner_id, category, title, file_path FROM documents ORDER BY document_id');
    console.log('\n--- Documents (1 per Category per User) ---');
    console.table(docsRes.rows);

  } catch (err) {
    await client.query('ROLLBACK');
    try { await pool.query(`ALTER TABLE document_versions ENABLE TRIGGER trg_prevent_version_mutation;`); } catch (_) {}
    console.error('Migration failed:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
