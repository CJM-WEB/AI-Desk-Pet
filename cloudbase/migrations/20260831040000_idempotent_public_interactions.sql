BEGIN;

/** 单一互动账本保存最小请求哈希事实和首次结果，不保存原始设备身份。 */
CREATE TABLE public_interaction_operations (
  operation_id uuid PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('like', 'download')),
  submission_id text NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  fingerprint_hash char(64) NOT NULL,
  desired_liked boolean,
  result_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (
    (action = 'like' AND desired_liked IS NOT NULL)
    OR (action = 'download' AND desired_liked IS NULL)
  )
);

CREATE INDEX public_interaction_operations_expiry_idx
  ON public_interaction_operations (expires_at, operation_id);

/**
 * 明确目标状态替代 toggle；同 operation 由事务级 advisory lock 串行，
 * 投稿汇总行则串行不同 operation 的投票变更。
 */
CREATE FUNCTION set_public_like(
  p_submission_id text,
  p_fingerprint_hash char(64),
  p_desired_liked boolean,
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
  v_changed integer;
  v_like_count bigint;
  v_result jsonb;
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
    OR p_desired_liked IS NULL
    OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'invalid public like input' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_operation_id::text, 0));
  SELECT * INTO v_operation
  FROM public_interaction_operations
  WHERE operation_id = p_operation_id
  FOR UPDATE;
  IF FOUND THEN
    /** TTL 是逻辑失效边界；cleanup 积压不能延长 operation 的有效期。 */
    IF v_operation.expires_at <= v_now THEN
      DELETE FROM public_interaction_operations
      WHERE operation_id = p_operation_id;
    ELSE
      IF v_operation.action IS DISTINCT FROM 'like'
        OR v_operation.submission_id IS DISTINCT FROM p_submission_id
        OR v_operation.fingerprint_hash IS DISTINCT FROM p_fingerprint_hash
        OR v_operation.desired_liked IS DISTINCT FROM p_desired_liked THEN
        RAISE EXCEPTION 'idempotency operation reused with different input'
          USING ERRCODE = 'P1001';
      END IF;
      RETURN v_operation.result_snapshot;
    END IF;
  END IF;

  SELECT status, kind INTO v_status, v_kind
  FROM submissions
  WHERE id = p_submission_id
  FOR SHARE;
  IF v_status IS DISTINCT FROM 'published'
    OR v_kind NOT IN ('shared_package', 'feedback', 'suggestion') THEN
    RAISE EXCEPTION 'published submission not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public_engagement (submission_id)
  VALUES (p_submission_id)
  ON CONFLICT (submission_id) DO NOTHING;
  PERFORM 1 FROM public_engagement
  WHERE submission_id = p_submission_id
  FOR UPDATE;

  IF p_desired_liked THEN
    INSERT INTO engagement_votes (submission_id, fingerprint_hash)
    VALUES (p_submission_id, p_fingerprint_hash)
    ON CONFLICT (submission_id, fingerprint_hash) DO NOTHING;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    IF v_changed = 1 THEN
      UPDATE public_engagement
      SET like_count = like_count + 1,
          updated_at = v_now
      WHERE submission_id = p_submission_id;
    END IF;
  ELSE
    DELETE FROM engagement_votes
    WHERE submission_id = p_submission_id
      AND fingerprint_hash = p_fingerprint_hash;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    IF v_changed = 1 THEN
      UPDATE public_engagement
      SET like_count = GREATEST(0, like_count - 1),
          updated_at = v_now
      WHERE submission_id = p_submission_id;
    END IF;
  END IF;

  SELECT like_count INTO v_like_count
  FROM public_engagement
  WHERE submission_id = p_submission_id;
  v_result := jsonb_build_object(
    'liked', p_desired_liked,
    'like_count', v_like_count
  );
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
    'like',
    p_submission_id,
    p_fingerprint_hash,
    p_desired_liked,
    v_result,
    v_now,
    v_now + interval '24 hours'
  );
  RETURN v_result;
END;
$$;

/** 每轮只领取至多 500 条到期账本；数据库失败交由调用方显式处理。 */
CREATE FUNCTION purge_expired_public_interaction_operations(
  p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'invalid interaction cleanup limit' USING ERRCODE = '22023';
  END IF;

  WITH expired AS (
    SELECT operation_id
    FROM public_interaction_operations
    WHERE expires_at <= now()
    ORDER BY expires_at, operation_id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM public_interaction_operations AS operation
    USING expired
    WHERE operation.operation_id = expired.operation_id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_deleted FROM deleted;
  RETURN v_deleted;
END;
$$;

ALTER TABLE public_interaction_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_interaction_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public_interaction_operations
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public_interaction_operations TO service_role;

REVOKE ALL ON FUNCTION set_public_like(text, char, boolean, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purge_expired_public_interaction_operations(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_public_like(text, char, boolean, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION purge_expired_public_interaction_operations(integer)
  TO service_role;

REVOKE ALL ON FUNCTION toggle_public_like(text, char)
  FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION toggle_public_like(text, char);

COMMIT;
