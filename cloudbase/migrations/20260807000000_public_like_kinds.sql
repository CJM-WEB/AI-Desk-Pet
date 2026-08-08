-- 修复已上线数据库的点赞范围：公开资源包、反馈和建议均可点赞。
CREATE OR REPLACE FUNCTION toggle_public_like(
  p_submission_id text,
  p_fingerprint_hash char(64)
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted integer;
  v_like_count bigint;
  v_status text;
  v_kind text;
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_fingerprint_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid public like input' USING ERRCODE = '22023';
  END IF;

  SELECT status, kind INTO v_status, v_kind
  FROM submissions
  WHERE id = p_submission_id;
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

  DELETE FROM engagement_votes
  WHERE submission_id = p_submission_id
    AND fingerprint_hash = p_fingerprint_hash;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_deleted = 1 THEN
    UPDATE public_engagement
    SET like_count = GREATEST(0, like_count - 1),
        updated_at = now()
    WHERE submission_id = p_submission_id
    RETURNING like_count INTO v_like_count;
    RETURN jsonb_build_object('liked', false, 'like_count', v_like_count);
  END IF;

  INSERT INTO engagement_votes (submission_id, fingerprint_hash)
  VALUES (p_submission_id, p_fingerprint_hash);
  UPDATE public_engagement
  SET like_count = like_count + 1,
      updated_at = now()
  WHERE submission_id = p_submission_id
  RETURNING like_count INTO v_like_count;
  RETURN jsonb_build_object('liked', true, 'like_count', v_like_count);
END;
$$;

REVOKE ALL ON FUNCTION toggle_public_like(text, char) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION toggle_public_like(text, char) TO service_role;
