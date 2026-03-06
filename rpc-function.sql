-- Safety function for read-only SQL execution
-- Run this in your Postgres database before using the agent

CREATE OR REPLACE FUNCTION execute_readonly_sql(query text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '5s'
AS $$
DECLARE
  result jsonb;
  normalized_query text;
BEGIN
  -- Normalize query for safety checks
  normalized_query := lower(trim(query));

  -- Block write operations
  IF normalized_query ~ '^\s*(insert|update|delete|drop|truncate|alter|create|grant|revoke)' THEN
    RAISE EXCEPTION 'Write operations are not allowed';
  END IF;

  -- Block dangerous patterns
  IF normalized_query ~ '(;.*select|into\s+outfile|load_file|pg_sleep|dblink)' THEN
    RAISE EXCEPTION 'Potentially dangerous pattern detected';
  END IF;

  -- Execute with row limit
  EXECUTE format('SELECT jsonb_agg(row_to_json(t)) FROM (%s LIMIT 1000) t', query)
  INTO result;

  RETURN COALESCE(result, '[]'::jsonb);
END;
$$;

-- Restrict access: adjust the role name to match your database user
-- REVOKE ALL ON FUNCTION execute_readonly_sql(text) FROM PUBLIC;
-- GRANT EXECUTE ON FUNCTION execute_readonly_sql(text) TO your_app_role;
