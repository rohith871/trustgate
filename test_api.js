async function testApi() {
  try {
    console.log('--- Testing GET /api/documents ---');
    const docsRes = await fetch('http://localhost:3000/api/documents');
    const docs = await docsRes.json();
    console.log('Docs count:', docs.length);
    console.table(docs.map(d => ({ id: d.document_id, category: d.category, title: d.title, version_count: d.version_count })));

    console.log('\n--- Testing POST /api/requests (Requesting KYC Document) ---');
    const reqRes = await fetch('http://localhost:3000/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId: 1,
        category: 'KYC Document',
        docName: 'PAN Card Request',
        reason: 'Loan background verification'
      })
    });
    const reqData = await reqRes.json();
    console.log('Request creation response:', reqData);

    const requestId = reqData.request_id;

    if (requestId) {
      console.log(`\n--- Testing POST /api/requests/${requestId}/approve (Auto-Approve KYC Document) ---`);
      const approveRes = await fetch(`http://localhost:3000/api/requests/${requestId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const approveData = await approveRes.json();
      console.log('Auto-Approval result:', approveData);

      if (approveData.grant && approveData.grant.key_display_code) {
        console.log(`\n--- Testing POST /api/verify-key (${approveData.grant.key_display_code}) ---`);
        const verifyRes = await fetch('http://localhost:3000/api/verify-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyCode: approveData.grant.key_display_code })
        });
        const verifyData = await verifyRes.json();
        console.log('Key Verification Result:', verifyData);
      }
    }

  } catch (err) {
    console.error('Test error:', err);
  }
}

testApi();
