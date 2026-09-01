BEGIN;

-- 官方安装包只保存聚合点击量，设备哈希仅用于同事务限流，不进入指标表。
CREATE TABLE official_windows_download_click_metric (
  metric_key text PRIMARY KEY,
  click_count bigint NOT NULL DEFAULT 0 CHECK (click_count >= 0)
);

ALTER TABLE official_windows_download_click_metric ENABLE ROW LEVEL SECURITY;
ALTER TABLE official_windows_download_click_metric FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE official_windows_download_click_metric FROM PUBLIC, anon, authenticated;

CREATE FUNCTION record_official_windows_download_click(
  p_fingerprint_hash char(64)
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit jsonb;
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  v_limit := consume_abuse_limit(
    'download:official-windows', p_fingerprint_hash, 10, 60
  );
  IF (v_limit ->> 'allowed') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'rate limited' USING ERRCODE = 'P1004';
  END IF;

  INSERT INTO official_windows_download_click_metric AS metric (
    metric_key, click_count
  ) VALUES ('official_windows_download_clicks', 1)
  ON CONFLICT (metric_key) DO UPDATE
  SET click_count = metric.click_count + 1;
END;
$$;

CREATE FUNCTION get_official_windows_download_click_count()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_click_count bigint;
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  SELECT click_count INTO v_click_count
  FROM official_windows_download_click_metric
  WHERE metric_key = 'official_windows_download_clicks';
  RETURN jsonb_build_object('click_count', COALESCE(v_click_count, 0));
END;
$$;

REVOKE ALL ON FUNCTION record_official_windows_download_click(char)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_official_windows_download_click(char)
  TO service_role;
REVOKE ALL ON FUNCTION get_official_windows_download_click_count()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_official_windows_download_click_count()
  TO service_role;

COMMIT;
