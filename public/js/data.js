/* ============================================================
   TrustGate — In-Memory / Local Storage Database Mock
   ============================================================ */

window.DB = {
  _orgVerified: false,
  
  _myDocs: [
    {
      id: 1,
      name: "Degree Certificate",
      category: "Degree / Marksheet",
      hash: "0x8f3a...91e2",
      versions: [
        { v: "v1.0", hash: "0x8f3a...91e2", who: "Rohan Krishnan", when: "2 days ago", current: true }
      ]
    }
  ],

  _requests: [
    {
      id: 101,
      doc: "Degree Certificate",
      org: "City General Hospital",
      reason: "Employment Verification",
      sentAt: "Yesterday",
      status: "pending",
      key: "TG-8821-9940",
      exp: "24 hours"
    }
  ],

  init: async function() {
    const savedVerified = localStorage.getItem('tg_org_verified');
    if (savedVerified !== null) {
      this._orgVerified = JSON.parse(savedVerified);
    }
  },

  isOrgVerified: function() {
    return this._orgVerified;
  },

  setOrgVerified: function(val) {
    this._orgVerified = !!val;
    localStorage.setItem('tg_org_verified', JSON.stringify(this._orgVerified));
  },

  getMyDocuments: function() {
    return this._myDocs;
  },

  addDocument: function(title, category, fileName) {
    const newDoc = {
      id: Date.now(),
      name: title,
      category: category,
      hash: '0x' + Math.random().toString(16).substring(2, 10),
      versions: [
        {
          v: 'v1.0',
          hash: '0x' + Math.random().toString(16).substring(2, 10),
          who: 'Rohan Krishnan',
          when: 'Just now',
          current: true
        }
      ]
    };
    this._myDocs.push(newDoc);
    return newDoc;
  },

  getRequests: function() {
    return this._requests;
  },

  approveRequest: function(id) {
    const r = this._requests.find(item => item.id === id);
    if (r) r.status = 'approved';
    return r;
  },

  declineRequest: function(id) {
    const r = this._requests.find(item => item.id === id);
    if (r) r.status = 'declined';
    return r;
  },

  revokeRequest: function(id) {
    const r = this._requests.find(item => item.id === id);
    if (r) r.status = 'revoked';
    return r;
  },

  sendNewRequest: function(doc, category, reason) {
    const newReq = {
      id: Date.now(),
      doc: doc,
      org: 'City General Hospital',
      reason: reason,
      sentAt: 'Just now',
      status: 'pending',
      key: 'TG-' + Math.floor(1000 + Math.random() * 9000) + '-0000',
      exp: '24 hours'
    };
    this._requests.push(newReq);
    return newReq;
  },

  getMeta: function() {
    return { userName: 'Rohan Krishnan' };
  },

  getAuditIndividual: function() { return []; },
  getAuditOrg: function() { return []; }
};
