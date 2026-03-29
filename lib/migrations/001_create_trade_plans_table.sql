-- Database migration: Create trade_plans and job_executions tables
-- Note: These tables should be created using the SQL provided in your database setup

-- The following tables are required for the dockerized app:

-- 1. trade_plans - Stores scheduled trading strategies (from /api/plan endpoint)
-- CREATE TABLE IF NOT EXISTS public.trade_plans (...)
-- See schema definition for complete table structure

-- 2. job_executions - Stores running trades and job execution history
-- CREATE TABLE IF NOT EXISTS public.job_executions (...)
-- See schema definition for complete table structure

-- 3. accesstoken - Stores user access tokens for Kite integration
-- CREATE TABLE IF NOT EXISTS public.accesstoken (...)
-- See schema definition for complete table structure

-- These tables should be pre-created in your PostgreSQL database
-- Run the full schema SQL from the schema definition before starting the app
