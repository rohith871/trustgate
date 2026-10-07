async function testUpload() {
  try {
    console.log('--- Testing Document Versioning (Uploading new file for KYC Document) ---');
    const formData = new FormData();
    formData.append('title', 'Updated PAN Card 2026');
    formData.append('category', 'KYC Document');
    
    // Create a dummy blob file
    const blob = new Blob(['Sample PAN Card File Content 2026'], { type: 'text/plain' });
    formData.append('file', blob, 'pancard_new.txt');

    const uploadRes = await fetch('http://localhost:3000/api/documents/upload', {
      method: 'POST',
      body: formData
    });
    const uploadData = await uploadRes.json();
    console.log('Upload Result:', uploadData);

    console.log('\n--- Checking Documents List after Upload ---');
    const docsRes = await fetch('http://localhost:3000/api/documents');
    const docs = await docsRes.json();
    console.table(docs.map(d => ({ id: d.document_id, category: d.category, title: d.title, version_count: d.version_count, latest_hash: d.file_hash.substring(0, 16) })));

  } catch (err) {
    console.error('Upload test error:', err);
  }
}

testUpload();
