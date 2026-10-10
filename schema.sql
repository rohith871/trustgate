-- ==============================================================================
-- TrustGate Platform — Complete PostgreSQL Database Schema
-- DBMS: PostgreSQL 14+
-- File: schema.sql
-- ==============================================================================

-- 1. Enable Cryptographic Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Enum Types
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'org_type_enum') THEN
        CREATE TYPE org_type_enum AS ENUM ('Educational institution', 'Employer', 'Hospital', 'Bank / NBFC');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'verification_status_enum') THEN
        CREATE TYPE verification_status_enum AS ENUM ('pending', 'approved', 'rejected');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'staff_role_enum') THEN
        CREATE TYPE staff_role_enum AS ENUM ('ORG_VERIFIER', 'ADMIN', 'STAFF');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'request_status_enum') THEN
        CREATE TYPE request_status_enum AS ENUM ('requested', 'under_review', 'approved', 'rejected', 'declined');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'actor_type_enum') THEN
        CREATE TYPE actor_type_enum AS ENUM ('USER', 'ORG_STAFF', 'SYSTEM', 'ADMIN');
    END IF;
END $$;

-- 3. Users Table (Individual Document Owners)
CREATE TABLE IF NOT EXISTS users (
    user_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 4. Organizations Table
CREATE TABLE IF NOT EXISTS organizations (
    org_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_name VARCHAR(255) NOT NULL,
    org_type org_type_enum NOT NULL,
    registration_number VARCHAR(100) NOT NULL UNIQUE,
    verification_status verification_status_enum DEFAULT 'approved' NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 5. Org Staff Table
CREATE TABLE IF NOT EXISTS org_staff (
    staff_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role staff_role_enum DEFAULT 'ORG_VERIFIER' NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 6. Documents Table (Enforces 1 document record per Category per User)
CREATE TABLE IF NOT EXISTS documents (
    document_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    category VARCHAR(100) NOT NULL,
    title VARCHAR(255) NOT NULL,
    file_path VARCHAR(512),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_user_category UNIQUE (owner_id, category)
);

-- 7. Document Versions Table (Immutable Version Chain)
CREATE TABLE IF NOT EXISTS document_versions (
    version_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id BIGINT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    previous_version_id BIGINT REFERENCES document_versions(version_id) ON DELETE RESTRICT,
    file_hash CHAR(64) NOT NULL,
    uploaded_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_document_versions_file_hash ON document_versions(file_hash);

-- Enforce Version Chain Integrity Trigger
CREATE OR REPLACE FUNCTION verify_version_chain()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.previous_version_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM document_versions
            WHERE version_id = NEW.previous_version_id
              AND document_id = NEW.document_id
        ) THEN
            RAISE EXCEPTION 'Previous version ID % does not belong to the same document %', NEW.previous_version_id, NEW.document_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_verify_version_chain ON document_versions;
CREATE TRIGGER trg_verify_version_chain
BEFORE INSERT ON document_versions
FOR EACH ROW EXECUTE FUNCTION verify_version_chain();

-- Immutable Document Versions Trigger
CREATE OR REPLACE FUNCTION prevent_version_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Document versions are immutable and cannot be modified or deleted.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_version_mutation ON document_versions;
CREATE TRIGGER trg_prevent_version_mutation
BEFORE UPDATE OR DELETE ON document_versions
FOR EACH ROW EXECUTE FUNCTION prevent_version_mutation();

-- 8. Verification Requests Table (Targeting specific users by ID and Email)
CREATE TABLE IF NOT EXISTS verification_requests (
    request_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    target_user_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
    target_email VARCHAR(255),
    document_id BIGINT REFERENCES documents(document_id) ON DELETE CASCADE,
    requested_doc_name VARCHAR(255),
    category VARCHAR(100) NOT NULL,
    status request_status_enum DEFAULT 'requested' NOT NULL,
    reason TEXT NOT NULL,
    requested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    decided_at TIMESTAMPTZ,
    decided_by BIGINT REFERENCES org_staff(staff_id) ON DELETE SET NULL,
    CONSTRAINT chk_request_decision_state CHECK (
        (status IN ('requested', 'under_review') AND decided_at IS NULL AND decided_by IS NULL)
        OR
        (status IN ('approved', 'rejected', 'declined') AND decided_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_verification_requests_target ON verification_requests(target_user_id);
CREATE INDEX IF NOT EXISTS idx_verification_requests_email ON verification_requests(LOWER(target_email));

-- 9. Access Grants Table
CREATE TABLE IF NOT EXISTS access_grants (
    grant_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id BIGINT NOT NULL UNIQUE REFERENCES verification_requests(request_id) ON DELETE CASCADE,
    key_hash CHAR(64) NOT NULL UNIQUE,
    key_display_code VARCHAR(20) NOT NULL UNIQUE,
    issued_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT chk_grant_expiry CHECK (expires_at > issued_at),
    CONSTRAINT chk_grant_revocation CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

-- 10. Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
    log_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_type actor_type_enum NOT NULL,
    actor_id BIGINT NOT NULL,
    action VARCHAR(255) NOT NULL,
    entity_type VARCHAR(100) NOT NULL,
    entity_id BIGINT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Immutable Audit Logs Trigger
CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit logs are strictly append-only.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_audit_mutation ON audit_logs;
CREATE TRIGGER trg_prevent_audit_mutation
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
