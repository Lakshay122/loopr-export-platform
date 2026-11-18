-- Source data (simulated inspection platform): extra, customer-specific fields per record,
-- e.g. {"line": "L1", "operator": "op-12", "torque_nm": 12.4}. Keys differ between customers
-- and even between records of one customer.
ALTER TABLE inspection_record ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
