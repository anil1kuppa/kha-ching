CREATE OR REPLACE FUNCTION cleanup_old_records()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM accesstoken WHERE created_at::date < current_date;
  DELETE FROM ema WHERE created_at::date < current_date - 5;
  DELETE FROM job_executions WHERE created_at::date < current_date - 5;
END;
$$;
