-- WI-6554700010009205: reuse the append-only organization audit relation.
-- Directory administration and its audit commit in one hosted_service
-- transaction. No read, update, delete, or customer role authority is added.
GRANT INSERT ON papercusp_auth.organization_audit_events TO hosted_service;
