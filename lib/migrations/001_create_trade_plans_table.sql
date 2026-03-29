-- Create trade_plans table for storing daily trading plans
CREATE TABLE IF NOT EXISTS trade_plans (
  id SERIAL PRIMARY KEY,
  collection VARCHAR(50) NOT NULL,
  config JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_trade_plans_collection ON trade_plans(collection);
