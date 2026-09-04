-- Set DEFAULT of schedule_slots.source to 'api' so un-stamped new slots
-- default to API-owned (protected from document overwrites).
-- `import-core.ts` explicitly specifies 'document' for document-projected slots.

ALTER TABLE schedule_slots ALTER COLUMN source SET DEFAULT 'api';
