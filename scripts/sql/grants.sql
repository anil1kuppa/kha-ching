-- Run once as a superuser/database owner before first deploy.
-- Replace <your_db_user> with the user from DATABASE_URL.

GRANT CREATE ON DATABASE trading TO <your_db_user>;

-- Or alternatively, pre-create the drizzle migrations schema:
-- CREATE SCHEMA IF NOT EXISTS drizzle;
-- GRANT ALL ON SCHEMA drizzle TO <your_db_user>;
