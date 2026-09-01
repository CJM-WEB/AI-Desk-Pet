BEGIN;

/** 互动首次结果只能保存与动作匹配的最小 JSON object，禁止弱快照进入重放路径。 */
ALTER TABLE public_interaction_operations
  ADD CONSTRAINT public_interaction_operations_result_snapshot_shape_check
  CHECK (
    jsonb_typeof(result_snapshot) = 'object'
    AND CASE action
      WHEN 'like' THEN
        result_snapshot ? 'liked'
        AND result_snapshot ? 'like_count'
        AND result_snapshot - 'liked' - 'like_count' = '{}'::jsonb
        AND jsonb_typeof(result_snapshot -> 'liked') = 'boolean'
        AND jsonb_typeof(result_snapshot -> 'like_count') = 'number'
        AND result_snapshot ->> 'like_count' ~ '^(0|[1-9][0-9]*)$'
      WHEN 'download' THEN
        result_snapshot ? 'download_count'
        AND result_snapshot - 'download_count' = '{}'::jsonb
        AND jsonb_typeof(result_snapshot -> 'download_count') = 'number'
        AND result_snapshot ->> 'download_count' ~ '^(0|[1-9][0-9]*)$'
      ELSE false
    END
  );

/**
 * 短期地址已经成功签发后才调用本函数；有效 operation 先回放首次快照，
 * 新 operation 再原子消费配额并只增加一次成功签发次数。
 */
CREATE FUNCTION record_public_download(
  p_submission_id text,
  p_fingerprint_hash char(64),
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_operation public_interaction_operations%ROWTYPE;
  v_status text;
  v_kind text;
  v_download_count bigint;
  v_result jsonb;
  v_limit jsonb;
  v_now timestamptz := now();
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_submission_id IS NULL
    OR length(p_submission_id) < 1
    OR length(p_submission_id) > 128
    OR p_fingerprint_hash IS NULL
    OR p_fingerprint_hash !~ '^[a-f0-9]{64}$'
    OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'invalid public download input' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_operation_id::text, 0));
  SELECT * INTO v_operation
  FROM public_interaction_operations
  WHERE operation_id = p_operation_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_operation.expires_at <= v_now THEN
      DELETE FROM public_interaction_operations
      WHERE operation_id = p_operation_id;
    ELSE
      IF v_operation.action IS DISTINCT FROM 'download'
        OR v_operation.submission_id IS DISTINCT FROM p_submission_id
        OR v_operation.fingerprint_hash IS DISTINCT FROM p_fingerprint_hash
        OR v_operation.desired_liked IS NOT NULL THEN
        RAISE EXCEPTION 'idempotency operation reused with different input'
          USING ERRCODE = 'P1001';
      END IF;
      RETURN v_operation.result_snapshot;
    END IF;
  END IF;

  /** 回放不重复消费配额；缺失、类型错误与有效投稿的首次 operation 使用同一裁决。 */
  v_limit := consume_abuse_limit(
    'download:' || p_submission_id,
    p_fingerprint_hash,
    10,
    60
  );
  IF NOT (v_limit ->> 'allowed')::boolean THEN
    RETURN jsonb_build_object(
      'rate_limited', true,
      'retry_after_seconds', (v_limit ->> 'retry_after_seconds')::integer
    );
  END IF;

  SELECT status, kind INTO v_status, v_kind
  FROM submissions
  WHERE id = p_submission_id
  FOR SHARE;
  IF v_status IS DISTINCT FROM 'published'
    OR v_kind IS DISTINCT FROM 'shared_package' THEN
    /** 私有失败事实使首次配额提交；Adapter 仍只公开统一 404。 */
    RETURN jsonb_build_object('not_found', true);
  END IF;

  INSERT INTO public_engagement (submission_id, download_count)
  VALUES (p_submission_id, 1)
  ON CONFLICT (submission_id)
  DO UPDATE SET download_count = public_engagement.download_count + 1,
                updated_at = v_now
  RETURNING download_count INTO v_download_count;

  v_result := jsonb_build_object('download_count', v_download_count);
  INSERT INTO public_interaction_operations (
    operation_id,
    action,
    submission_id,
    fingerprint_hash,
    desired_liked,
    result_snapshot,
    created_at,
    expires_at
  ) VALUES (
    p_operation_id,
    'download',
    p_submission_id,
    p_fingerprint_hash,
    NULL,
    v_result,
    v_now,
    v_now + interval '24 hours'
  );
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION record_public_download(text, char, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_public_download(text, char, uuid)
  TO service_role;

/** 旧入口既无法绑定设备和 operation，也会对每次重试重复计数。 */
REVOKE ALL ON FUNCTION record_public_download(text)
  FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION record_public_download(text);

COMMIT;
