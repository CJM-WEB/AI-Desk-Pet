BEGIN;

/**
 * 点赞 endpoint 与首次限流、状态校验和幂等回放共用同一事务接缝。
 * 已存在的四参数 operation 可按投稿不可变 kind 推导原 endpoint，不扩张账本字段。
 */
CREATE FUNCTION set_public_like(
  p_submission_id text,
  p_fingerprint_hash char(64),
  p_desired_liked boolean,
  p_operation_id uuid,
  p_endpoint_kind text
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
  v_endpoint_matches boolean;
  v_changed integer;
  v_like_count bigint;
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
    OR p_desired_liked IS NULL
    OR p_operation_id IS NULL
    OR p_endpoint_kind IS NULL
    OR p_endpoint_kind NOT IN ('community', 'feedback') THEN
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
      SELECT kind INTO v_kind
      FROM submissions
      WHERE id = v_operation.submission_id;
      v_endpoint_matches := (
        p_endpoint_kind = 'community' AND v_kind = 'shared_package'
      ) OR (
        p_endpoint_kind = 'feedback' AND v_kind IN ('feedback', 'suggestion')
      );
      IF v_operation.action IS DISTINCT FROM 'like'
        OR v_operation.submission_id IS DISTINCT FROM p_submission_id
        OR v_operation.fingerprint_hash IS DISTINCT FROM p_fingerprint_hash
        OR v_operation.desired_liked IS DISTINCT FROM p_desired_liked
        OR v_endpoint_matches IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'idempotency operation reused with different input'
          USING ERRCODE = 'P1001';
      END IF;
      RETURN v_operation.result_snapshot;
    END IF;
  END IF;

  /** 缺失、类型错误、未发布和有效投稿的首次 operation 均先消费相同配额。 */
  v_limit := consume_abuse_limit(
    'like:' || p_submission_id,
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
  v_endpoint_matches := (
    p_endpoint_kind = 'community' AND v_kind = 'shared_package'
  ) OR (
    p_endpoint_kind = 'feedback' AND v_kind IN ('feedback', 'suggestion')
  );
  IF v_status IS DISTINCT FROM 'published'
    OR v_endpoint_matches IS DISTINCT FROM true THEN
    /** 私有失败事实使首次配额提交；Adapter 仍只公开统一 404。 */
    RETURN jsonb_build_object('not_found', true);
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

REVOKE ALL ON FUNCTION set_public_like(text, char, boolean, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_public_like(text, char, boolean, uuid, text)
  TO service_role;

/** 旧四参数入口不能绕过 endpoint 绑定与统一首次限流。 */
REVOKE ALL ON FUNCTION set_public_like(text, char, boolean, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION set_public_like(text, char, boolean, uuid);

COMMIT;
